#!/usr/bin/env node
// Transforma un histórico de gastos escrito a mano (Notas de macOS / iOS) en un archivo
// de importación para la app, más los reportes de trazabilidad y de revisión manual.
//
//   node tools/historico/transformar.mjs \
//     --entrada ../import/Junio-Julio.textClipping ../import/Agosto-a-hoy.textClipping \
//     --reglas ../import/reglas.json --salida ../import/salida [--correcciones ../import/correcciones.csv]
//
// Todo ocurre en local. Los archivos de entrada nunca se modifican. Ver tools/historico/README.md.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { planImport, IMPORT_FORMAT, IMPORT_SCHEMA_VERSION } from '../../js/import.js';

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
const tidy = (s) => String(s ?? '').replace(/[‎‏ ]/g, ' ').trim().replace(/\s+/g, ' ');
const pad = (n) => String(n).padStart(2, '0');
const CONF = ['alta', 'media', 'baja', 'pendiente'];
const APLICA = new Set(['alta', 'media']); // "baja" solo se sugiere, nunca se incorpora

// Campo con trazabilidad. origen: original | normalizado | inferido | manual | ausente
const campo = (valor, origen, conf = '', regla = '') => ({ valor, origen, conf, regla });
const ausente = (regla = 'sin dato en el histórico') => campo('', 'ausente', 'pendiente', regla);

// ---------- lectura de fuentes ----------

// Un .textClipping es un plist con el texto en RTF. Se convierte con utilidades locales de macOS.
export function leerFuente(file) {
  if (!/\.textclipping$/i.test(file)) return readFile(file, 'utf8');
  const xml = execFileSync('plutil', ['-convert', 'xml1', '-o', '-', file], { encoding: 'utf8', maxBuffer: 64e6 });
  const m = xml.match(/<key>public\.rtf<\/key>\s*<(data|string)>([\s\S]*?)<\/\1>/);
  if (!m) throw new Error(`${file}: el recorte no contiene texto RTF`);
  const rtf = m[1] === 'data'
    ? Buffer.from(m[2].replace(/\s+/g, ''), 'base64')
    : Buffer.from(m[2].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'), 'latin1');
  return Promise.resolve(execFileSync('textutil', ['-stdin', '-stdout', '-format', 'rtf', '-convert', 'txt', '-encoding', 'UTF-8'],
    { input: rtf, encoding: 'utf8', maxBuffer: 64e6 }));
}

// ---------- análisis de líneas ----------

const RE_FECHA = /^(\d{1,2})\/(\d{1,2})$/;

// Devuelve las líneas con contenido clasificadas: { tipo: 'gasto' | 'nota', ... }.
// Reconoce los dos formatos del histórico: "Concepto: importe" bajo una línea de fecha,
// y columnas separadas por tabulador (fecha, concepto, medio de pago, importe).
export function parsear(texto, nombre) {
  const items = [];
  let fecha = null; // { txt, linea }
  texto.split(/\r?\n/).forEach((cruda, i) => {
    const linea = i + 1;
    const original = cruda.replace(/[‎‏]/g, '');
    if (!original.trim()) return;
    const base = { ref: `${nombre}:${linea}`, archivo: nombre, linea, original: original.trim(), avisos: [] };

    if (original.includes('\t')) {
      const [c0 = '', c1 = '', c2 = '', ...resto] = original.split('\t');
      const f = c0.trim();
      if (f) {
        if (RE_FECHA.test(f)) fecha = { txt: f, linea };
        else base.avisos.push(`texto "${f}" en la columna de fecha ignorado`);
      }
      items.push({ ...base, tipo: 'gasto', fecha, concepto: tidy(c1), medio: tidy(c2), importe: tidy(resto.join(' ')), separador: 'tab' });
      return;
    }
    const t = original.trim();
    if (/^[—–\-_=*\s]+$/.test(t)) {
      fecha = null; // un separador abre una sección de notas sin fecha
      return;
    }
    let m = t.match(/^(\d{1,2}\/\d{1,2})\s*[:.]?$/);
    if (m) {
      fecha = { txt: m[1], linea };
      return;
    }
    m = t.match(/^(\d{1,2}\/\d{1,2})\s*[:.]\s*(\S.*)$/);
    if (m) {
      fecha = null;
      items.push({ ...base, tipo: 'nota', motivo: 'nota con fecha y texto libre (no es un gasto con formato reconocible)' });
      return;
    }
    m = t.match(/^(.*):([^:]*)$/);
    if (m) {
      items.push({ ...base, tipo: 'gasto', fecha, concepto: tidy(m[1]), medio: '', importe: tidy(m[2]), separador: ':' });
      return;
    }
    m = t.match(/^(.*[^\d\s.])[.\s]\s*(\d+(?:[.,]\d+)?)$/);
    if (m) {
      items.push({ ...base, tipo: 'gasto', fecha, concepto: tidy(m[1]), medio: '', importe: m[2], separador: 'ninguno' });
      return;
    }
    items.push({ ...base, tipo: 'gasto', fecha, concepto: tidy(t), medio: '', importe: '', separador: 'ninguno' });
  });
  return items;
}

// ---------- fechas ----------

function iso(anio, dia, mes) {
  const d = new Date(Date.UTC(anio, mes - 1, dia));
  return d.getUTCFullYear() === anio && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia ? `${anio}-${pad(mes)}-${pad(dia)}` : '';
}

// Resuelve cada encabezado de fecha de un archivo. Una fecha fuera de secuencia (p. ej. "28/8"
// entre 28/7 y 29/7) se corrige solo si existe una única alternativa que encaje entre sus vecinas.
function resolverFechas(items, anio) {
  const encabezados = [...new Map(items.filter((i) => i.fecha).map((i) => [i.fecha.linea, i.fecha])).values()];
  const base = encabezados.map((h) => {
    const [d, m] = h.txt.split('/').map(Number);
    return { h, d, m, iso: iso(anio, d, m) };
  });
  const out = new Map();
  base.forEach((b, k) => {
    const regAnio = `día/mes del histórico; año ${anio} indicado en las reglas`;
    const prev = base.slice(0, k).reverse().find((x) => x.iso && out.get(x.h.linea)?.conf !== 'pendiente');
    const prevIso = prev ? out.get(prev.h.linea).valor : '';
    const next = base.slice(k + 1).find((x) => x.iso && (!prevIso || x.iso >= prevIso));
    const fits = (v) => v && (!prevIso || v >= prevIso) && (!next || v <= next.iso);
    if (b.iso && fits(b.iso)) return out.set(b.h.linea, campo(b.iso, 'normalizado', 'alta', regAnio));
    const alternativas = [...new Set([prev && iso(anio, b.d, prev.m), next && iso(anio, b.d, next.m)].filter(fits))];
    if (alternativas.length === 1) {
      return out.set(b.h.linea, campo(alternativas[0], 'inferido', 'media',
        `"${b.h.txt}" está fuera de secuencia (entre ${prev?.h.txt ?? 'inicio'} y ${next?.h.txt ?? 'fin'}): se asume errata en el mes`));
    }
    if (b.iso) return out.set(b.h.linea, campo(b.iso, 'normalizado', 'baja', `"${b.h.txt}" está fuera de secuencia y no hay una corrección única`));
    return out.set(b.h.linea, campo('', 'ausente', 'pendiente', `"${b.h.txt}" no es una fecha válida`));
  });
  return out;
}

// ---------- importe ----------

const num = (s) => Number(String(s).replace(',', '.'));
const RE_NUM = /^\d+(?:[.,]\d*)?$|^[.,]\d+$/;

export function leerImporte(txt) {
  const t = tidy(txt);
  if (!t) return ausente('sin importe en el histórico');
  if (RE_NUM.test(t)) {
    const v = Math.round(num(t.replace(/[.,]$/, '')) * 100) / 100;
    return String(v) === t ? campo(v, 'original') : campo(v, 'normalizado', 'alta', `formato numérico ("${t}")`);
  }
  const partes = t.split('=').map((p) => p.trim());
  const sumandos = partes[0].split('+').map((p) => p.trim());
  if (sumandos.length > 1 && sumandos.every((p) => RE_NUM.test(p))) {
    const suma = Math.round(sumandos.reduce((a, p) => a + num(p), 0) * 100) / 100;
    if (partes.length === 1) return campo(suma, 'normalizado', 'alta', `suma de los importes anotados (${t})`);
    if (partes.length === 2 && RE_NUM.test(partes[1]) && Math.abs(num(partes[1]) - suma) < 0.005) {
      return campo(suma, 'normalizado', 'alta', `total anotado (${t})`);
    }
  }
  const m = t.match(/^(\d+(?:[.,]\d+)?)\s*[^\d\s.,+=]{1,2}$/);
  if (m) return campo(Math.round(num(m[1]) * 100) / 100, 'normalizado', 'media', `importe con caracteres extra ("${t}")`);
  return campo('', 'ausente', 'pendiente', `importe ilegible ("${t}")`);
}

// ---------- cantidad y unidad ----------

const PALABRAS = { un: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10 };
const frac = (a, b) => Math.round((Number(a) / Number(b)) * 1000) / 1000;

// Devuelve { q, unidad, conf, regla } o null. Solo usa lo que el concepto dice de forma explícita.
export function inferirCantidad(concepto, sinCantidad = []) {
  const t = norm(concepto);
  if (sinCantidad.some((re) => re.test(t))) return null;
  const cuenta = t.match(/\bx ?(\d{1,3})\b/) || t.match(/\b(\d{1,3}) ?(?:un|und|unid|unidades)\b/) || t.match(/^(\d{1,3}) +[a-z]/);

  let m = t.match(/(\d+\/\d+|\d+(?:[.,]\d+)?) ?(kg|kilos?|gramos|grs?|g)\b/);
  if (m) {
    const q = m[1].includes('/') ? frac(...m[1].split('/')) : num(m[1]);
    const unidad = m[2].startsWith('k') ? 'kg' : 'g';
    const tambien = cuenta || t.match(/ (\d{1,2}) +\d/) || t.match(/ (\d{1,2}) +\(/);
    return tambien
      ? { q, unidad, conf: 'media', regla: `peso explícito; el concepto también indica ${tambien[1]} unidades (se conserva el peso)` }
      : { q, unidad, conf: 'alta', regla: 'peso explícito en el concepto' };
  }
  m = t.match(/\b(un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez) kilos?\b/);
  if (m) return { q: PALABRAS[m[1]], unidad: 'kg', conf: 'alta', regla: 'peso escrito en palabras' };
  if (cuenta) return { q: Number(cuenta[1]), unidad: 'unidad', conf: 'alta', regla: 'número de unidades explícito' };
  m = t.match(/^(dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\b/);
  if (m) return { q: PALABRAS[m[1]], unidad: 'unidad', conf: 'media', regla: 'número de unidades escrito en palabras' };
  m = t.match(/^(\d+)\/(\d+) +[a-z]/);
  if (m) return { q: frac(m[1], m[2]), unidad: 'unidad', conf: 'media', regla: 'fracción al inicio del concepto: se asume fracción de unidad' };
  m = t.match(/\((\d{1,2})\)/);
  if (m) return { q: Number(m[1]), unidad: 'unidad', conf: 'media', regla: 'número entre paréntesis: se asume número de unidades' };
  m = t.match(/ (\d+)\/(\d+)$/);
  if (m) return { q: frac(m[1], m[2]), unidad: 'kg', conf: 'media', regla: 'fracción sin unidad al final: se asume kg' };
  if (/\bpaq\b/.test(t)) return { q: 1, unidad: 'paquete', conf: 'media', regla: '"PAQ": se asume 1 paquete' };
  m = t.match(/ (\d+)$/);
  if (m) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 24) return { q: n, unidad: 'unidad', conf: 'media', regla: 'número al final del concepto: se asume número de unidades' };
    if (n >= 100) return { q: n, unidad: 'g', conf: 'media', regla: 'número ≥ 100 al final sin unidad: se asume gramos' };
    return { q: n, unidad: '', conf: 'baja', regla: 'número al final sin unidad reconocible' };
  }
  m = t.match(/ (\d+[.,]\d+)$/);
  if (m) return { q: num(m[1]), unidad: '', conf: 'baja', regla: 'número decimal al final sin unidad' };
  return null;
}

// Concepto sin cantidades, para agrupar la revisión ("Atún 2", "Atún x2" → "atun").
export function nucleo(concepto) {
  return norm(concepto)
    .replace(/\(.*?\)/g, ' ')
    .replace(/(\d+\/\d+|\d+(?:[.,]\d+)?) ?(kg|kilos?|gramos|grs?|g|un|und)\b\.?/g, ' ')
    .replace(/\bx ?\d+\b/g, ' ').replace(/\b\d+\/\d+\b/g, ' ').replace(/\b\d+([.,]\d+)?\b/g, ' ')
    .replace(/[.,;]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// ---------- reglas ----------

export function prepararReglas(raw) {
  const re = (s) => new RegExp(s, 'u');
  const conf = (c, ctx) => {
    if (!CONF.includes(c)) throw new Error(`Reglas: confianza inválida "${c}" en ${ctx}`);
    return c;
  };
  const r = {
    anio: Number(raw.anio),
    marcarRevisionEnNota: raw.marcarRevisionEnNota !== false,
    moneda: { codigo: raw.moneda.codigo, conf: conf(raw.moneda.confianza, 'moneda'), razon: raw.moneda.razon || '' },
    monedaDudosa: (raw.monedaDudosa || []).map((x) => ({ re: re(x.si), razon: x.razon || '' })),
    medios: new Map(Object.entries(raw.mediosDePago || {}).map(([k, v]) => [norm(k), v])),
    categorias: raw.categorias || [],
    reglas: (raw.reglas || []).map((x, i) => ({ ...x, re: re(x.si), conf: conf(x.conf, `reglas[${i}] (${x.si})`) })),
    comercios: (raw.comercios || []).map((x, i) => ({ ...x, re: re(x.si), conf: conf(x.conf, `comercios[${i}]`) })),
    noGasto: (raw.noGasto || []).map((x) => ({ re: re(x.si), razon: x.razon || 'marcado como no-gasto en las reglas', confirmado: x.confirmado === true })),
    sinCantidad: (raw.sinCantidad || []).map(re),
  };
  if (!Number.isInteger(r.anio)) throw new Error('Reglas: falta "anio" (el histórico no indica el año).');
  for (const x of r.reglas) {
    const cat = r.categorias.find((c) => c.name === x.cat);
    if (!cat) throw new Error(`Reglas: la categoría "${x.cat}" (regla ${x.si}) no está en "categorias".`);
    if (x.sub && !cat.subs.includes(x.sub)) throw new Error(`Reglas: la subcategoría "${x.cat} / ${x.sub}" (regla ${x.si}) no está en "categorias".`);
  }
  return r;
}

export function leerCsv(texto) {
  const filas = [];
  let fila = [];
  let celda = '';
  let q = false;
  const t = texto.replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"' && t[i + 1] === '"') { celda += '"'; i++; } else if (c === '"') q = false; else celda += c;
    } else if (c === '"') q = true;
    else if (c === ',') { fila.push(celda); celda = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      fila.push(celda); celda = '';
      if (fila.some((x) => x.trim())) filas.push(fila);
      fila = [];
    } else celda += c;
  }
  fila.push(celda);
  if (fila.some((x) => x.trim())) filas.push(fila);
  return filas;
}

const CAMPOS_CORREGIBLES = ['fecha', 'categoria', 'subcategoria', 'cantidad', 'unidad', 'comercio', 'medio', 'cuenta', 'importe', 'moneda', 'nota', 'estado'];

// correcciones.csv: ref,campo,valor[,comentario]
export function leerCorrecciones(texto) {
  const map = new Map();
  const filas = leerCsv(texto);
  for (const [k, f] of filas.entries()) {
    const [ref, c, valor = ''] = f.map((x) => x.trim());
    if (k === 0 && norm(ref) === 'ref') continue;
    if (!CAMPOS_CORREGIBLES.includes(c)) throw new Error(`Correcciones: campo desconocido "${c}" (ref ${ref}). Válidos: ${CAMPOS_CORREGIBLES.join(', ')}`);
    if (!map.has(ref)) map.set(ref, {});
    map.get(ref)[c] = valor;
  }
  return map;
}

// ---------- transformación ----------

// fuentes: [{ nombre, texto }]  ·  reglasRaw: contenido de reglas.json  ·  correcciones: Map de leerCorrecciones
export function transformar({ fuentes, reglasRaw, correcciones = new Map(), generadoEn = new Date().toISOString() }) {
  const R = prepararReglas(reglasRaw);
  const registros = [];
  const usadas = new Set();

  for (const fuente of fuentes) {
    const items = parsear(fuente.texto, fuente.nombre);
    const fechas = resolverFechas(items, R.anio);
    for (const it of items) {
      const reg = { ref: it.ref, archivo: it.archivo, linea: it.linea, original: it.original, avisos: [...it.avisos], sugerencias: [], motivos: [], estado: 'importar', f: {} };
      registros.push(reg);
      const f = reg.f;
      if (it.tipo === 'nota') {
        reg.estado = 'pendiente';
        reg.motivos.push(it.motivo);
        for (const k of ['fecha', 'concepto', 'categoria', 'subcategoria', 'cantidad', 'unidad', 'comercio', 'medio', 'cuenta', 'importe', 'moneda', 'nota']) f[k] = campo('', '', '', '');
        continue;
      }
      const t = norm(it.concepto);

      f.fecha = it.fecha ? { ...fechas.get(it.fecha.linea) } : ausente('la línea no está bajo ninguna fecha (sección de notas o inicio del archivo)');
      if (f.fecha.conf === 'baja') {
        reg.sugerencias.push(`fecha ${f.fecha.valor}: ${f.fecha.regla}`);
        f.fecha = campo('', 'ausente', 'pendiente', f.fecha.regla);
      }
      f.concepto = it.concepto ? campo(it.concepto, 'original') : ausente('sin concepto');
      f.importe = leerImporte(it.importe);
      if (it.separador === 'ninguno' && f.importe.valor !== '') {
        f.importe = campo(f.importe.valor, 'normalizado', 'media', 'línea sin separador ":" — se toma el número final como importe');
      }

      // categoría / subcategoría
      const regla = R.reglas.find((x) => x.re.test(t));
      if (regla && APLICA.has(regla.conf)) {
        const razon = `regla /${regla.si}/${regla.razon ? ` — ${regla.razon}` : ''}`;
        f.categoria = campo(regla.cat, 'inferido', regla.conf, razon);
        f.subcategoria = regla.sub ? campo(regla.sub, 'inferido', regla.conf, razon) : ausente('la regla no define subcategoría');
      } else {
        if (regla) reg.sugerencias.push(`categoría ${regla.cat}${regla.sub ? ` / ${regla.sub}` : ''} (confianza ${regla.conf}${regla.razon ? `: ${regla.razon}` : ''})`);
        f.categoria = ausente(regla ? `solo hay una sugerencia de confianza ${regla.conf}` : 'ninguna regla reconoce el concepto');
        f.subcategoria = ausente(f.categoria.regla);
      }

      // cantidad y unidad
      const c = inferirCantidad(it.concepto, R.sinCantidad);
      if (c && APLICA.has(c.conf)) {
        f.cantidad = campo(c.q, 'inferido', c.conf, c.regla);
        f.unidad = campo(c.unidad, 'normalizado', c.conf, c.regla);
      } else {
        if (c) reg.sugerencias.push(`cantidad ${c.q}${c.unidad ? ` ${c.unidad}` : ''} (confianza baja: ${c.regla})`);
        f.cantidad = ausente('el concepto no indica cantidad');
        f.unidad = ausente('el concepto no indica cantidad');
      }

      // comercio: solo si una regla lo declara explícito
      const com = R.comercios.find((x) => x.re.test(t));
      if (com && APLICA.has(com.conf)) f.comercio = campo(com.comercio, 'inferido', com.conf, `regla /${com.si}/: el concepto nombra el comercio`);
      else {
        if (com) reg.sugerencias.push(`comercio ${com.comercio} (confianza baja)`);
        f.comercio = ausente('el concepto no nombra un comercio de forma inequívoca');
      }

      // medio de pago y tarjeta/cuenta
      if (!it.medio) {
        f.medio = ausente('sin medio de pago en el histórico');
        f.cuenta = ausente('sin medio de pago en el histórico');
      } else {
        const mp = R.medios.get(norm(it.medio));
        if (!mp) {
          f.medio = campo('', 'ausente', 'pendiente', `medio de pago "${it.medio}" no reconocido por las reglas`);
          f.cuenta = ausente(`medio de pago "${it.medio}" no reconocido`);
          reg.avisos.push(`medio de pago "${it.medio}" no reconocido: queda vacío`);
        } else {
          const rz = `"${it.medio}"${mp.razon ? ` — ${mp.razon}` : ''}`;
          if (mp.medio && APLICA.has(mp.medioConf)) f.medio = campo(mp.medio, mp.medio === it.medio ? 'original' : 'normalizado', mp.medio === it.medio ? '' : mp.medioConf, rz);
          else {
            if (mp.medio) reg.sugerencias.push(`medio de pago ${mp.medio} (confianza ${mp.medioConf})`);
            f.medio = campo('', 'ausente', 'pendiente', `"${it.medio}" no determina el medio de pago`);
          }
          f.cuenta = mp.cuenta && APLICA.has(mp.cuentaConf) ? campo(mp.cuenta, 'normalizado', mp.cuentaConf, rz) : campo('', 'ausente', '', 'el medio de pago no usa tarjeta/cuenta');
        }
      }

      // moneda
      const dud = R.monedaDudosa.find((x) => x.re.test(t));
      f.moneda = campo(R.moneda.codigo, 'inferido', dud ? 'media' : R.moneda.conf, dud ? `${R.moneda.razon}; dudosa: ${dud.razon}` : R.moneda.razon);

      // nota: solo conserva información original que no cabe en otro campo
      f.nota = f.importe.origen === 'normalizado' && /suma|total/.test(f.importe.regla)
        ? campo(`Importe original: ${tidy(it.importe)}`, 'original', '', 'desglose del importe tal como estaba anotado')
        : campo('', 'ausente', '', '');

      const ng = R.noGasto.find((x) => x.re.test(t));
      if (ng && ng.confirmado) {
        // No-gasto confirmado por el usuario en las reglas: exclusión justificada, no pendiente.
        reg.estado = 'excluido';
        reg.motivos = [`exclusión justificada (no es un gasto): ${ng.razon}`];
      } else if (ng) {
        reg.estado = 'pendiente';
        reg.motivos.push(`posible no-gasto: ${ng.razon}`);
      }

      // correcciones manuales (siempre prevalecen)
      const fix = correcciones.get(it.ref);
      if (fix) {
        usadas.add(it.ref);
        for (const [k, v] of Object.entries(fix)) {
          if (k === 'estado') continue;
          const valor = k === 'importe' || k === 'cantidad' ? (v === '' ? '' : num(v)) : v;
          if ((k === 'importe' || k === 'cantidad') && valor !== '' && !Number.isFinite(valor)) throw new Error(`Correcciones: ${it.ref} ${k} "${v}" no es un número`);
          f[k] = campo(valor, 'manual', 'alta', 'corrección manual (correcciones.csv)');
        }
        if (fix.estado === 'excluir') {
          reg.estado = 'excluido';
          reg.motivos = ['excluido manualmente (correcciones.csv)'];
        } else if (fix.estado === 'importar') {
          reg.estado = 'importar';
          reg.motivos = reg.motivos.filter((m) => !/no-gasto|no es un gasto/.test(m));
        }
      }
      if (reg.estado === 'excluido') continue;

      // lo que impide importar
      if (!f.fecha.valor) reg.motivos.push(`sin fecha: ${f.fecha.regla}`);
      if (!f.concepto.valor) reg.motivos.push('sin concepto');
      if (f.importe.valor === '' || !(f.importe.valor > 0)) reg.motivos.push(f.importe.regla || 'sin importe');
      if (reg.motivos.length) reg.estado = 'pendiente';
    }
  }

  const sinUsar = [...correcciones.keys()].filter((k) => !usadas.has(k));
  if (sinUsar.length) throw new Error(`Correcciones: referencias que no existen en el histórico: ${sinUsar.join(', ')}`);

  // gastos importables, en el orden original
  const base = Date.parse(generadoEn);
  const ocurrencias = new Map();
  const expenses = [];
  for (const reg of registros.filter((r) => r.estado === 'importar')) {
    const f = reg.f;
    const cents = Math.round(f.importe.valor * 100);
    const clave = `${f.fecha.valor}|${norm(f.concepto.valor)}|${cents}`;
    const k = ocurrencias.get(clave) || 0;
    ocurrencias.set(clave, k + 1);
    // Identificador determinista: volver a generar e importar el mismo histórico no duplica nada.
    reg.id = 'hist-' + createHash('sha256').update(`${clave}|${k}`).digest('hex').slice(0, 24);

    const revisar = [];
    if (!f.categoria.valor) revisar.push('categoría');
    if (f.fecha.conf === 'media') revisar.push('fecha');
    if (f.importe.conf === 'media') revisar.push('importe');
    reg.revisar = revisar;
    let nota = f.nota.valor;
    if (R.marcarRevisionEnNota && revisar.length) {
      nota = [nota, `Revisar: ${revisar.join(', ')}`].filter(Boolean).join(' · ');
      f.nota = campo(nota, f.nota.valor ? 'original' : 'inferido', '', 'marca de revisión añadida por la transformación');
    }
    const tieneCantidad = f.cantidad.valor !== '';
    expenses.push({
      id: reg.id, date: f.fecha.valor, concept: f.concepto.valor,
      category: f.categoria.valor, subcategory: f.categoria.valor ? f.subcategoria.valor : '',
      quantity: tieneCantidad ? f.cantidad.valor : null, unit: tieneCantidad ? f.unidad.valor : '',
      merchant: f.comercio.valor, paymentMethod: f.medio.valor, account: f.cuenta.valor,
      amount: cents / 100, currency: f.moneda.valor, note: nota.slice(0, 300),
      createdAt: new Date(base + expenses.length).toISOString(),
    });
  }

  // catálogo que el archivo necesita (la app solo añade lo que falte)
  const usados = (k) => [...new Set(expenses.map((e) => e[k]).filter(Boolean))];
  const catalog = {
    categories: R.categorias
      .map((c) => ({ name: c.name, subs: c.subs.filter((s) => expenses.some((e) => e.category === c.name && e.subcategory === s)) }))
      .filter((c) => expenses.some((e) => e.category === c.name)),
    units: usados('unit'),
    paymentMethods: usados('paymentMethod').map((name) => ({ name, usesAccount: expenses.some((e) => e.paymentMethod === name && e.account) })),
    accounts: usados('account'),
    merchants: usados('merchant'),
    currencies: usados('currency'),
  };
  const archivo = {
    format: IMPORT_FORMAT, schemaVersion: IMPORT_SCHEMA_VERSION, generatedAt: generadoEn,
    source: { tipo: 'historico-manual', archivos: fuentes.map((x) => x.nombre), anio: R.anio },
    catalog, expenses,
  };

  // validación con las mismas reglas que aplicará la app
  const plan = planImport(archivo, [], { categories: [], units: [], paymentMethods: [], accounts: [], merchants: [], currencies: [] });
  if (plan.error) throw new Error(`El archivo generado no es válido: ${plan.error}`);
  const validacion = { rechazados: plan.rejected, duplicados: plan.duplicates };

  return { archivo, registros, validacion, reglas: R };
}

// ---------- reportes ----------

const CAMPOS = ['fecha', 'concepto', 'categoria', 'subcategoria', 'cantidad', 'unidad', 'comercio', 'medio', 'cuenta', 'importe', 'moneda', 'nota'];
const csvCell = (v) => (/[",\r\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
const toCsv = (rows) => '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
const money = (n) => (Math.round(n * 100) / 100).toFixed(2);

export function reportes({ archivo, registros, validacion, reglas }) {
  const visibles = (r) => (r.original.includes('\t') ? r.original.replace(/\t/g, ' | ') : r.original);

  // 1) trazabilidad completa: una fila por línea del histórico
  const traza = [['ref', 'archivo', 'linea', 'texto_original', 'estado', 'motivo', 'id',
    ...CAMPOS.flatMap((c) => [c, `${c}_origen`, `${c}_confianza`, `${c}_regla`]), 'sugerencias_no_aplicadas', 'avisos']];
  for (const r of registros) {
    traza.push([r.ref, r.archivo, r.linea, visibles(r), r.estado, r.motivos.join(' | '), r.id || '',
      ...CAMPOS.flatMap((c) => [r.f[c].valor, r.f[c].origen, r.f[c].conf, r.f[c].regla]), r.sugerencias.join(' | '), r.avisos.join(' | ')]);
  }

  // 2) revisión manual: lo que no se importa, lo que se importa incompleto y lo que conviene verificar
  const rev = [['ref', 'gravedad', 'que_revisar', 'texto_original', 'fecha', 'concepto', 'importe', 'sugerencia']];
  for (const r of registros) {
    const f = r.f;
    const fila = (grav, que) => rev.push([r.ref, grav, que, visibles(r), f.fecha.valor, f.concepto.valor, f.importe.valor, r.sugerencias.join(' | ')]);
    if (r.estado === 'pendiente') fila('1-no importado', r.motivos.join(' | '));
    if (r.estado !== 'importar') continue;
    if (f.fecha.conf === 'media') fila('2-verificar', `fecha inferida ${f.fecha.valor}: ${f.fecha.regla}`);
    if (f.importe.conf === 'media') fila('2-verificar', `importe ${f.importe.valor}: ${f.importe.regla}`);
    if (f.moneda.conf === 'media') fila('2-verificar', `moneda ${f.moneda.valor}: ${f.moneda.regla}`);
    if (!f.categoria.valor) fila('3-sin categoría', f.categoria.regla);
    for (const a of r.avisos) fila('2-verificar', a);
  }

  // 3) conceptos sin categoría agrupados: una regla nueva resuelve todo el grupo
  const grupos = new Map();
  for (const r of registros.filter((x) => x.estado === 'importar' && !x.f.categoria.valor)) {
    const k = nucleo(r.f.concepto.valor) || norm(r.f.concepto.valor);
    const g = grupos.get(k) || { n: 0, total: 0, sug: new Set(), refs: [] };
    g.n++;
    g.total += r.f.importe.valor;
    r.sugerencias.filter((s) => s.startsWith('categoría')).forEach((s) => g.sug.add(s));
    g.refs.push(r.ref);
    grupos.set(k, g);
  }
  const porConcepto = [['concepto_agrupado', 'registros', 'importe_total', 'sugerencia', 'refs'],
    ...[...grupos].sort((a, b) => b[1].n - a[1].n || b[1].total - a[1].total)
      .map(([k, g]) => [k, g.n, money(g.total), [...g.sug].join(' | '), g.refs.slice(0, 8).join(' ') + (g.refs.length > 8 ? ' …' : '')])];

  // 4) resumen
  const imp = registros.filter((r) => r.estado === 'importar');
  const cuenta = (pred) => imp.filter(pred).length;
  const total = imp.reduce((n, r) => n + Math.round(r.f.importe.valor * 100), 0) / 100;
  const porCat = new Map();
  for (const r of imp) {
    const k = r.f.categoria.valor ? `${r.f.categoria.valor} / ${r.f.subcategoria.valor || '—'}` : '(sin categoría)';
    const g = porCat.get(k) || { n: 0, t: 0 };
    g.n++;
    g.t += r.f.importe.valor;
    porCat.set(k, g);
  }
  const confDe = (c) => CONF.map((k) => `${k} ${cuenta((r) => (r.f[c].conf || (r.f[c].origen === 'original' ? 'original' : '')) === k)}`).join(' · ');
  const fechas = imp.map((r) => r.f.fecha.valor).sort();
  const md = [
    '# Resumen de la transformación del histórico', '',
    `Generado: ${archivo.generatedAt}  ·  Año aplicado: ${reglas.anio}  ·  Fuentes: ${archivo.source.archivos.join(', ')}`, '',
    '> Contiene datos personales. No mover a una carpeta versionada ni publicada.', '',
    '## Totales', '',
    `- Líneas con contenido analizadas: ${registros.length}`,
    `- Gastos en el archivo de importación: ${imp.length} (${fechas[0] || '—'} a ${fechas.at(-1) || '—'}), total ${reglas.moneda.codigo} ${money(total)}`,
    `- No importados (pendientes de revisión): ${registros.filter((r) => r.estado === 'pendiente').length}`,
    `- Excluidos con justificación (no son gastos o exclusión manual): ${registros.filter((r) => r.estado === 'excluido').length}`,
    ...registros.filter((r) => r.estado === 'excluido').map((r) => `  - ${r.ref} — ${r.motivos.join(' | ')}`),
    `- Validación con las reglas de la app: ${validacion.rechazados.length} rechazados, ${validacion.duplicados.length} duplicados`, '',
    '## Confianza por campo (gastos importables)', '',
    `- Fecha: ${confDe('fecha')}`,
    `- Categoría: ${confDe('categoria')}`,
    `- Cantidad: ${confDe('cantidad')}`,
    `- Comercio: ${confDe('comercio')}`,
    `- Medio de pago: original ${cuenta((r) => r.f.medio.origen === 'original')} · ${confDe('medio')}`,
    `- Importe: original ${cuenta((r) => r.f.importe.origen === 'original')} · ${confDe('importe')}`, '',
    '"pendiente" significa que el campo queda vacío en la app. Los valores de confianza baja nunca se incorporan: aparecen como sugerencia en los reportes.', '',
    '## Gastos por categoría / subcategoría', '',
    '| Categoría / subcategoría | Registros | Importe |', '|---|---:|---:|',
    ...[...porCat].sort((a, b) => a[0].localeCompare(b[0], 'es')).map(([k, g]) => `| ${k} | ${g.n} | ${money(g.t)} |`), '',
    '## Archivos', '',
    '- `gastos_import_historico.json`: archivo para Ajustes > Importar gastos.',
    '- `reporte_transformacion.csv`: trazabilidad completa (original, valor final, origen, confianza y regla por campo).',
    '- `revision_manual.csv`: registros no importados, por verificar o sin categoría.',
    '- `revision_por_concepto.csv`: conceptos sin categoría agrupados (una regla resuelve cada grupo).', '',
  ].join('\n');

  return { traza: toCsv(traza), revision: toCsv(rev), porConcepto: toCsv(porConcepto), resumen: md, filasRevision: rev.length - 1, grupos: grupos.size };
}

// ---------- línea de comandos ----------

async function main(argv) {
  const args = { entrada: [] };
  let key = null;
  for (const a of argv) {
    if (a.startsWith('--')) { key = a.slice(2); if (key !== 'entrada') args[key] = true; } else if (key === 'entrada') args.entrada.push(a); else if (key) { args[key] = a; key = null; }
  }
  if (!args.entrada.length || typeof args.reglas !== 'string' || typeof args.salida !== 'string') {
    console.error('Uso: node tools/historico/transformar.mjs --entrada <archivo…> --reglas <reglas.json> --salida <carpeta> [--correcciones <csv>]');
    process.exit(2);
  }
  // Los resultados contienen datos personales: nunca dentro de una carpeta que git pueda versionar.
  const salida = path.resolve(args.salida);
  if (!args['permitir-salida-versionada']) {
    let dentroDeRepo = false;
    let ignorada = false;
    try {
      const dir = existsSync(salida) ? salida : path.dirname(salida);
      execFileSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { stdio: 'pipe' });
      dentroDeRepo = true;
      execFileSync('git', ['-C', dir, 'check-ignore', '-q', path.join(salida, 'x')], { stdio: 'pipe' });
      ignorada = true;
    } catch { /* fuera de un repositorio, o no ignorada */ }
    if (dentroDeRepo && !ignorada) {
      console.error(`ERROR: ${salida} está dentro de un repositorio git y no está en .gitignore. No se escribe nada.`);
      process.exit(2);
    }
  }
  const fuentes = [];
  for (const file of args.entrada) fuentes.push({ nombre: path.basename(file).replace(/\.[^.]+$/, ''), texto: await leerFuente(file) });
  const reglasRaw = JSON.parse(await readFile(args.reglas, 'utf8'));
  const correcciones = typeof args.correcciones === 'string' && existsSync(args.correcciones)
    ? leerCorrecciones(await readFile(args.correcciones, 'utf8')) : new Map();

  const res = transformar({ fuentes, reglasRaw, correcciones });
  const rep = reportes(res);
  await mkdir(salida, { recursive: true });
  await writeFile(path.join(salida, 'gastos_import_historico.json'), JSON.stringify(res.archivo, null, 2));
  await writeFile(path.join(salida, 'reporte_transformacion.csv'), rep.traza);
  await writeFile(path.join(salida, 'revision_manual.csv'), rep.revision);
  await writeFile(path.join(salida, 'revision_por_concepto.csv'), rep.porConcepto);
  await writeFile(path.join(salida, 'resumen.md'), rep.resumen);

  const n = (e) => res.registros.filter((r) => r.estado === e).length;
  console.log(`Líneas analizadas: ${res.registros.length} · importables: ${n('importar')} · pendientes: ${n('pendiente')} · excluidas: ${n('excluido')}`);
  console.log(`Validación de la app: ${res.validacion.rechazados.length} rechazados, ${res.validacion.duplicados.length} duplicados`);
  console.log(`Filas en revisión manual: ${rep.filasRevision} · conceptos sin categoría: ${rep.grupos}`);
  console.log(`Correcciones aplicadas: ${correcciones.size}`);
  console.log(`Resultados en: ${salida}`);
  if (res.validacion.rechazados.length) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  });
}
