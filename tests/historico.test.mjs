// Pruebas de la transformación del histórico y del plan de importación. Solo datos ficticios.
//   node --test tests/historico.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { transformar, reportes, leerImporte, inferirCantidad, leerCorrecciones, nucleo } from '../tools/historico/transformar.mjs';
import { planImport, validateExpense } from '../js/import.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'historico');
const reglasRaw = JSON.parse(await readFile(path.join(DIR, 'reglas.ejemplo.json'), 'utf8'));
const fuentes = [];
for (const n of ['notas-a', 'notas-b']) fuentes.push({ nombre: n, texto: await readFile(path.join(DIR, 'muestra', `${n}.txt`), 'utf8') });
const correr = (correcciones) => transformar({ fuentes, reglasRaw, correcciones, generadoEn: '2025-04-01T00:00:00.000Z' });
const res = correr();
const reg = (ref) => res.registros.find((r) => r.ref === ref);
const CONFIG = { categories: [{ name: 'Alimentación', subs: ['Supermercado'] }], units: ['unidad'], paymentMethods: [{ name: 'Efectivo', usesAccount: false }], accounts: [], merchants: [], currencies: ['PEN'] };

test('importes: original, normalizado, suma, caracteres extra y ausente', () => {
  assert.deepEqual(leerImporte('2.5'), { valor: 2.5, origen: 'original', conf: '', regla: '' });
  assert.equal(leerImporte('4.').origen, 'normalizado');
  assert.equal(leerImporte('9.40').valor, 9.4);
  assert.equal(leerImporte('7 + 2.5').valor, 9.5);
  assert.equal(leerImporte('10 + 5 = 15').valor, 15);
  assert.equal(leerImporte('10 + 5 = 99').conf, 'pendiente');
  assert.equal(leerImporte('24”').conf, 'media');
  assert.equal(leerImporte('').conf, 'pendiente');
  assert.equal(leerImporte('abc').valor, '');
});

test('cantidades: solo lo explícito; lo dudoso queda en baja', () => {
  const q = (c) => { const r = inferirCantidad(c, [/^taxi/]); return r && `${r.q} ${r.unidad} ${r.conf}`; };
  assert.equal(q('Manzana 1/2 kg'), '0.5 kg alta');
  assert.equal(q('Queso 200gr'), '200 g alta');
  assert.equal(q('Arroz, cinco kilos'), '5 kg alta');
  assert.equal(q('Galletas x2'), '2 unidad alta');
  assert.equal(q('3 tomates'), '3 unidad alta');
  assert.equal(q('Tomate 3'), '3 unidad media');
  assert.equal(q('Uva 600'), '600 g media');
  assert.equal(q('Fresa 1/2'), '0.5 kg media');
  assert.equal(q('Carne 3.7'), '3.7  baja');
  assert.equal(q('Manzana x4 500gr'), '500 g media');
  assert.equal(q('Taxi centro 2'), null);
  assert.equal(q('Pan'), null);
  assert.equal(nucleo('Atún x2'), nucleo('Atun 2'));
});

test('el original se conserva y cada inferencia queda identificada', () => {
  const r = reg('notas-a:6');
  assert.equal(r.f.concepto.valor, 'Tomate 3');
  assert.equal(r.f.concepto.origen, 'original');
  assert.equal(r.f.categoria.origen, 'inferido');
  assert.equal(r.f.categoria.conf, 'alta');
  assert.match(r.f.categoria.regla, /tomates/);
  assert.equal(r.f.importe.origen, 'original');
  assert.equal(r.original, 'Tomate 3: 4');
});

test('confianza baja y conceptos desconocidos no se incorporan', () => {
  const fig = reg('notas-a:10');
  assert.equal(fig.f.categoria.valor, '');
  assert.match(fig.sugerencias.join(), /Entretenimiento/);
  assert.equal(reg('notas-a:11').f.categoria.conf, 'pendiente');
  const e = res.archivo.expenses.find((x) => x.concept === 'Figuras');
  assert.equal(e.category, '');
  assert.match(e.note, /Importe original: 7 \+ 2\.5 · Revisar: categoría/);
});

test('fechas: errata de mes corregida con confianza media; fecha imposible queda pendiente', () => {
  assert.equal(reg('notas-a:23').f.fecha.valor, '2025-03-05');
  assert.equal(reg('notas-a:23').f.fecha.conf, 'media');
  assert.equal(reg('notas-b:8').estado, 'pendiente');
  assert.equal(reg('notas-b:9').f.fecha.valor, '2025-03-12');
});

test('campos faltantes: sin fecha, sin importe y no-gastos quedan fuera del archivo', () => {
  for (const ref of ['notas-a:1', 'notas-a:17', 'notas-a:18', 'notas-a:30', 'notas-a:32', 'notas-b:10']) assert.equal(reg(ref).estado, 'pendiente', ref);
  assert.equal(res.archivo.expenses.length, res.registros.filter((r) => r.estado === 'importar').length);
  assert.ok(!res.archivo.expenses.some((e) => /Pago tarjeta|Prestamo|Sin precio/.test(e.concept)));
});

test('medios de pago: normalización, alias de tarjeta y no reconocidos', () => {
  assert.equal(reg('notas-b:1').f.medio.origen, 'original');
  assert.equal(reg('notas-b:2').f.medio.valor, 'Yape');
  assert.equal(reg('notas-b:2').f.medio.conf, 'media');
  assert.equal(reg('notas-b:3').f.cuenta.valor, 'Banco Demo');
  const raro = reg('notas-b:5');
  assert.equal(raro.estado, 'importar');
  assert.equal(raro.f.medio.valor, '');
  assert.equal(reg('notas-b:6').f.medio.conf, 'pendiente');
});

test('categorías y subcategorías del archivo existen en la taxonomía de las reglas', () => {
  for (const e of res.archivo.expenses) {
    if (!e.category) { assert.equal(e.subcategory, ''); continue; }
    const cat = reglasRaw.categorias.find((c) => c.name === e.category);
    assert.ok(cat, e.category);
    if (e.subcategory) assert.ok(cat.subs.includes(e.subcategory), `${e.category}/${e.subcategory}`);
  }
});

test('el archivo generado pasa la validación de la app y es determinista', () => {
  assert.deepEqual(res.validacion, { rechazados: [], duplicados: [] });
  const otra = correr();
  assert.deepEqual(otra.archivo.expenses.map((e) => e.id), res.archivo.expenses.map((e) => e.id));
  assert.equal(new Set(res.archivo.expenses.map((e) => e.id)).size, res.archivo.expenses.length);
});

test('correcciones manuales: prevalecen, pueden rescatar o excluir, y fallan si la ref no existe', () => {
  const fix = leerCorrecciones('ref,campo,valor,comentario\nnotas-a:11,categoria,Vivienda\nnotas-a:11,subcategoria,Hogar\nnotas-a:17,importe,"7,5"\nnotas-a:18,estado,importar\nnotas-a:4,estado,excluir\n');
  const r2 = correr(fix);
  const by = (ref) => r2.registros.find((r) => r.ref === ref);
  assert.equal(by('notas-a:11').f.categoria.origen, 'manual');
  assert.equal(by('notas-a:17').estado, 'importar');
  assert.equal(by('notas-a:17').f.importe.valor, 7.5);
  assert.equal(by('notas-a:18').estado, 'importar');
  assert.equal(by('notas-a:4').estado, 'excluido');
  assert.equal(r2.archivo.expenses.length, res.archivo.expenses.length + 2 - 1);
  assert.throws(() => correr(leerCorrecciones('zzz:1,categoria,X')), /no existen/);
  assert.throws(() => leerCorrecciones('notas-a:4,inventado,X'), /campo desconocido/);
});

test('reportes: trazabilidad por línea y revisión separada', () => {
  const rep = reportes(res);
  const lineas = rep.traza.trim().split('\r\n');
  assert.equal(lineas.length - 1, res.registros.length);
  assert.match(lineas[0], /texto_original,estado,motivo,id,fecha,fecha_origen,fecha_confianza,fecha_regla/);
  assert.match(rep.revision, /1-no importado/);
  assert.match(rep.revision, /3-sin categoría/);
  assert.match(rep.porConcepto, /cosa rara/);
  assert.match(rep.resumen, /Gastos en el archivo de importación: 23/);
});

test('validación de la app: rechaza registros incompletos o inválidos con motivo', () => {
  const ok = { id: 'a1', date: '2025-03-01', concept: 'Pan', amount: 2.5, currency: 'PEN' };
  assert.ok(validateExpense(ok).expense);
  const malo = (patch, re) => assert.match(validateExpense({ ...ok, ...patch }).error, re);
  malo({ date: '2025-02-31' }, /fecha/);
  malo({ date: undefined }, /fecha/);
  malo({ amount: 0 }, /importe/);
  malo({ amount: '2.5' }, /importe/);
  malo({ amount: 1.999 }, /decimales/);
  malo({ concept: '  ' }, /concepto/);
  malo({ id: '' }, /id/);
  malo({ currency: 'soles' }, /moneda/);
  malo({ quantity: -1 }, /cantidad/);
  malo({ subcategory: 'X' }, /subcategoría/);
  malo({ unit: 'kg' }, /unidad/);
  malo({ account: '4111 1111 1111 1111' }, /alias/);
  malo({ note: 5 }, /texto/);
});

test('plan de importación: duplicados, posibles duplicados, rechazados y catálogos; no altera lo existente', () => {
  const existentes = [
    { id: 'manual-1', date: '2025-03-03', concept: 'pan', amount: 2.5, currency: 'PEN', category: 'Alimentación', updatedAt: 'x' },
    { id: res.archivo.expenses[5].id, date: '2025-03-03', concept: 'Taxi centro 2', amount: 12, currency: 'PEN' },
  ];
  const copia = structuredClone(existentes);
  const config = structuredClone(CONFIG);
  const data = structuredClone(res.archivo);
  data.expenses.push({ ...data.expenses[2] }, { id: 'malo', date: 'ayer', concept: 'X', amount: 1, currency: 'PEN' });
  const plan = planImport(data, existentes, config);
  assert.equal(plan.total, 25);
  assert.equal(plan.rejected.length, 1);
  assert.equal(plan.duplicates.length, 2); // ya importado + id repetido en el archivo
  assert.equal(plan.possible.length, 1);   // un "Pan 2.5" coincide con el manual; el otro "Pan 2.5" sí entra
  assert.equal(plan.toImport.length, 21);
  assert.equal(plan.toImport.filter((e) => e.concept === 'Pan' && e.date === '2025-03-03').length, 1);
  assert.deepEqual(existentes, copia);
  assert.deepEqual(config, CONFIG);
  // catálogos: se añade, no se quita
  const alim = plan.mergedConfig.categories.find((c) => c.name === 'Alimentación');
  assert.ok(alim.subs.includes('Supermercado') && alim.subs.includes('Panadería'));
  assert.ok(plan.mergedConfig.paymentMethods.some((m) => m.name === 'Efectivo'));
  assert.equal(plan.mergedConfig.paymentMethods.find((m) => m.name === 'Tarjeta de crédito').usesAccount, true);
  assert.ok(plan.added.accounts.includes('Banco Demo'));
  assert.equal(planImport(data, existentes, config, { includePossible: true }).toImport.length, 22);
  // reimportar todo lo ya importado no agrega nada
  assert.equal(planImport(res.archivo, res.archivo.expenses, config).toImport.length, 0);
  assert.match(planImport({ format: 'otro' }, [], config).error, /no es un archivo de importación/);
  assert.match(planImport({ ...data, schemaVersion: 99 }, [], config).error, /más nueva/);
});
