// Capa de persistencia local (IndexedDB). Sin red: todo queda en el dispositivo.
//
// Almacenes:
//   expenses  -> un registro por gasto, keyPath "id"
//   meta      -> pares clave/valor, keyPath "key" (config, lastBackupAt)

const DB_NAME = 'gastos-app';
const DB_VERSION = 1;

let dbPromise;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('expenses')) d.createObjectStore('expenses', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// Ejecuta fn dentro de una transacción y resuelve cuando la transacción termina.
async function run(stores, mode, fn) {
  const d = await openDb();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(stores, mode);
    let out;
    tx.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transacción abortada'));
    out = fn(tx);
  });
}

export const getAllExpenses = () =>
  run('expenses', 'readonly', (tx) => tx.objectStore('expenses').getAll());

export const putExpenses = (list) =>
  run('expenses', 'readwrite', (tx) => {
    const s = tx.objectStore('expenses');
    for (const e of list) s.put(e);
  });

export const putExpense = (e) => putExpenses([e]);

export const deleteExpense = (id) =>
  run('expenses', 'readwrite', (tx) => {
    tx.objectStore('expenses').delete(id);
  });

export async function getMeta(key) {
  const row = await run('meta', 'readonly', (tx) => tx.objectStore('meta').get(key));
  return row ? row.value : undefined;
}

export const setMeta = (key, value) =>
  run('meta', 'readwrite', (tx) => {
    tx.objectStore('meta').put({ key, value });
  });

// Importación aditiva en una sola transacción: agrega gastos, actualiza catálogos y registra
// el lote para poder deshacerlo. Usa add() (no put()): si algún id ya existiera, la transacción
// completa se aborta y no se sobrescribe ni se guarda nada.
export const importBatch = ({ expenses, config, lastImport }) =>
  run(['expenses', 'meta'], 'readwrite', (tx) => {
    const s = tx.objectStore('expenses');
    for (const e of expenses) s.add(e);
    const meta = tx.objectStore('meta');
    meta.put({ key: 'config', value: config });
    meta.put({ key: 'lastImport', value: lastImport });
  });

// Deshace un lote importado: borra solo los ids indicados y olvida el lote, todo o nada.
export const undoImport = (ids) =>
  run(['expenses', 'meta'], 'readwrite', (tx) => {
    const s = tx.objectStore('expenses');
    for (const id of ids) s.delete(id);
    tx.objectStore('meta').delete('lastImport');
  });

// Reemplaza TODO el contenido (restauración de backup) en una sola transacción:
// si algo falla, no queda un estado a medias.
export const replaceAll = ({ config, expenses }) =>
  run(['expenses', 'meta'], 'readwrite', (tx) => {
    const s = tx.objectStore('expenses');
    s.clear();
    for (const e of expenses) s.put(e);
    const meta = tx.objectStore('meta');
    meta.put({ key: 'config', value: config });
    meta.delete('lastImport'); // el lote importado ya no describe los datos restaurados
  });
