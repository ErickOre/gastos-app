// Service worker: hace que la app funcione sin conexión.
//
// Estrategia "stale-while-revalidate" sobre el propio origen:
//   - responde de inmediato desde la caché (funciona offline y abre rápido);
//   - en segundo plano descarga la versión nueva y la deja lista para la siguiente apertura.
// Por eso, tras publicar cambios, la app se actualiza al abrirla por segunda vez con conexión.
//
// Solo se cachea el código de la app. Los gastos viven en IndexedDB y nunca pasan por aquí.
// Si se agrega un archivo nuevo a la app, hay que añadirlo a ASSETS.
// Cambiar CACHE fuerza a descartar toda la caché anterior.

const CACHE = 'gastos-v2';
const ASSETS = [
  './',
  'index.html',
  'css/styles.css',
  'js/app.js',
  'js/db.js',
  'js/import.js',
  'js/xlsx.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });

    const refresh = fetch(req.url, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) cache.put(req.url, res.clone());
        return res;
      })
      .catch(() => null);

    if (cached) {
      event.waitUntil(refresh);
      return cached;
    }
    const fresh = await refresh;
    if (fresh) return fresh;
    // Sin red y sin copia: para una navegación se entrega la app; para lo demás, error de red.
    if (req.mode === 'navigate') return (await cache.match('./')) || Response.error();
    return Response.error();
  })());
});
