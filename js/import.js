// Importación aditiva de gastos (p. ej. un histórico previo a la app).
//
// Módulo puro: sin DOM ni IndexedDB. Lo usan la app (js/app.js) y la herramienta
// tools/historico/transformar.mjs, de modo que el archivo generado se valida con
// exactamente las mismas reglas con las que la app lo aceptará.
//
// Formato del archivo:
//   { format: "gastos-app-import", schemaVersion: 1, generatedAt, source,
//     catalog: { categories, units, paymentMethods, accounts, merchants, currencies },
//     expenses: [ gasto con el mismo modelo que usa la app ] }

export const IMPORT_FORMAT = 'gastos-app-import';
export const IMPORT_SCHEMA_VERSION = 1;

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const tidy = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
const nameOf = (item) => (item && typeof item === 'object' ? item.name : item);

function isRealDate(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

const TEXT_LIMITS = { concept: 120, category: 80, subcategory: 80, unit: 20, merchant: 80, paymentMethod: 80, account: 80, note: 300 };

// Valida un gasto del archivo de importación. A diferencia de la restauración de un backup,
// aquí no se corrige nada en silencio: lo que no cumple se rechaza con su motivo.
export function validateExpense(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'el registro no es un objeto' };
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id || id.length > 64) return { error: 'falta el identificador (id) o es demasiado largo' };
  if (!isRealDate(raw.date)) return { error: 'fecha ausente o inválida (se espera AAAA-MM-DD)' };
  if (typeof raw.amount !== 'number' || !Number.isFinite(raw.amount) || !(raw.amount > 0)) {
    return { error: 'importe ausente o no mayor que cero' };
  }
  if (Math.abs(raw.amount * 100 - Math.round(raw.amount * 100)) > 1e-6) return { error: 'el importe tiene más de 2 decimales' };
  let quantity = null;
  if (raw.quantity !== null && raw.quantity !== undefined && raw.quantity !== '') {
    if (typeof raw.quantity !== 'number' || !Number.isFinite(raw.quantity) || !(raw.quantity > 0)) {
      return { error: 'la cantidad debe ser un número mayor que cero' };
    }
    quantity = Math.round(raw.quantity * 1000) / 1000;
  }
  const text = {};
  for (const [field, max] of Object.entries(TEXT_LIMITS)) {
    const value = raw[field] ?? '';
    if (typeof value !== 'string') return { error: `el campo "${field}" no es texto` };
    text[field] = tidy(value);
    if (text[field].length > max) return { error: `el campo "${field}" supera ${max} caracteres` };
  }
  if (!text.concept) return { error: 'falta el concepto' };
  if (text.subcategory && !text.category) return { error: 'tiene subcategoría pero no categoría' };
  if (text.unit && quantity === null) return { error: 'tiene unidad pero no cantidad' };
  if (/\d{7,}/.test(text.account.replace(/[\s.-]/g, ''))) return { error: 'la tarjeta o cuenta parece un número, no un alias' };
  const currency = typeof raw.currency === 'string' ? raw.currency.trim().toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(currency)) return { error: 'moneda ausente o inválida (código de 3 letras)' };
  const createdAt = typeof raw.createdAt === 'string' && !Number.isNaN(Date.parse(raw.createdAt)) ? raw.createdAt : '';
  return {
    expense: {
      id, date: raw.date, concept: text.concept, category: text.category, subcategory: text.subcategory,
      quantity, unit: text.unit, merchant: text.merchant, paymentMethod: text.paymentMethod, account: text.account,
      amount: Math.round(raw.amount * 100) / 100, currency, note: text.note, createdAt,
    },
  };
}

// Dos gastos con la misma fecha, concepto, importe y moneda se consideran "el mismo gasto"
// a efectos de detectar un posible duplicado con algo ya registrado a mano.
export const contentKey = (e) => `${e.date}|${norm(e.concept)}|${Math.round(e.amount * 100)}|${e.currency}`;

// Añade al catálogo actual lo que los gastos aceptados necesitan. Nunca quita ni renombra nada.
function mergeCatalog(config, catalog, expenses) {
  const next = structuredClone(config);
  const added = { categories: [], subcategories: [], units: [], paymentMethods: [], accounts: [], merchants: [], currencies: [] };
  const declared = catalog && typeof catalog === 'object' ? catalog : {};
  const declaredMethods = new Map((Array.isArray(declared.paymentMethods) ? declared.paymentMethods : [])
    .filter((m) => m && typeof m === 'object').map((m) => [norm(m.name), Boolean(m.usesAccount)]));

  const addSimple = (key, value) => {
    if (!value || next[key].some((v) => norm(nameOf(v)) === norm(value))) return;
    next[key].push(value);
    added[key].push(value);
  };
  for (const e of expenses) {
    if (e.category) {
      let cat = next.categories.find((c) => norm(c.name) === norm(e.category));
      if (!cat) {
        cat = { name: e.category, subs: [] };
        next.categories.push(cat);
        added.categories.push(e.category);
      }
      if (e.subcategory && !cat.subs.some((s) => norm(s) === norm(e.subcategory))) {
        cat.subs.push(e.subcategory);
        added.subcategories.push(`${cat.name} / ${e.subcategory}`);
      }
    }
    if (e.paymentMethod && !next.paymentMethods.some((m) => norm(m.name) === norm(e.paymentMethod))) {
      const usesAccount = declaredMethods.get(norm(e.paymentMethod)) ?? Boolean(e.account);
      next.paymentMethods.push({ name: e.paymentMethod, usesAccount });
      added.paymentMethods.push(e.paymentMethod);
    }
    addSimple('units', e.unit);
    addSimple('accounts', e.account);
    addSimple('merchants', e.merchant);
    addSimple('currencies', e.currency);
  }
  next.merchants.sort((a, b) => a.localeCompare(b, 'es'));
  return { config: next, added };
}

// Calcula qué pasaría al importar, sin modificar nada. La app muestra este plan y solo
// escribe si el usuario confirma.
//   data      contenido del archivo (ya parseado)
//   existing  gastos actuales de la app
//   config    catálogos actuales de la app
export function planImport(data, existing, config, { includePossible = false } = {}) {
  if (!data || typeof data !== 'object' || data.format !== IMPORT_FORMAT || !Array.isArray(data.expenses)) {
    return { error: 'El archivo no es un archivo de importación de Gastos.' };
  }
  if (!(Number(data.schemaVersion) <= IMPORT_SCHEMA_VERSION)) {
    return { error: 'El archivo de importación proviene de una versión más nueva de la app.' };
  }

  const existingIds = new Set(existing.map((e) => e.id));
  // Cuántos gastos ya registrados hay por cada "contenido" (para emparejar uno a uno).
  const existingContent = new Map();
  for (const e of existing) existingContent.set(contentKey(e), (existingContent.get(contentKey(e)) || 0) + 1);

  const seen = new Set();
  const accepted = [];
  const duplicates = [];
  const possible = [];
  const rejected = [];
  data.expenses.forEach((raw, index) => {
    const label = raw && typeof raw === 'object' ? tidy(raw.concept).slice(0, 40) : '';
    const { error, expense } = validateExpense(raw);
    if (error) return rejected.push({ index, label, reason: error });
    if (seen.has(expense.id)) return duplicates.push({ index, label, reason: 'identificador repetido dentro del archivo' });
    seen.add(expense.id);
    if (existingIds.has(expense.id)) return duplicates.push({ index, label, reason: 'ya importado antes (mismo identificador)' });
    const key = contentKey(expense);
    if (existingContent.get(key) > 0) {
      existingContent.set(key, existingContent.get(key) - 1);
      possible.push({ index, label, reason: 'ya existe un gasto con la misma fecha, concepto e importe', expense });
      return;
    }
    accepted.push(expense);
  });

  const toImport = includePossible ? [...accepted, ...possible.map((p) => p.expense)] : accepted;
  const { config: mergedConfig, added } = mergeCatalog(config, data.catalog, toImport);
  const dates = toImport.map((e) => e.date).sort();
  const cents = new Map();
  for (const e of toImport) cents.set(e.currency, (cents.get(e.currency) || 0) + Math.round(e.amount * 100));

  return {
    total: data.expenses.length,
    toImport,
    duplicates,
    possible,
    rejected,
    mergedConfig,
    added,
    from: dates[0] || '',
    to: dates.at(-1) || '',
    totals: [...cents].map(([currency, c]) => ({ currency, amount: c / 100 })),
    uncategorized: toImport.filter((e) => !e.category).length,
    noMethod: toImport.filter((e) => !e.paymentMethod).length,
  };
}
