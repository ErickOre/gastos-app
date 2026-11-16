// Gastos — PWA local-first. Toda la lógica de interfaz vive en este archivo.
// Los datos se cargan una vez en memoria (state) y cada cambio se persiste en IndexedDB.

import * as db from './db.js';
import { buildXlsx } from './xlsx.js';

const APP_VERSION = '1.0.0';
const BACKUP_FORMAT = 'gastos-app-backup';
const SCHEMA_VERSION = 1;
const PAGE_SIZE = 100;

const DEFAULT_CONFIG = {
  categories: [
    { name: 'Alimentación', subs: ['Supermercado', 'Restaurantes', 'Delivery', 'Cafetería'] },
    { name: 'Transporte', subs: ['Combustible', 'Taxi', 'Transporte público', 'Peaje y estacionamiento'] },
    { name: 'Vivienda', subs: ['Alquiler', 'Mantenimiento', 'Hogar'] },
    { name: 'Servicios', subs: ['Luz', 'Agua', 'Internet', 'Telefonía', 'Suscripciones'] },
    { name: 'Salud', subs: ['Farmacia', 'Consultas'] },
    { name: 'Educación', subs: [] },
    { name: 'Entretenimiento', subs: [] },
    { name: 'Ropa y calzado', subs: [] },
    { name: 'Otros', subs: [] },
  ],
  units: ['unidad', 'kg', 'g', 'litro', 'galón', 'paquete', 'servicio'],
  paymentMethods: [
    { name: 'Efectivo', usesAccount: false },
    { name: 'Tarjeta de crédito', usesAccount: true },
    { name: 'Tarjeta de débito', usesAccount: true },
    { name: 'Yape', usesAccount: false },
    { name: 'Plin', usesAccount: false },
    { name: 'Transferencia', usesAccount: true },
  ],
  accounts: ['Visa BCP', 'Mastercard Interbank'],
  merchants: [],
  currencies: ['PEN', 'USD'],
};

const state = {
  config: structuredClone(DEFAULT_CONFIG),
  expenses: [],
  lastBackupAt: null,
  editingId: null,
  view: 'nuevo',
  filters: { q: '', from: '', to: '', category: '', method: '', account: '', merchant: '' },
  histLimit: PAGE_SIZE,
  month: '',
  openSections: new Set(),
};

// ---------- utilidades ----------

const $ = (sel, root = document) => root.querySelector(sel);
const pad = (n) => String(n).padStart(2, '0');
const nameOf = (item) => (typeof item === 'string' ? item : item.name);
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const clean = (s, max = 120) => String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const toCents = (n) => Math.round(Number(n) * 100);

function today() {
  // Fecha local (no UTC): a las 8 p. m. en Lima, toISOString() ya devolvería el día siguiente.
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Crea un elemento DOM. Se usa en lugar de innerHTML para no interpretar como HTML texto del usuario.
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Acepta "12.5", "12,5" y "1.234,50" (el teclado decimal de iOS usa coma o punto según la región).
function parseNumber(text) {
  let s = String(text ?? '').replace(/\s/g, '');
  const comma = s.lastIndexOf(',');
  const dot = s.lastIndexOf('.');
  if (comma > -1 && dot > -1) {
    const dec = comma > dot ? ',' : '.';
    s = s.split(dec === ',' ? '.' : ',').join('').replace(dec, '.');
  } else if (comma > -1) {
    s = s.replace(',', '.');
  }
  return /^(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : NaN;
}

const SYMBOLS = { PEN: 'S/', USD: '$', EUR: '€' };
const numberFmt = new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (amount, currency) => `${SYMBOLS[currency] || currency} ${numberFmt.format(amount)}`;

function longDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('es-PE', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2400);
}

// Diálogo propio (confirmar o pedir un texto). Devuelve null si se cancela.
function ask({ title, message = '', input = null, okText = 'Aceptar', danger = false }) {
  return new Promise((resolve) => {
    const modal = $('#modal');
    const field = $('#modal-input');
    const ok = $('#modal-ok');
    $('#modal-title').textContent = title;
    $('#modal-message').textContent = message;
    $('#modal-message').hidden = !message;
    field.hidden = input === null;
    field.value = input ?? '';
    ok.textContent = okText;
    ok.className = danger ? 'btn danger' : 'btn primary';
    modal.hidden = false;
    (input === null ? ok : field).focus();

    const close = (value) => {
      modal.hidden = true;
      $('.modal-box').onsubmit = null;
      $('#modal-cancel').onclick = null;
      resolve(value);
    };
    $('.modal-box').onsubmit = (ev) => {
      ev.preventDefault();
      close(input === null ? true : field.value);
    };
    $('#modal-cancel').onclick = () => close(null);
  });
}

function fillSelect(select, values, { empty = null, current = '' } = {}) {
  const list = [...values];
  // Un valor ya usado en un gasto pero eliminado del catálogo se conserva como opción.
  if (current && !list.includes(current)) list.push(current);
  select.replaceChildren(
    ...(empty === null ? [] : [h('option', { value: '' }, empty)]),
    ...list.map((v) => h('option', { value: v }, v)),
  );
  select.value = list.includes(current) ? current : empty === null ? list[0] ?? '' : '';
}

// ---------- configuración ----------

function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const names = (list, max = 80) => {
    const seen = new Set();
    const out = [];
    for (const item of Array.isArray(list) ? list : []) {
      const name = clean(item && typeof item === 'object' ? item.name : item, max);
      if (name && !seen.has(norm(name))) {
        seen.add(norm(name));
        out.push({ name, src: item });
      }
    }
    return out;
  };
  const cfg = {
    categories: names(src.categories).map((c) => ({ name: c.name, subs: names(c.src?.subs).map((s) => s.name) })),
    units: names(src.units, 20).map((u) => u.name),
    paymentMethods: names(src.paymentMethods).map((m) => ({ name: m.name, usesAccount: Boolean(m.src?.usesAccount) })),
    accounts: names(src.accounts).map((a) => a.name),
    merchants: names(src.merchants).map((m) => m.name),
    currencies: names(src.currencies, 5).map((c) => c.name.toUpperCase()),
  };
  // Estas listas alimentan campos obligatorios del formulario: nunca pueden quedar vacías.
  for (const key of ['units', 'paymentMethods', 'currencies']) {
    if (!cfg[key].length) cfg[key] = structuredClone(DEFAULT_CONFIG[key]);
  }
  return cfg;
}

async function saveConfig() {
  await db.setMeta('config', state.config);
  refreshFormOptions();
}

const defaultCurrency = () => (state.config.currencies.includes('PEN') ? 'PEN' : state.config.currencies[0]);
const methodUsesAccount = (name) => Boolean(state.config.paymentMethods.find((m) => m.name === name)?.usesAccount);

// ---------- formulario de gasto ----------

const F = {};
for (const id of ['amount', 'currency', 'concept', 'category', 'subcategory', 'method', 'account', 'merchant', 'date', 'quantity', 'unit', 'note']) {
  F[id] = $(`#f-${id}`);
}

function refreshSubcategories(current = '') {
  const cat = state.config.categories.find((c) => c.name === F.category.value);
  const subs = cat ? cat.subs : [];
  fillSelect(F.subcategory, subs, { empty: '—', current });
  $('#subcategory-field').hidden = !subs.length && !current;
}

function refreshAccountField(current = '') {
  fillSelect(F.account, state.config.accounts, { empty: '—', current });
  $('#account-field').hidden = !methodUsesAccount(F.method.value) && !current;
}

// Repuebla los desplegables conservando lo que el usuario ya eligió.
function refreshFormOptions(values = {}) {
  const v = {
    currency: F.currency.value, category: F.category.value, subcategory: F.subcategory.value,
    method: F.method.value, account: F.account.value, unit: F.unit.value, ...values,
  };
  fillSelect(F.currency, state.config.currencies, { current: v.currency || defaultCurrency() });
  fillSelect(F.category, state.config.categories.map(nameOf), { empty: 'Sin categoría', current: v.category });
  refreshSubcategories(v.subcategory);
  fillSelect(F.method, state.config.paymentMethods.map(nameOf), { current: v.method });
  refreshAccountField(v.account);
  fillSelect(F.unit, state.config.units, { current: v.unit });
  $('#merchants-list').replaceChildren(...state.config.merchants.map((m) => h('option', { value: m })));
}

function showFormError(message) {
  const el = $('#form-error');
  el.textContent = message || '';
  el.hidden = !message;
}

function loadForm(expense) {
  state.editingId = expense ? expense.id : null;
  const e = expense || {};
  F.amount.value = expense ? String(e.amount) : '';
  F.concept.value = e.concept || '';
  F.merchant.value = e.merchant || '';
  F.date.value = e.date || today();
  F.quantity.value = expense ? String(e.quantity ?? '') : '1';
  F.note.value = e.note || '';
  refreshFormOptions({
    currency: e.currency || defaultCurrency(),
    category: e.category || '',
    subcategory: e.subcategory || '',
    method: e.paymentMethod || nameOf(state.config.paymentMethods[0]),
    account: e.account || '',
    unit: e.unit || state.config.units[0],
  });
  showFormError('');
  $('#btn-save').textContent = expense ? 'Guardar cambios' : 'Guardar gasto';
  $('#btn-cancel').hidden = !expense;
  $('#btn-delete').hidden = !expense;
  updateTitle();
}

function readForm() {
  const amount = parseNumber(F.amount.value);
  if (!(amount > 0)) return { error: 'Ingresa un importe mayor que cero.', focus: F.amount };
  const concept = clean(F.concept.value);
  if (!concept) return { error: 'Ingresa el concepto del gasto.', focus: F.concept };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(F.date.value)) return { error: 'Ingresa una fecha válida.', focus: F.date };
  let quantity = null;
  if (F.quantity.value.trim()) {
    quantity = parseNumber(F.quantity.value);
    if (!(quantity > 0)) return { error: 'La cantidad debe ser un número mayor que cero.', focus: F.quantity };
    quantity = Math.round(quantity * 1000) / 1000;
  }
  return {
    values: {
      date: F.date.value,
      concept,
      category: F.category.value,
      subcategory: F.category.value ? F.subcategory.value : '',
      quantity,
      unit: quantity === null ? '' : F.unit.value,
      merchant: clean(F.merchant.value, 80),
      paymentMethod: F.method.value,
      account: $('#account-field').hidden ? '' : F.account.value,
      amount: Math.round(amount * 100) / 100,
      currency: F.currency.value,
      note: clean(F.note.value, 300),
    },
  };
}

async function onSubmitExpense(ev) {
  ev.preventDefault();
  const { error, focus, values } = readForm();
  if (error) {
    showFormError(error);
    focus.focus();
    return;
  }
  const button = $('#btn-save');
  button.disabled = true;
  try {
    const now = new Date().toISOString();
    const previous = state.expenses.find((e) => e.id === state.editingId);
    const expense = { id: previous?.id || newId(), ...values, createdAt: previous?.createdAt || now, updatedAt: now };
    await db.putExpense(expense);
    state.expenses = previous ? state.expenses.map((e) => (e.id === expense.id ? expense : e)) : [...state.expenses, expense];

    // Los comercios nuevos se recuerdan para autocompletar la próxima vez.
    if (expense.merchant && !state.config.merchants.some((m) => norm(m) === norm(expense.merchant))) {
      state.config.merchants.push(expense.merchant);
      state.config.merchants.sort((a, b) => a.localeCompare(b, 'es'));
      await saveConfig();
    }
    // Pide al navegador no desalojar los datos bajo presión de almacenamiento (si lo soporta).
    navigator.storage?.persist?.().catch(() => {});

    loadForm(null);
    if (previous) {
      toast('Cambios guardados');
      show('historial');
    } else {
      toast(`Gasto guardado: ${money(expense.amount, expense.currency)}`);
      window.scrollTo(0, 0);
    }
  } catch (err) {
    console.error(err);
    showFormError('No se pudo guardar el gasto. Intenta de nuevo.');
  } finally {
    button.disabled = false;
  }
}

async function onDeleteExpense() {
  const expense = state.expenses.find((e) => e.id === state.editingId);
  if (!expense) return;
  const ok = await ask({
    title: '¿Eliminar este gasto?',
    message: `${expense.concept} — ${money(expense.amount, expense.currency)}\nEsta acción no se puede deshacer.`,
    okText: 'Eliminar',
    danger: true,
  });
  if (!ok) return;
  await db.deleteExpense(expense.id);
  state.expenses = state.expenses.filter((e) => e.id !== expense.id);
  loadForm(null);
  toast('Gasto eliminado');
  show('historial');
}

// ---------- historial ----------

const H = {};
for (const id of ['q', 'from', 'to', 'category', 'method', 'account', 'merchant']) H[id] = $(`#h-${id}`);

function distinct(field, extra = []) {
  const set = new Set(extra);
  for (const e of state.expenses) if (e[field]) set.add(e[field]);
  return [...set].sort((a, b) => a.localeCompare(b, 'es'));
}

function refreshFilterOptions() {
  const f = state.filters;
  fillSelect(H.category, distinct('category', state.config.categories.map(nameOf)), { empty: 'Todas', current: f.category });
  fillSelect(H.method, distinct('paymentMethod', state.config.paymentMethods.map(nameOf)), { empty: 'Todos', current: f.method });
  fillSelect(H.account, distinct('account', state.config.accounts), { empty: 'Todas', current: f.account });
  fillSelect(H.merchant, distinct('merchant'), { empty: 'Todos', current: f.merchant });
}

function filteredExpenses() {
  const f = state.filters;
  const q = norm(f.q);
  return state.expenses
    .filter((e) =>
      (!f.from || e.date >= f.from) &&
      (!f.to || e.date <= f.to) &&
      (!f.category || e.category === f.category) &&
      (!f.method || e.paymentMethod === f.method) &&
      (!f.account || e.account === f.account) &&
      (!f.merchant || e.merchant === f.merchant) &&
      (!q || norm([e.concept, e.merchant, e.category, e.subcategory, e.paymentMethod, e.account, e.note].join(' ')).includes(q)))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
}

function totalsByCurrency(list) {
  const cents = new Map();
  for (const e of list) cents.set(e.currency, (cents.get(e.currency) || 0) + toCents(e.amount));
  return [...cents].map(([currency, c]) => money(c / 100, currency)).join(' + ');
}

function renderHistory() {
  const list = filteredExpenses();
  const f = state.filters;
  const active = ['from', 'to', 'category', 'method', 'account', 'merchant'].filter((k) => f[k]).length;
  $('#h-toggle').textContent = active ? `Filtros (${active})` : 'Filtros';
  $('#h-summary').textContent = list.length
    ? `${list.length} ${list.length === 1 ? 'gasto' : 'gastos'} · ${totalsByCurrency(list)}`
    : '';

  const root = $('#h-list');
  if (!list.length) {
    root.replaceChildren(h('p', { class: 'empty' },
      state.expenses.length ? 'Ningún gasto coincide con la búsqueda o los filtros.' : 'Aún no has registrado gastos.'));
    $('#h-more').hidden = true;
    return;
  }

  const nodes = [];
  let day = '';
  let group;
  for (const e of list.slice(0, state.histLimit)) {
    if (e.date !== day) {
      day = e.date;
      group = h('div', { class: 'list' });
      nodes.push(h('div', { class: 'day' }, longDate(day)), group);
    }
    const detail = [e.category, e.merchant, e.account || e.paymentMethod].filter(Boolean).join(' · ');
    group.append(h('button', { type: 'button', class: 'item', onclick: () => editExpense(e.id) },
      h('span', { class: 'info' }, h('strong', null, e.concept), h('span', null, detail)),
      h('span', { class: 'money' }, money(e.amount, e.currency))));
  }
  root.replaceChildren(...nodes);
  $('#h-more').hidden = list.length <= state.histLimit;
}

function editExpense(id) {
  const expense = state.expenses.find((e) => e.id === id);
  if (!expense) return;
  loadForm(expense);
  show('nuevo');
}

function onFilterChange() {
  for (const key of Object.keys(H)) state.filters[key] = H[key].value;
  state.histLimit = PAGE_SIZE;
  renderHistory();
}

// ---------- resumen ----------

function shiftMonth(delta) {
  const [y, m] = state.month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  state.month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  renderSummary();
}

function breakdown(list, field, emptyLabel, totalCents) {
  const cents = new Map();
  for (const e of list) cents.set(e[field] || emptyLabel, (cents.get(e[field] || emptyLabel) || 0) + toCents(e.amount));
  const currency = list[0].currency;
  return [...cents].sort((a, b) => b[1] - a[1]).map(([label, c]) => {
    const pct = totalCents ? (c / totalCents) * 100 : 0;
    const fill = h('i');
    fill.style.width = `${pct.toFixed(1)}%`; // vía CSSOM: compatible con la CSP (sin estilos en línea)
    return h('div', { class: 'stat' },
      h('div', { class: 'line' }, h('span', null, label), h('span', null, money(c / 100, currency), ' ', h('small', null, `${Math.round(pct)}%`))),
      h('div', { class: 'bar' }, fill));
  });
}

function renderSummary() {
  const [y, m] = state.month.split('-').map(Number);
  $('#m-label').textContent = new Date(y, m - 1, 1).toLocaleDateString('es-PE', { month: 'long', year: 'numeric' });
  const list = state.expenses.filter((e) => e.date.startsWith(state.month));
  const root = $('#summary-body');
  if (!list.length) {
    root.replaceChildren(h('p', { class: 'empty' }, 'Sin gastos registrados en este mes.'));
    return;
  }
  // Las monedas no se mezclan: un bloque por moneda.
  const currencies = [...new Set(list.map((e) => e.currency))].sort((a, b) => (a === 'PEN' ? -1 : b === 'PEN' ? 1 : a.localeCompare(b)));
  const nodes = [];
  for (const currency of currencies) {
    const sub = list.filter((e) => e.currency === currency);
    const total = sub.reduce((n, e) => n + toCents(e.amount), 0);
    nodes.push(
      h('div', { class: 'card' },
        h('span', { class: 'muted' }, `Total del mes${currencies.length > 1 ? ` (${currency})` : ''} · ${sub.length} ${sub.length === 1 ? 'gasto' : 'gastos'}`),
        h('span', { class: 'total' }, money(total / 100, currency))),
      h('h2', null, `Por categoría${currencies.length > 1 ? ` (${currency})` : ''}`),
      h('div', { class: 'card' }, breakdown(sub, 'category', 'Sin categoría', total)),
      h('h2', null, `Por medio de pago${currencies.length > 1 ? ` (${currency})` : ''}`),
      h('div', { class: 'card' }, breakdown(sub, 'paymentMethod', 'Sin medio de pago', total)),
    );
  }
  root.replaceChildren(...nodes);
}

// ---------- ajustes: catálogos ----------

// field: campo del gasto que guarda el nombre (para propagar los cambios de nombre).
const LISTS = [
  { key: 'categories', title: 'Categorías', field: 'category', placeholder: 'Nueva categoría' },
  { key: 'paymentMethods', title: 'Medios de pago', field: 'paymentMethod', placeholder: 'Nuevo medio de pago', required: true },
  {
    key: 'accounts', title: 'Tarjetas y cuentas', field: 'account', placeholder: 'Alias, p. ej. Visa BCP',
    hint: 'Usa solo un alias. Nunca registres el número de la tarjeta, CVV ni claves.',
  },
  { key: 'units', title: 'Unidades', field: 'unit', placeholder: 'Nueva unidad', required: true },
  { key: 'merchants', title: 'Comercios frecuentes', field: 'merchant', placeholder: 'Nuevo comercio', hint: 'Se agregan solos al registrar gastos.' },
  { key: 'currencies', title: 'Monedas', field: 'currency', placeholder: 'Código, p. ej. EUR', required: true, upper: true },
];

function validateName(def, raw, siblings, currentName = null) {
  let name = clean(raw, 80);
  if (def.upper) name = name.toUpperCase();
  if (!name) return { error: 'Escribe un nombre.' };
  if (def.key === 'accounts' && /\d{7,}/.test(name.replace(/[\s.-]/g, ''))) {
    return { error: 'Eso parece un número de tarjeta o cuenta. Usa solo un alias.' };
  }
  if (siblings.some((s) => norm(nameOf(s)) === norm(name) && nameOf(s) !== currentName)) return { error: `"${name}" ya existe.` };
  return { name };
}

// Aplica un cambio a los gastos que cumplan la condición (p. ej. al renombrar una categoría).
async function patchExpenses(predicate, patch) {
  const now = new Date().toISOString();
  const changed = state.expenses.filter(predicate).map((e) => ({ ...e, ...patch, updatedAt: now }));
  if (!changed.length) return;
  await db.putExpenses(changed);
  const byId = new Map(changed.map((e) => [e.id, e]));
  state.expenses = state.expenses.map((e) => byId.get(e.id) || e);
}

async function afterConfigChange() {
  await saveConfig();
  renderSettings();
}

function addRow(def, siblings, onAdd, placeholder = def.placeholder) {
  const input = h('input', { type: 'text', maxLength: 80, placeholder, 'aria-label': placeholder });
  return h('form', {
    class: 'addrow',
    onsubmit: async (ev) => {
      ev.preventDefault();
      const { error, name } = validateName(def, input.value, siblings);
      if (error) return toast(error);
      await onAdd(name);
    },
  }, input, h('button', { type: 'submit', class: 'btn small' }, 'Agregar'));
}

function itemButtons(onRename, onDelete, label) {
  return [
    h('button', { type: 'button', class: 'btn small', 'aria-label': `Renombrar ${label}`, onclick: onRename }, '✎'),
    h('button', { type: 'button', class: 'btn small danger', 'aria-label': `Eliminar ${label}`, onclick: onDelete }, '✕'),
  ];
}

async function renameItem(def, list, index) {
  const old = nameOf(list[index]);
  const answer = await ask({ title: 'Renombrar', message: 'Los gastos ya registrados se actualizarán con el nuevo nombre.', input: old, okText: 'Guardar' });
  if (answer === null) return;
  const { error, name } = validateName(def, answer, list, old);
  if (error) return toast(error);
  if (name === old) return;
  if (typeof list[index] === 'string') list[index] = name;
  else list[index].name = name;
  await patchExpenses((e) => e[def.field] === old, { [def.field]: name });
  await afterConfigChange();
}

async function deleteItem(def, list, index) {
  const name = nameOf(list[index]);
  if (def.required && list.length === 1) return toast('Debe quedar al menos un elemento en esta lista.');
  const ok = await ask({
    title: `¿Eliminar "${name}"?`,
    message: 'Los gastos ya registrados conservan este valor; solo deja de ofrecerse para nuevos gastos.',
    okText: 'Eliminar',
    danger: true,
  });
  if (!ok) return;
  list.splice(index, 1);
  await afterConfigChange();
}

const SUB_DEF = { key: 'subcategories' };

function renderSubcategories(category) {
  const subs = category.subs;
  return h('div', { class: 'subs' },
    h('ul', { class: 'items' }, subs.map((sub, i) =>
      h('li', null, h('div', { class: 'line' },
        h('span', { class: 'name' }, sub),
        itemButtons(
          async () => {
            const answer = await ask({ title: 'Renombrar subcategoría', input: sub, okText: 'Guardar' });
            if (answer === null) return;
            const { error, name } = validateName(SUB_DEF, answer, subs, sub);
            if (error) return toast(error);
            if (name === sub) return;
            subs[i] = name;
            await patchExpenses((e) => e.category === category.name && e.subcategory === sub, { subcategory: name });
            await afterConfigChange();
          },
          async () => {
            const ok = await ask({ title: `¿Eliminar "${sub}"?`, message: 'Los gastos ya registrados conservan este valor.', okText: 'Eliminar', danger: true });
            if (!ok) return;
            subs.splice(i, 1);
            await afterConfigChange();
          },
          sub,
        ))))),
    addRow(SUB_DEF, subs, async (name) => {
      subs.push(name);
      await afterConfigChange();
    }, `Nueva subcategoría de ${category.name}`));
}

function renderItem(def, list, index) {
  const item = list[index];
  const name = nameOf(item);
  const li = h('li', null, h('div', { class: 'line' },
    h('span', { class: 'name' }, name),
    itemButtons(() => renameItem(def, list, index), () => deleteItem(def, list, index), name)));
  if (def.key === 'paymentMethods') {
    li.append(h('label', { class: 'check' },
      h('input', {
        type: 'checkbox',
        checked: item.usesAccount,
        onchange: async (ev) => {
          item.usesAccount = ev.target.checked;
          await saveConfig();
        },
      }),
      'Pide tarjeta / cuenta'));
  }
  if (def.key === 'categories') li.append(renderSubcategories(item));
  return li;
}

function renderSettings() {
  $('#settings-lists').replaceChildren(...LISTS.map((def) => {
    const list = state.config[def.key];
    return h('details', {
      class: 'card',
      open: state.openSections.has(def.key),
      ontoggle: (ev) => state.openSections[ev.target.open ? 'add' : 'delete'](def.key),
    },
      h('summary', null, def.title, h('span', { class: 'count' }, list.length)),
      h('div', { class: 'section-body' },
        def.hint && h('p', { class: 'muted' }, def.hint),
        h('ul', { class: 'items' }, list.map((_, i) => renderItem(def, list, i))),
        addRow(def, list, async (name) => {
          list.push(def.key === 'categories' ? { name, subs: [] } : def.key === 'paymentMethods' ? { name, usesAccount: false } : name);
          await afterConfigChange();
        })));
  }));

  const n = state.expenses.length;
  const last = state.lastBackupAt
    ? `Último backup: ${new Date(state.lastBackupAt).toLocaleString('es-PE', { dateStyle: 'medium', timeStyle: 'short' })}.`
    : 'Aún no has creado ningún backup.';
  $('#backup-info').textContent =
    `${n} ${n === 1 ? 'gasto guardado' : 'gastos guardados'} solo en este dispositivo. ${last} El backup incluye gastos y catálogos; guárdalo fuera del teléfono periódicamente.`;
  $('#about').textContent = `Gastos v${APP_VERSION} · Tus datos no salen de este dispositivo.`;
}

// ---------- exportación y backup ----------

// Columnas de la exportación (una fila por gasto). El orden y los nombres son el contrato con Excel / Power Query:
// si se cambian, hay que actualizar el README.
const EXPORT_COLUMNS = [
  { header: 'Fecha', type: 'd', width: 12, value: (e) => e.date },
  { header: 'Concepto', type: 's', width: 32, value: (e) => e.concept },
  { header: 'Categoría', type: 's', width: 18, value: (e) => e.category },
  { header: 'Subcategoría', type: 's', width: 18, value: (e) => e.subcategory },
  { header: 'Cantidad', type: 'n', width: 10, value: (e) => e.quantity },
  { header: 'Unidad', type: 's', width: 10, value: (e) => e.unit },
  { header: 'Comercio', type: 's', width: 22, value: (e) => e.merchant },
  { header: 'Medio de pago', type: 's', width: 18, value: (e) => e.paymentMethod },
  { header: 'Tarjeta o cuenta', type: 's', width: 20, value: (e) => e.account },
  { header: 'Importe', type: 'n', width: 12, value: (e) => e.amount },
  { header: 'Moneda', type: 's', width: 9, value: (e) => e.currency },
  { header: 'Observación', type: 's', width: 30, value: (e) => e.note },
  { header: 'ID', type: 's', width: 38, value: (e) => e.id },
  { header: 'Creado', type: 's', width: 25, value: (e) => e.createdAt },
  { header: 'Actualizado', type: 's', width: 25, value: (e) => e.updatedAt },
];

function exportRows() {
  return [...state.expenses]
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt))
    .map((e) => EXPORT_COLUMNS.map((c) => c.value(e) ?? ''));
}

function buildCsv() {
  const quote = (v) => (/[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = [EXPORT_COLUMNS.map((c) => c.header), ...exportRows()].map((row) => row.map(quote).join(','));
  // BOM inicial: Excel reconoce así el archivo como UTF-8 (tildes y ñ correctas).
  return new Blob(['﻿' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
}

// Entrega un archivo al usuario. En iPhone abre la hoja de compartir (Guardar en Archivos, AirDrop, Mail…);
// en escritorio, o si compartir archivos no está disponible, hace una descarga normal.
async function deliver(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  const touch = window.matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return true;
    } catch (err) {
      if (err.name === 'AbortError') return false; // el usuario cerró la hoja de compartir
    }
  }
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return true;
}

async function exportData(kind) {
  if (!state.expenses.length) return toast('No hay gastos para exportar.');
  const blob = kind === 'xlsx' ? buildXlsx('Gastos', EXPORT_COLUMNS, exportRows()) : buildCsv();
  if (await deliver(blob, `gastos_${today()}.${kind}`)) toast('Exportación lista');
}

async function createBackup() {
  const now = new Date().toISOString();
  const payload = {
    format: BACKUP_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    appVersion: APP_VERSION,
    exportedAt: now,
    config: state.config,
    expenses: state.expenses,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  if (await deliver(blob, `gastos_backup_${today()}.json`)) {
    state.lastBackupAt = now;
    await db.setMeta('lastBackupAt', now);
    renderSettings();
    toast('Backup creado');
  }
}

// Valida y normaliza un gasto leído de un backup. Devuelve null si no es utilizable.
function sanitizeExpense(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const amount = Number(raw.amount);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.date) || !Number.isFinite(amount)) return null;
  const quantity = raw.quantity === null || raw.quantity === undefined || raw.quantity === '' ? null : Number(raw.quantity);
  const now = new Date().toISOString();
  return {
    id: clean(raw.id, 64) || newId(),
    date: raw.date,
    concept: clean(raw.concept),
    category: clean(raw.category, 80),
    subcategory: clean(raw.subcategory, 80),
    quantity: Number.isFinite(quantity) ? quantity : null,
    unit: clean(raw.unit, 20),
    merchant: clean(raw.merchant, 80),
    paymentMethod: clean(raw.paymentMethod, 80),
    account: clean(raw.account, 80),
    amount: Math.round(amount * 100) / 100,
    currency: clean(raw.currency, 5).toUpperCase() || 'PEN',
    note: clean(raw.note, 300),
    createdAt: clean(raw.createdAt, 30) || now,
    updatedAt: clean(raw.updatedAt, 30) || now,
  };
}

async function restoreBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return toast('El archivo no es un backup válido.');
  }
  if (!data || data.format !== BACKUP_FORMAT || !Array.isArray(data.expenses)) return toast('El archivo no es un backup de Gastos.');
  if (Number(data.schemaVersion) > SCHEMA_VERSION) return toast('El backup proviene de una versión más nueva de la app.');

  const byId = new Map();
  for (const raw of data.expenses) {
    const e = sanitizeExpense(raw);
    if (e) byId.set(e.id, e);
  }
  const expenses = [...byId.values()];
  const skipped = data.expenses.length - expenses.length;
  const ok = await ask({
    title: '¿Restaurar este backup?',
    message:
      `El backup contiene ${expenses.length} gastos` +
      (skipped ? ` (${skipped} registros inválidos o duplicados se omitirán)` : '') +
      `.\nSe reemplazarán los ${state.expenses.length} gastos y los catálogos actuales de este dispositivo.`,
    okText: 'Restaurar',
    danger: true,
  });
  if (!ok) return;

  const config = normalizeConfig(data.config);
  await db.replaceAll({ config, expenses });
  state.config = config;
  state.expenses = expenses;
  loadForm(null);
  renderSettings();
  toast(`Backup restaurado: ${expenses.length} gastos`);
}

// ---------- navegación ----------

const TITLES = { nuevo: 'Nuevo gasto', historial: 'Historial', resumen: 'Resumen', ajustes: 'Ajustes' };

function updateTitle() {
  $('#title').textContent = state.view === 'nuevo' && state.editingId ? 'Editar gasto' : TITLES[state.view];
}

function show(view) {
  state.view = view;
  for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== `view-${view}`;
  for (const tab of document.querySelectorAll('.tabbar button')) tab.classList.toggle('active', tab.dataset.view === view);
  updateTitle();
  if (view === 'historial') {
    refreshFilterOptions();
    renderHistory();
  } else if (view === 'resumen') {
    renderSummary();
  } else if (view === 'ajustes') {
    renderSettings();
  }
  window.scrollTo(0, 0);
}

// ---------- inicio ----------

function bindEvents() {
  for (const tab of document.querySelectorAll('.tabbar button')) {
    tab.addEventListener('click', () => {
      // Salir de la edición sin guardar descarta los cambios y deja el formulario listo para un gasto nuevo.
      if (state.editingId && tab.dataset.view !== 'nuevo') loadForm(null);
      show(tab.dataset.view);
    });
  }

  $('#expense-form').addEventListener('submit', onSubmitExpense);
  F.category.addEventListener('change', () => refreshSubcategories());
  F.method.addEventListener('change', () => refreshAccountField());
  $('#btn-cancel').addEventListener('click', () => {
    loadForm(null);
    show('historial');
  });
  $('#btn-delete').addEventListener('click', onDeleteExpense);

  H.q.addEventListener('input', onFilterChange);
  for (const key of ['from', 'to', 'category', 'method', 'account', 'merchant']) H[key].addEventListener('change', onFilterChange);
  $('#h-toggle').addEventListener('click', () => {
    const panel = $('#h-filters');
    panel.hidden = !panel.hidden;
    $('#h-toggle').setAttribute('aria-expanded', String(!panel.hidden));
  });
  $('#h-clear').addEventListener('click', () => {
    for (const key of Object.keys(H)) H[key].value = '';
    onFilterChange();
  });
  $('#h-more').addEventListener('click', () => {
    state.histLimit += PAGE_SIZE;
    renderHistory();
  });

  $('#m-prev').addEventListener('click', () => shiftMonth(-1));
  $('#m-next').addEventListener('click', () => shiftMonth(1));

  $('#btn-xlsx').addEventListener('click', () => exportData('xlsx'));
  $('#btn-csv').addEventListener('click', () => exportData('csv'));
  $('#btn-backup').addEventListener('click', createBackup);
  $('#btn-restore').addEventListener('click', () => $('#restore-file').click());
  $('#restore-file').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = ''; // permite volver a elegir el mismo archivo
    if (file) await restoreBackup(file);
  });
}

async function init() {
  bindEvents();
  state.month = today().slice(0, 7);
  try {
    const [config, expenses, lastBackupAt] = await Promise.all([db.getMeta('config'), db.getAllExpenses(), db.getMeta('lastBackupAt')]);
    if (config) state.config = normalizeConfig(config);
    else await db.setMeta('config', state.config);
    state.expenses = expenses;
    state.lastBackupAt = lastBackupAt || null;
  } catch (err) {
    console.error(err);
    toast('No se pudo abrir el almacenamiento local. Los datos no se guardarán.');
  }
  loadForm(null);
  show('nuevo');
  document.documentElement.dataset.ready = 'true';

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker no registrado:', err));
  }
}

init();
