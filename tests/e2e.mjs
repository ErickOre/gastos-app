// Pruebas end-to-end de la PWA con Playwright. Usa únicamente datos ficticios.
//
// Ejecutar (ver README, sección "Pruebas"):
//   PW_HOME=/ruta/donde/instalaste/playwright node tests/e2e.mjs [webkit] [chrome]
//
// Playwright NO se instala dentro del proyecto: si la carpeta está en iCloud Drive,
// node_modules se corrompe al sincronizar. PW_HOME apunta a una carpeta externa
// que contiene node_modules/playwright.

import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { transformar } from '../tools/historico/transformar.mjs';

const require = createRequire(process.env.PW_HOME ? path.join(process.env.PW_HOME, 'x.js') : import.meta.url);
const { webkit, chromium, devices } = require('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests', 'output');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
};

function startServer() {
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (!p.startsWith('/gastos/')) return res.writeHead(404).end();
      p = p.slice('/gastos/'.length) || 'index.html'; // se sirve bajo un subdirectorio, como en GitHub Pages
      const file = path.join(ROOT, p);
      if (!file.startsWith(ROOT)) return res.writeHead(403).end();
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const results = [];
let current = '';
function check(name, ok, detail = '') {
  results.push({ suite: current, name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
}
const eq = (name, actual, expected) => check(name, actual === expected, `esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)}`);

const pad = (n) => String(n).padStart(2, '0');
function limaToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
}
function lastMonthDay10() {
  const [y, m] = limaToday().split('-').map(Number);
  const d = new Date(y, m - 2, 10);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-10`;
}

async function ready(page) {
  await page.waitForSelector('html[data-ready="true"]');
}
async function tab(page, view) {
  await page.click(`.tabbar button[data-view="${view}"]`);
}
async function addExpense(page, e) {
  await tab(page, 'nuevo');
  await page.fill('#f-amount', e.amount);
  if (e.currency) await page.selectOption('#f-currency', e.currency);
  await page.fill('#f-concept', e.concept);
  if (e.category) await page.selectOption('#f-category', e.category);
  if (e.sub) await page.selectOption('#f-subcategory', e.sub);
  if (e.method) await page.selectOption('#f-method', e.method);
  if (e.account) await page.selectOption('#f-account', e.account);
  if (e.merchant) await page.fill('#f-merchant', e.merchant);
  if (e.date) await page.fill('#f-date', e.date);
  if (e.note) await page.fill('#f-note', e.note);
  await page.click('#btn-save');
  await page.waitForFunction(() => document.querySelector('#f-amount').value === '');
}
const count = (page) => page.locator('#h-list .item').count();
async function download(page, selector, name) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click(selector)]);
  const file = path.join(OUT, `${current}-${name}`);
  await dl.saveAs(file);
  return { file, suggested: dl.suggestedFilename() };
}
async function noOverflow(page, label) {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  check(`sin desborde horizontal: ${label}`, o.sw <= o.iw, `scrollWidth ${o.sw} > ${o.iw}`);
}

async function suite(name, launch) {
  current = name;
  console.log(`\n== ${name} ==`);
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}/gastos/`;
  const browser = await launch();
  const { defaultBrowserType, ...iphone } = devices['iPhone 14'];
  const options = { ...iphone, locale: 'es-PE', timezoneId: 'America/Lima', acceptDownloads: true };
  const ctx = await browser.newContext(options);
  // Sin hoja de compartir en el navegador de pruebas: se fuerza la ruta de descarga.
  await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, 'canShare', { value: undefined, configurable: true }));

  const external = [];
  const errors = [];
  const watch = (page) => {
    page.on('request', (r) => { if (!r.url().startsWith(base) && !/^(blob|data):/.test(r.url())) external.push(r.url()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${m.text()} (después de: ${results.at(-1)?.name})`); });
  };

  try {
    const page = await ctx.newPage();
    watch(page);
    // Al capturar, Playwright inyecta un <style> que la CSP de la app bloquea en WebKit:
    // ese aviso lo causa la herramienta, no la app, y se descarta solo durante la captura.
    const shot = async (label, fullPage = false) => {
      const before = errors.length;
      await page.screenshot({ path: path.join(OUT, `${name}-${label}.png`), fullPage });
      await page.waitForTimeout(100);
      const during = errors.splice(before);
      errors.push(...during.filter((e) => !e.includes('Refused to apply a stylesheet')));
    };
    await page.goto(base);
    await ready(page);
    const today = limaToday();
    const prev = lastMonthDay10();

    // --- valores por defecto y validación ---
    eq('fecha por defecto = hoy', await page.inputValue('#f-date'), today);
    eq('moneda por defecto = PEN', await page.inputValue('#f-currency'), 'PEN');
    eq('cantidad por defecto = 1', await page.inputValue('#f-quantity'), '1');
    await page.click('#btn-save');
    check('validación: importe obligatorio', await page.isVisible('#form-error'));
    check('tarjeta oculta con Efectivo', await page.isHidden('#account-field'));
    await page.selectOption('#f-method', 'Tarjeta de crédito');
    check('tarjeta visible con Tarjeta de crédito', await page.isVisible('#account-field'));

    // --- alta ---
    await addExpense(page, { amount: '25,50', concept: 'Almuerzo menú', category: 'Alimentación', sub: 'Restaurantes', method: 'Efectivo', merchant: 'Restaurante Ficticio' });
    await addExpense(page, { amount: '120.00', concept: 'Compras "semana", varios', category: 'Alimentación', sub: 'Supermercado', method: 'Tarjeta de crédito', account: 'Visa BCP', merchant: 'Mercado Demo', note: 'Nota <b>de</b> prueba & más' });
    await addExpense(page, { amount: '15', currency: 'USD', concept: 'Suscripción demo', category: 'Servicios', sub: 'Suscripciones', method: 'Tarjeta de débito', account: 'Mastercard Interbank', date: prev });
    await addExpense(page, { amount: '8.5', concept: 'Taxi al centro', category: 'Transporte', sub: 'Taxi', method: 'Yape' });

    // --- historial, búsqueda y filtros ---
    await tab(page, 'historial');
    eq('historial muestra 4 gastos', await count(page), 4);
    check('resumen del historial', (await page.textContent('#h-summary')).includes('4 gastos'));
    check('importe con coma decimal guardado como 25.50', (await page.textContent('#h-list')).includes('S/ 25.50'));
    check('texto con HTML se muestra literal', (await page.locator('#h-list b').count()) === 0);
    await page.fill('#h-q', 'TAXI');
    eq('búsqueda "TAXI" (sin distinguir mayúsculas)', await count(page), 1);
    await page.fill('#h-q', 'suscripcion');
    eq('búsqueda sin tildes', await count(page), 1);
    await page.fill('#h-q', '');
    await page.click('#h-toggle');
    await page.selectOption('#h-category', 'Alimentación');
    eq('filtro categoría', await count(page), 2);
    await page.selectOption('#h-method', 'Tarjeta de crédito');
    eq('filtro categoría + medio de pago', await count(page), 1);
    await page.click('#h-clear');
    await page.selectOption('#h-account', 'Mastercard Interbank');
    eq('filtro tarjeta', await count(page), 1);
    await page.click('#h-clear');
    await page.selectOption('#h-merchant', 'Mercado Demo');
    eq('filtro comercio', await count(page), 1);
    await page.click('#h-clear');
    await page.fill('#h-from', today);
    eq('filtro desde hoy', await count(page), 3);
    await page.fill('#h-from', '');
    await page.fill('#h-to', prev);
    eq('filtro hasta el mes pasado', await count(page), 1);
    await noOverflow(page, 'historial con filtros');
    await shot('historial-filtros');
    await page.click('#h-clear');
    eq('limpiar filtros', await count(page), 4);

    // --- persistencia ---
    await page.reload();
    await ready(page);
    await tab(page, 'historial');
    eq('persistencia tras recargar', await count(page), 4);

    // --- edición ---
    await page.locator('#h-list .item', { hasText: 'Taxi al centro' }).click();
    eq('título en edición', await page.textContent('#title'), 'Editar gasto');
    eq('formulario cargado con el gasto', await page.inputValue('#f-amount'), '8.5');
    eq('subcategoría cargada', await page.inputValue('#f-subcategory'), 'Taxi');
    await page.fill('#f-amount', '9');
    await page.click('#btn-save');
    await page.waitForSelector('#view-historial:not([hidden])');
    check('edición reflejada', (await page.textContent('#h-list')).includes('S/ 9.00'));
    eq('edición no duplica', await count(page), 4);

    // --- eliminación ---
    await page.locator('#h-list .item', { hasText: 'Almuerzo menú' }).click();
    await page.click('#btn-delete');
    await page.click('#modal-cancel');
    await tab(page, 'historial');
    eq('cancelar eliminación conserva el gasto', await count(page), 4);
    await page.locator('#h-list .item', { hasText: 'Almuerzo menú' }).click();
    await page.click('#btn-delete');
    await page.click('#modal-ok');
    await page.waitForSelector('#view-historial:not([hidden])');
    eq('eliminación', await count(page), 3);

    // --- resumen ---
    await tab(page, 'resumen');
    let text = await page.textContent('#summary-body');
    check('total del mes = S/ 129.00', text.includes('S/ 129.00'), text);
    check('total por categoría', /Alimentación\s*S\/ 120\.00\s*93%/.test(text) && /Transporte\s*S\/ 9\.00\s*7%/.test(text), text);
    check('total por medio de pago', /Tarjeta de crédito\s*S\/ 120\.00/.test(text) && /Yape\s*S\/ 9\.00/.test(text), text);
    await shot('resumen');
    await noOverflow(page, 'resumen');
    await page.click('#m-prev');
    text = await page.textContent('#summary-body');
    check('mes anterior: total en USD separado', text.includes('$ 15.00') && !text.includes('S/'), text);
    await page.click('#m-prev');
    check('mes sin gastos', (await page.textContent('#summary-body')).includes('Sin gastos'));

    // --- configuración ---
    await tab(page, 'ajustes');
    const section = (title) => page.locator('#settings-lists details', { has: page.locator('summary', { hasText: title }) });
    await section('Categorías').locator('> summary').click();
    await section('Categorías').locator('.section-body > .addrow input').fill('Mascotas');
    await section('Categorías').locator('.section-body > .addrow button').click();
    await page.waitForSelector('button[aria-label="Renombrar Mascotas"]');
    await section('Categorías').locator('.section-body > .addrow input').fill('mascotas');
    await section('Categorías').locator('.section-body > .addrow button').click();
    eq('no admite duplicados', await page.locator('button[aria-label^="Renombrar Mascotas"], button[aria-label^="Renombrar mascotas"]').count(), 1);
    await page.fill('input[placeholder="Nueva subcategoría de Mascotas"]', 'Veterinario');
    await page.press('input[placeholder="Nueva subcategoría de Mascotas"]', 'Enter');
    await page.waitForSelector('button[aria-label="Renombrar Veterinario"]');
    await page.click('button[aria-label="Renombrar Alimentación"]');
    await page.fill('#modal-input', 'Comida');
    await page.click('#modal-ok');
    await page.waitForSelector('button[aria-label="Renombrar Comida"]');
    await section('Tarjetas y cuentas').locator('> summary').click();
    await section('Tarjetas y cuentas').locator('.addrow input').fill('4111 1111 1111 1111');
    await section('Tarjetas y cuentas').locator('.addrow button').click();
    eq('rechaza un número de tarjeta como alias', await section('Tarjetas y cuentas').locator('.items > li').count(), 2);
    await section('Tarjetas y cuentas').locator('.addrow input').fill('Cuenta Demo 01');
    await section('Tarjetas y cuentas').locator('.addrow button').click();
    await page.waitForSelector('button[aria-label="Renombrar Cuenta Demo 01"]');
    await section('Comercios frecuentes').locator('> summary').click();
    eq('comercios aprendidos al registrar', await section('Comercios frecuentes').locator('.items > li').count(), 2);
    await noOverflow(page, 'ajustes');
    await shot('ajustes', true);

    await tab(page, 'nuevo');
    const cats = await page.locator('#f-category option').allTextContents();
    check('categoría nueva y renombrada disponibles en el formulario', cats.includes('Mascotas') && cats.includes('Comida') && !cats.includes('Alimentación'), cats.join());
    await page.selectOption('#f-category', 'Mascotas');
    check('subcategoría nueva disponible', (await page.locator('#f-subcategory option').allTextContents()).includes('Veterinario'));
    await page.selectOption('#f-method', 'Transferencia');
    check('alias nuevo disponible', (await page.locator('#f-account option').allTextContents()).includes('Cuenta Demo 01'));
    await noOverflow(page, 'formulario');
    await shot('formulario', true);
    await tab(page, 'historial');
    check('renombrar categoría actualiza los gastos existentes', (await page.textContent('#h-list')).includes('Comida · Mercado Demo'));
    await shot('historial');

    // --- exportación ---
    await tab(page, 'ajustes');
    const xlsx = await download(page, '#btn-xlsx', 'gastos.xlsx');
    eq('nombre del XLSX', xlsx.suggested, `gastos_${today}.xlsx`);
    const py = spawnSync('python3', ['-c', `
import json, sys, datetime, openpyxl
ws = openpyxl.load_workbook(sys.argv[1]).active
rows = [[c.isoformat() if isinstance(c, (datetime.date, datetime.datetime)) else c for c in r] for r in ws.iter_rows(values_only=True)]
print(json.dumps({"title": ws.title, "rows": rows, "date_is_date": isinstance(ws["A2"].value, datetime.datetime), "freeze": ws.freeze_panes, "filter": ws.auto_filter.ref}))
`, xlsx.file], { encoding: 'utf8' });
    if (py.status !== 0) {
      check('XLSX legible con openpyxl', false, py.stderr.slice(-400));
    } else {
      const x = JSON.parse(py.stdout);
      check('XLSX legible con openpyxl', true);
      eq('XLSX: encabezados', x.rows[0].join('|'), 'Fecha|Concepto|Categoría|Subcategoría|Cantidad|Unidad|Comercio|Medio de pago|Tarjeta o cuenta|Importe|Moneda|Observación|ID|Creado|Actualizado');
      eq('XLSX: una fila por gasto', x.rows.length - 1, 3);
      check('XLSX: fecha como fecha real de Excel', x.date_is_date && x.rows[1][0].startsWith(prev), JSON.stringify(x.rows[1][0]));
      const r = x.rows.find((row) => row[1].startsWith('Compras'));
      eq('XLSX: fila completa', JSON.stringify(r.slice(0, 12)),
        JSON.stringify([`${today}T00:00:00`, 'Compras "semana", varios', 'Comida', 'Supermercado', 1, 'unidad', 'Mercado Demo', 'Tarjeta de crédito', 'Visa BCP', 120, 'PEN', 'Nota <b>de</b> prueba & más']));
      check('XLSX: importe numérico', typeof r[9] === 'number' && typeof x.rows[1][9] === 'number');
      eq('XLSX: encabezado inmovilizado y autofiltro', `${x.freeze} ${x.filter}`, 'A2 A1:O4');
    }
    const csv = await download(page, '#btn-csv', 'gastos.csv');
    const csvText = await readFile(csv.file, 'utf8');
    const csvLines = csvText.trim().split('\r\n');
    check('CSV: BOM UTF-8 y encabezados', csvText.startsWith('﻿Fecha,Concepto,Categoría'));
    eq('CSV: una fila por gasto', csvLines.length - 1, 3);
    check('CSV: comillas y comas escapadas', csvText.includes(`${today},"Compras ""semana"", varios",Comida,Supermercado,1,unidad,Mercado Demo,Tarjeta de crédito,Visa BCP,120,PEN,`), csvLines[2]);

    // --- backup y restauración ---
    const backup = await download(page, '#btn-backup', 'backup.json');
    eq('nombre del backup', backup.suggested, `gastos_backup_${today}.json`);
    const data = JSON.parse(await readFile(backup.file, 'utf8'));
    check('backup: gastos + catálogos', data.format === 'gastos-app-backup' && data.expenses.length === 3 &&
      data.config.categories.some((c) => c.name === 'Mascotas' && c.subs.includes('Veterinario')) &&
      data.config.accounts.includes('Cuenta Demo 01') && data.config.paymentMethods.length === 6);
    await page.waitForFunction(() => document.querySelector('#backup-info').textContent.includes('Último backup'), null, { timeout: 5000 })
      .then(() => check('fecha de último backup visible', true), () => check('fecha de último backup visible', false));

    // se alteran los datos y luego se restaura
    await tab(page, 'historial');
    await page.locator('#h-list .item', { hasText: 'Taxi al centro' }).click();
    await page.click('#btn-delete');
    await page.click('#modal-ok');
    await page.waitForSelector('#view-historial:not([hidden])');
    await tab(page, 'ajustes');
    await page.click('button[aria-label="Eliminar Mascotas"]');
    await page.click('#modal-ok');
    await page.waitForSelector('button[aria-label="Renombrar Mascotas"]', { state: 'detached' });
    await page.setInputFiles('#restore-file', backup.file);
    await page.click('#modal-ok');
    await page.waitForSelector('button[aria-label="Renombrar Mascotas"]');
    check('restauración recupera catálogos', true);
    await tab(page, 'historial');
    eq('restauración recupera gastos', await count(page), 3);
    await page.reload();
    await ready(page);
    await tab(page, 'historial');
    eq('restauración persiste tras recargar', await count(page), 3);

    const bad = path.join(OUT, `${name}-invalido.json`);
    await writeFile(bad, '{"hola": 1}');
    await tab(page, 'ajustes');
    await page.setInputFiles('#restore-file', bad);
    await page.waitForSelector('#toast:not([hidden])');
    check('archivo inválido rechazado sin tocar datos', (await page.textContent('#toast')).includes('no es un backup') && await page.isHidden('#modal'));

    // restauración en un "dispositivo" nuevo (contexto limpio)
    const ctx2 = await browser.newContext(options);
    const page2 = await ctx2.newPage();
    watch(page2);
    await page2.goto(base);
    await ready(page2);
    await tab(page2, 'historial');
    eq('dispositivo nuevo empieza vacío', await count(page2), 0);
    await tab(page2, 'ajustes');
    await page2.setInputFiles('#restore-file', backup.file);
    await page2.click('#modal-ok');
    await page2.waitForSelector('#toast:not([hidden])');
    await tab(page2, 'historial');
    eq('restauración en dispositivo nuevo', await count(page2), 3);
    await tab(page2, 'resumen');
    check('resumen correcto tras restaurar', (await page2.textContent('#summary-body')).includes('S/ 129.00'));

    // hoja de compartir (simulada): la app entrega un File con nombre y tipo correctos
    await page2.evaluate(() => {
      window.__shared = null;
      Object.defineProperty(navigator, 'canShare', { value: (d) => Boolean(d?.files?.length), configurable: true });
      Object.defineProperty(navigator, 'share', { value: async (d) => { window.__shared = { name: d.files[0].name, type: d.files[0].type, size: d.files[0].size }; }, configurable: true });
    });
    await tab(page2, 'ajustes');
    await page2.click('#btn-xlsx');
    await page2.waitForFunction(() => window.__shared);
    const shared = await page2.evaluate(() => window.__shared);
    check('compartir (simulado): archivo XLSX entregado a navigator.share', shared.name === `gastos_${today}.xlsx` && shared.type.includes('spreadsheetml') && shared.size > 1000, JSON.stringify(shared));
    await ctx2.close();

    // --- importación aditiva del histórico (muestra ficticia, dispositivo limpio) ---
    {
      const dir = path.join(ROOT, 'tools', 'historico');
      const fuentes = [];
      for (const n of ['notas-a', 'notas-b']) fuentes.push({ nombre: n, texto: await readFile(path.join(dir, 'muestra', `${n}.txt`), 'utf8') });
      const { archivo } = transformar({ fuentes, reglasRaw: JSON.parse(await readFile(path.join(dir, 'reglas.ejemplo.json'), 'utf8')) });
      const N = archivo.expenses.length;
      const impFile = path.join(OUT, `${name}-import.json`);
      await writeFile(impFile, JSON.stringify(archivo));

      const ctx3 = await browser.newContext(options);
      const p3 = await ctx3.newPage();
      watch(p3);
      await p3.goto(base);
      await ready(p3);
      const toastHas = (text) => p3.waitForFunction((t) => { const el = document.querySelector('#toast'); return !el.hidden && el.textContent.includes(t); }, text, { timeout: 5000 }).then(() => true, () => false);
      const histCount = async () => { await tab(p3, 'historial'); return count(p3); };
      const pick = async (file) => { await tab(p3, 'ajustes'); await p3.setInputFiles('#import-file', file); };

      await addExpense(p3, { amount: '50', concept: 'Gasto previo', category: 'Otros', method: 'Efectivo' });
      await addExpense(p3, { amount: '2.5', concept: 'pan', category: 'Alimentación', method: 'Efectivo', date: `${archivo.source.anio}-03-03` });
      await tab(p3, 'ajustes');
      check('importar: botón Deshacer oculto sin importaciones', await p3.isHidden('#btn-undo-import'));

      // archivo que no es de importación (p. ej. un backup) se rechaza sin tocar datos
      const notImport = path.join(OUT, `${name}-no-import.json`);
      await writeFile(notImport, JSON.stringify({ format: 'gastos-app-backup', expenses: [] }));
      await pick(notImport);
      check('importar: rechaza archivos que no son de importación', await toastHas('no es un archivo de importación') && await p3.isHidden('#modal'));

      // posibles duplicados -> omitir; vista previa -> cancelar
      await pick(impFile);
      await p3.waitForSelector('#modal:not([hidden])');
      eq('importar: avisa de posibles duplicados', await p3.textContent('#modal-title'), 'Posibles duplicados');
      await p3.click('#modal-cancel');
      await p3.waitForFunction(() => document.querySelector('#modal-title').textContent.includes('Importar estos gastos'));
      let msg = await p3.textContent('#modal-message');
      check('importar: vista previa con conteos', msg.includes(`contiene ${N} registros`) && msg.includes(`Se agregarán ${N - 1} gastos`) && msg.includes('Posibles duplicados de gastos ya registrados: 1 (se omiten)') && msg.includes('Tus 2 gastos actuales no se modifican'), msg);
      check('importar: vista previa anuncia catálogos nuevos', msg.includes('Panadería') && msg.includes('Banco Demo'), msg);
      await noOverflow(p3, 'vista previa de importación');
      await shot3();
      await p3.click('#modal-cancel');
      check('importar: cancelar informa', await toastHas('cancelada'));
      eq('importar: cancelar no modifica nada', await histCount(), 2);
      await p3.reload();
      await ready(p3);
      eq('importar: tras cancelar y recargar siguen 2 gastos', await histCount(), 2);

      // importar de verdad
      await pick(impFile);
      await p3.click('#modal-cancel'); // omite el posible duplicado
      await p3.waitForFunction(() => document.querySelector('#modal-title').textContent.includes('Importar estos gastos'));
      await p3.click('#modal-ok');
      check('importar: confirma el resultado', await toastHas(`Importación completada: ${N - 1} gastos`));
      eq('importar: gastos agregados sin perder los existentes', await histCount(), 2 + N - 1);
      await p3.fill('#h-q', 'Gasto previo');
      eq('importar: el gasto previo sigue ahí', await count(p3), 1);
      await p3.fill('#h-q', '');
      await p3.reload();
      await ready(p3);
      eq('importar: persiste tras recargar', await histCount(), 2 + N - 1);
      await tab(p3, 'nuevo');
      await p3.selectOption('#f-category', 'Alimentación');
      const subs = await p3.locator('#f-subcategory option').allTextContents();
      check('importar: subcategorías nuevas añadidas sin quitar las existentes', subs.includes('Panadería') && subs.includes('Supermercado'), subs.join());
      check('importar: medios de pago nuevos disponibles', (await p3.locator('#f-method option').allTextContents()).includes('Vale'));
      await tab(p3, 'resumen');
      for (let i = 0; i < 40 && !(await p3.textContent('#m-label')).includes(`marzo de ${archivo.source.anio}`); i++) await p3.click('#m-prev');
      const sumText = await p3.textContent('#summary-body');
      check('importar: resumen del mes histórico con "Sin categoría" y "Sin medio de pago"', sumText.includes('Sin categoría') && sumText.includes('Sin medio de pago') && sumText.includes('Panadería') === false && sumText.includes('Alimentación'), sumText);

      // reimportar el mismo archivo no duplica
      await pick(impFile);
      await p3.waitForSelector('#modal:not([hidden])');
      await p3.click('#modal-cancel');
      await p3.waitForFunction(() => document.querySelector('#modal-title').textContent.includes('Nada que importar'));
      msg = await p3.textContent('#modal-message');
      check('importar: reimportar detecta todos los duplicados', msg.includes(`Duplicados que se omiten: ${N - 1}`), msg);
      await p3.click('#modal-ok');
      eq('importar: reimportar no duplica', await histCount(), 2 + N - 1);

      // un gasto importado sin medio de pago no recibe uno por defecto al editarlo
      await p3.locator('#h-list .item', { hasText: 'Figuras' }).click();
      eq('editar importado: medio de pago vacío se conserva', await p3.inputValue('#f-method'), '');
      eq('editar importado: cantidad vacía se conserva', await p3.inputValue('#f-quantity'), '');
      await p3.selectOption('#f-category', 'Entretenimiento');
      await p3.click('#btn-save');
      await p3.waitForSelector('#view-historial:not([hidden])');

      // archivo con un registro inválido: se informa y el resto entra
      const mixed = path.join(OUT, `${name}-import-mixto.json`);
      await writeFile(mixed, JSON.stringify({ format: 'gastos-app-import', schemaVersion: 1, expenses: [
        { id: 'demo-1', date: '2025-01-05', concept: 'Válido', amount: 10, currency: 'PEN' },
        { id: 'demo-2', date: '2025-01-05', concept: 'Sin importe', currency: 'PEN' },
        { id: 'demo-3', date: '2025-13-40', concept: 'Fecha mala', amount: 3, currency: 'PEN' },
      ] }));
      await pick(mixed);
      await p3.waitForSelector('#modal:not([hidden])');
      msg = await p3.textContent('#modal-message');
      check('importar: informa rechazados con motivo', msg.includes('Rechazados por datos inválidos: 2') && msg.includes('importe ausente') && msg.includes('fecha ausente o inválida'), msg);
      await p3.click('#modal-cancel');
      eq('importar: cancelar archivo mixto no agrega nada', await histCount(), 2 + N - 1);

      // deshacer: retira lo importado, conserva lo editado y lo previo
      await tab(p3, 'ajustes');
      check('deshacer: información de la última importación', (await p3.textContent('#import-info')).includes(`${N - 1} gastos`));
      await p3.click('#btn-undo-import');
      await p3.click('#modal-cancel');
      eq('deshacer: cancelar no elimina nada', await histCount(), 2 + N - 1);
      await tab(p3, 'ajustes');
      await p3.click('#btn-undo-import');
      msg = await p3.textContent('#modal-message');
      check('deshacer: avisa de los gastos editados que se conservan', msg.includes(`${N - 2} gastos importados`) && msg.includes('1 gasto que editaste'), msg);
      await p3.click('#modal-ok');
      check('deshacer: confirma', await toastHas('Importación deshecha'));
      eq('deshacer: quedan los 2 previos + el editado', await histCount(), 3);
      await p3.reload();
      await ready(p3);
      eq('deshacer: persiste tras recargar', await histCount(), 3);
      await tab(p3, 'ajustes');
      check('deshacer: botón oculto tras deshacer', await p3.isHidden('#btn-undo-import'));

      // volver a cargar tras corregir: entra todo menos lo que ya está
      await pick(impFile);
      await p3.click('#modal-cancel');
      await p3.waitForFunction(() => document.querySelector('#modal-title').textContent.includes('Importar estos gastos'));
      await p3.click('#modal-ok');
      await toastHas('Importación completada');
      eq('reimportar tras deshacer: sin duplicar el editado', await histCount(), 2 + N - 1);
      await ctx3.close();

      async function shot3() {
        const before = errors.length;
        await p3.screenshot({ path: path.join(OUT, `${name}-importar-vista-previa.png`) });
        await p3.waitForTimeout(100);
        const during = errors.splice(before);
        errors.push(...during.filter((e) => !e.includes('Refused to apply a stylesheet')));
      }
    }

    // --- PWA: manifiesto, iconos, service worker ---
    const manifest = await page.evaluate(async () => (await fetch(document.querySelector('link[rel=manifest]').href)).json());
    check('manifiesto: standalone con iconos 192 y 512', manifest.display === 'standalone' && manifest.icons.some((i) => i.sizes === '192x192') && manifest.icons.some((i) => i.sizes === '512x512'));
    const icons = await page.evaluate(async () => {
      const urls = [document.querySelector('link[rel=apple-touch-icon]').href, new URL('icons/icon-192.png', location.href).href, new URL('icons/icon-512.png', location.href).href];
      const sizes = [];
      for (const u of urls) {
        const img = new Image();
        img.src = u;
        await img.decode();
        sizes.push(img.naturalWidth);
      }
      return sizes.join();
    });
    eq('iconos cargan (180, 192, 512)', icons, '180,192,512');

    const hasSW = await page.evaluate(() => 'serviceWorker' in navigator);
    if (!hasSW) {
      check('service worker disponible en este navegador de pruebas', false, 'no soportado: offline NO probado aquí');
    } else {
      await page.evaluate(() => navigator.serviceWorker.ready);
      await page.reload(); // la página pasa a estar controlada por el service worker
      await ready(page);
      check('página controlada por el service worker', await page.evaluate(() => Boolean(navigator.serviceWorker.controller)));
      const cached = await page.evaluate(async () => (await (await caches.open('gastos-v2')).keys()).length);
      check('recursos precargados en caché', cached >= 10, `${cached} entradas`);

      // --- offline real: servidor apagado y red cortada ---
      await new Promise((r) => setTimeout(r, 500)); // deja terminar las revalidaciones en curso
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await ctx.setOffline(true);
      errors.length = 0;
      await page.reload();
      await ready(page);
      check('offline: la app abre sin servidor ni red', true);
      eq('offline: estilos aplicados', await page.evaluate(() => getComputedStyle(document.querySelector('.tabbar')).position), 'fixed');
      await tab(page, 'historial');
      eq('offline: datos disponibles', await count(page), 3);
      await addExpense(page, { amount: '3.20', concept: 'Pan (offline)', category: 'Comida', method: 'Efectivo' });
      await page.reload();
      await ready(page);
      await tab(page, 'historial');
      eq('offline: alta persistida tras recargar', await count(page), 4);
      await tab(page, 'ajustes');
      const offX = await download(page, '#btn-xlsx', 'offline.xlsx');
      check('offline: exportación funciona', (await readFile(offX.file)).length > 1000);
      // los fallos de red del service worker al revalidar sin conexión son esperados
      for (let i = errors.length - 1; i >= 0; i--) if (/Failed to load resource|net::ERR|Could not connect|offline|Load failed/i.test(errors[i])) errors.splice(i, 1);
    }

    // --- pantallas pequeñas ---
    for (const [w, hgt] of [[320, 568], [375, 667]]) {
      await page.setViewportSize({ width: w, height: hgt });
      for (const v of ['nuevo', 'historial', 'resumen', 'ajustes']) {
        await tab(page, v);
        await noOverflow(page, `${v} a ${w}px`);
      }
    }
    await tab(page, 'nuevo');
    await shot('formulario-320', true);
    const small = await page.evaluate(() => [...document.querySelectorAll('#view-nuevo input, #view-nuevo select, #view-nuevo textarea, #view-nuevo .btn:not([hidden]), .tabbar button')]
      .filter((el) => el.offsetParent && (el.getBoundingClientRect().height < 44 || parseFloat(getComputedStyle(el).fontSize) < 16 && !el.closest('.tabbar'))).map((el) => el.id || el.textContent.trim()));
    check('controles táctiles ≥ 44 px y campos ≥ 16 px (sin zoom en iOS)', small.length === 0, small.join());

    check('sin peticiones a otros orígenes', external.length === 0, external.join());
    check('sin errores de consola', errors.length === 0, errors.join(' | '));
  } catch (err) {
    check('ejecución sin excepciones', false, String(err.stack || err).slice(0, 600));
  } finally {
    await browser.close();
    if (server.listening) server.close();
  }
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const want = process.argv.slice(2);
const all = {
  webkit: () => webkit.launch(),
  chrome: () => chromium.launch({ channel: 'chrome' }),
};
for (const [name, launch] of Object.entries(all)) {
  if (!want.length || want.includes(name)) await suite(name, launch);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} comprobaciones correctas`);
for (const f of failed) console.log(`FALLÓ [${f.suite}] ${f.name} — ${f.detail}`);
process.exit(failed.length ? 1 : 0);
