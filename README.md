# Gastos

PWA personal para registrar gastos en el iPhone y exportarlos a Excel.
Local-first: sin backend, sin login, sin servicios externos y sin costo de operación.
Los datos viven únicamente en el dispositivo (IndexedDB).

## Estado del proyecto

**V1 funcional y completa** (2026-11-16). Todo el alcance obligatorio está implementado:

| Función | Estado |
|---|---|
| Registrar gasto (fecha, concepto, categoría, subcategoría, cantidad, unidad, comercio, medio de pago, tarjeta/cuenta, importe, moneda, observación) | Hecho |
| Historial con búsqueda, filtros (fechas, categoría, medio de pago, tarjeta, comercio), edición y eliminación | Hecho |
| Resumen mensual: total, por categoría y por medio de pago | Hecho |
| Catálogos configurables: categorías, subcategorías, unidades, medios de pago, tarjetas/cuentas (alias), comercios, monedas | Hecho |
| Exportación XLSX y CSV | Hecho |
| Backup y restauración (JSON) | Hecho |
| PWA instalable, con icono y funcionamiento offline | Hecho |
| Importación aditiva de un histórico (vista previa, duplicados, cancelar y deshacer) | Hecho |

El repositorio aún no tiene commits ni está publicado: falta el paso "Publicar en GitHub Pages" (abajo).

### Qué se probó y cómo

Pruebas automáticas end-to-end (`tests/e2e.mjs`): **170/170 comprobaciones correctas**, 85 en
WebKit (motor de Safari, emulando iPhone 14) y 85 en Google Chrome, con datos ficticios.

**Probado en ejecución real (navegador automatizado):**

- Valores por defecto (fecha de hoy, PEN, cantidad 1) y validaciones del formulario.
- Alta, edición y eliminación de gastos; importes con coma o punto decimal.
- Búsqueda (sin distinguir mayúsculas ni tildes) y cada filtro del historial.
- Persistencia tras recargar la página.
- Resumen mensual: totales por mes, categoría y medio de pago; monedas separadas.
- Catálogos: alta, duplicados rechazados, renombrado con propagación a gastos existentes,
  rechazo de números de tarjeta como alias.
- XLSX: se abre con `openpyxl`; encabezados, una fila por gasto, fecha como fecha real,
  importe numérico, encabezado inmovilizado y autofiltro.
- CSV: BOM UTF-8, encabezados, escape de comillas y comas.
- Backup: contenido completo; restauración sobre datos alterados y sobre un perfil de navegador vacío;
  rechazo de archivos inválidos.
- Offline: con el servidor apagado y la red cortada, la app abre, muestra los datos, guarda un gasto nuevo y exporta.
- Sin desborde horizontal a 320, 375 y 390 px; controles táctiles de al menos 44 px; campos de 16 px.
- Ninguna petición de red fuera del propio origen; sin errores de consola.
- Revisión visual de capturas de pantalla en tamaño iPhone.

**NO probado (solo implementado y revisado estáticamente):**

- **Un iPhone real.** WebKit de Playwright es el mismo motor pero no es Safari iOS. Queda pendiente de
  verificar en el dispositivo: instalación con "Agregar a pantalla de inicio", icono, áreas seguras
  (notch / barra inferior), teclado decimal, selector de fecha nativo y arranque offline en modo standalone.
- **La hoja de compartir de iOS.** Solo se probó con `navigator.share` simulado (la app entrega el archivo
  correcto). Falta confirmar en el iPhone "Guardar en Archivos" para XLSX, CSV y JSON.
- **Abrir el XLSX en Microsoft Excel y Power Query.** Se validó con `openpyxl`, no con Excel.
- **Publicación en GitHub Pages.** La app se probó servida bajo un subdirectorio (`/gastos/`), igual que
  en Pages, pero no en Pages mismo.
- Modo oscuro (solo CSS, sin prueba visual).
- Volúmenes grandes (miles de gastos).

## Arquitectura

Sitio estático, **sin paso de build y sin dependencias**: HTML, CSS y módulos ES nativos.

```
index.html             Estructura de las 4 vistas (Registrar, Historial, Resumen, Ajustes)
css/styles.css         Estilos (mobile-first, modo claro/oscuro automático)
js/app.js              Toda la lógica de interfaz y estado
js/db.js               Acceso a IndexedDB
js/xlsx.js             Generador XLSX mínimo propio (ZIP sin compresión + XML)
js/import.js           Validación y plan de la importación aditiva (sin DOM; también lo usa la herramienta)
sw.js                  Service worker (offline)
manifest.webmanifest   Manifiesto PWA
icons/                 Iconos PNG (180, 192, 512)
tools/make_icons.py    Regenera los iconos (opcional, requiere Pillow)
tools/historico/       Transformación de un histórico manual a archivo de importación (ver su README)
tests/e2e.mjs          Pruebas end-to-end (Playwright; solo desarrollo)
tests/historico.test.mjs  Pruebas de la transformación y la importación (node --test)
.nojekyll              Evita que GitHub Pages procese el sitio con Jekyll
```

### Decisiones técnicas

- **Sin framework ni build.** El proyecto son ~1600 líneas; cualquier editor y un servidor estático bastan.
- **IndexedDB** con dos almacenes: `expenses` (un registro por gasto, clave `id`) y `meta`
  (`config` con los catálogos y `lastBackupAt`). Todos los gastos se cargan en memoria al abrir; los filtros
  y el resumen se calculan en memoria. Suficiente para uso personal (decenas de miles de registros).
- **Los gastos guardan nombres, no IDs** (`category: "Alimentación"`). Así la exportación es directa.
  Al renombrar un elemento del catálogo, la app actualiza los gastos que lo usan. Al eliminarlo, los gastos
  existentes conservan el valor.
- **XLSX propio** en lugar de una librería (SheetJS pesa cerca de 1 MB): una sola hoja, cadenas en línea,
  fechas como número de serie de Excel con formato de fecha. Ver `js/xlsx.js`.
- **Importes** como número con 2 decimales; las sumas se hacen en céntimos enteros para evitar errores
  de coma flotante. Las monedas nunca se suman entre sí.
- **Fechas** como texto `YYYY-MM-DD` en hora local (no UTC).
- **Service worker "stale-while-revalidate":** responde desde caché y actualiza en segundo plano.
  Tras publicar cambios, la app se actualiza **la segunda vez** que se abre con conexión.
  Si se agrega un archivo nuevo a la app hay que añadirlo a `ASSETS` en `sw.js`.
- **Privacidad reforzada por CSP** (`index.html`): el navegador bloquea toda carga o conexión fuera del
  propio origen. Consecuencia: no se pueden usar estilos ni scripts en línea; los estilos dinámicos
  se aplican por CSSOM (`el.style.width = …`).
- **Interfaz construida con DOM** (función `h()` en `app.js`), nunca con `innerHTML`: el texto del usuario
  o de un backup jamás se interpreta como HTML.
- **Entrega de archivos** (`deliver()` en `app.js`): en pantallas táctiles usa la hoja de compartir
  (`navigator.share` con archivos); en escritorio, o si no está disponible, una descarga normal.
- **Tarjetas solo por alias.** La app rechaza alias con 7 o más dígitos seguidos.

### Modelo de datos

Gasto:

```json
{
  "id": "uuid", "date": "2026-11-16", "concept": "Almuerzo",
  "category": "Alimentación", "subcategory": "Restaurantes",
  "quantity": 1, "unit": "unidad", "merchant": "…",
  "paymentMethod": "Tarjeta de crédito", "account": "Visa BCP",
  "amount": 25.5, "currency": "PEN", "note": "",
  "createdAt": "ISO-8601", "updatedAt": "ISO-8601"
}
```

Configuración (`meta.config`): `categories [{name, subs[]}]`, `units[]`,
`paymentMethods [{name, usesAccount}]`, `accounts[]`, `merchants[]`, `currencies[]`.

Backup: `{ format: "gastos-app-backup", schemaVersion: 1, appVersion, exportedAt, config, expenses }`.
Restaurar **reemplaza** todos los datos del dispositivo (previa confirmación).

### Importar gastos (histórico)

Ajustes > **Importar archivo…** agrega gastos desde un archivo `gastos-app-import` (JSON) **sin tocar los
existentes**: valida cada registro, omite duplicados, informa los rechazados y muestra un resumen antes de
guardar; se puede cancelar y, después, **deshacer** el último lote. Se guarda en una sola transacción.
El archivo se genera con `tools/historico/` — procedimiento completo en `tools/historico/README.md`.
Los históricos reales y sus resultados no forman parte del repositorio (`import/` está en `.gitignore`).

### Columnas de la exportación

Una fila por gasto, en este orden (definido en `EXPORT_COLUMNS`, `js/app.js`):

`Fecha`, `Concepto`, `Categoría`, `Subcategoría`, `Cantidad`, `Unidad`, `Comercio`, `Medio de pago`,
`Tarjeta o cuenta`, `Importe`, `Moneda`, `Observación`, `ID`, `Creado`, `Actualizado`.

- XLSX: hoja `Gastos`; `Fecha` es fecha real de Excel, `Cantidad` e `Importe` son numéricos.
- CSV: UTF-8 con BOM, separador coma, fecha `YYYY-MM-DD`, punto decimal.
- En Power Query: *Datos > Obtener datos > De un archivo > De un libro de Excel*, hoja `Gastos`,
  "Usar la primera fila como encabezado". `ID` es estable y sirve como clave para combinar exportaciones.

## Ejecutar localmente

Necesita un servidor estático (los service workers no funcionan con `file://`). Desde la carpeta del proyecto:

```sh
python3 -m http.server 8000
```

Abrir <http://localhost:8000>. Para probar desde el iPhone en la misma red se necesita HTTPS
(el service worker solo funciona en `localhost` o HTTPS); lo más simple es publicar en GitHub Pages.

## Publicar en GitHub Pages

1. Crear un repositorio en GitHub (por ejemplo `gastos-app`). Con una cuenta gratuita, GitHub Pages
   requiere que el repositorio sea **público**. Esto solo expone el código: los gastos nunca están en el repositorio.
2. Subir el código:
   ```sh
   git add .
   git commit -m "Gastos V1"
   git remote add origin https://github.com/<usuario>/gastos-app.git
   git push -u origin main
   ```
3. En GitHub: **Settings > Pages > Build and deployment > Source: "Deploy from a branch"**,
   rama `main`, carpeta `/ (root)`, **Save**.
4. Esperar 1–2 minutos. La app queda en `https://<usuario>.github.io/gastos-app/`.

Todas las rutas son relativas, así que funciona en cualquier subdirectorio o hosting estático equivalente.

### Instalar en el iPhone

1. Abrir la URL en **Safari**.
2. Botón Compartir > **Agregar a pantalla de inicio**.
3. Abrir la app desde el icono una vez con conexión. Desde entonces funciona offline.

Importante: la app instalada tiene su propio almacenamiento, separado del de Safari. Registra los gastos
siempre desde el icono de la pantalla de inicio.

### Publicar una actualización

`git push` y listo. En el iPhone la versión nueva aparece al abrir la app por segunda vez con conexión.
Si se agregan archivos nuevos, añadirlos a `ASSETS` en `sw.js`. Para forzar el descarte de toda la caché,
cambiar `CACHE` (`gastos-v2` → `gastos-v3`). Actualizar la app no toca los datos.

## Pruebas

Las pruebas usan Playwright, que se instala **fuera** del proyecto (si la carpeta está en iCloud Drive,
`node_modules` se corrompe al sincronizar):

```sh
mkdir -p ~/pw-gastos && cd ~/pw-gastos
npm init -y && npm install playwright && npx playwright install webkit
cd /ruta/al/proyecto
PW_HOME=~/pw-gastos node tests/e2e.mjs            # WebKit + Chrome
PW_HOME=~/pw-gastos node tests/e2e.mjs webkit     # solo WebKit
```

Requiere Node 18+, Google Chrome instalado (para la suite `chrome`) y Python 3 con `openpyxl`
(para validar el XLSX). Las capturas quedan en `tests/output/` (ignorado por git).

## Limitaciones conocidas

- **Los datos existen solo en el dispositivo.** Si se borra la app de la pantalla de inicio, se borran los
  datos de sitios web de Safari o se pierde el teléfono, los gastos se pierden. El único resguardo es el
  backup manual (Ajustes > Crear backup); conviene guardarlo en Archivos / iCloud Drive periódicamente.
- iOS puede eliminar el almacenamiento de sitios no instalados tras varios días sin uso. Instalar la app
  en la pantalla de inicio evita ese comportamiento; la app además solicita almacenamiento persistente.
- Sin sincronización entre dispositivos. Para mover los datos: backup en uno, restaurar en el otro.
- Restaurar reemplaza todo; no hay fusión de backups.
- Sin conversión de moneda: los totales se muestran por moneda.
- La exportación incluye siempre todos los gastos (el filtrado se hace en Excel).
- Los catálogos no se pueden reordenar.
- El XLSX se genera sin compresión (aprox. 250 bytes por gasto); irrelevante para uso personal.
- Requiere iOS 16.4 o posterior recomendado (mínimo razonable: iOS 15.4).
- No verificado aún en un iPhone real ni en Excel (ver "Qué se probó y cómo").

## Pendientes

1. Publicar en GitHub Pages e instalar en el iPhone.
2. Verificar en el iPhone: instalación, icono, offline en modo standalone, teclado decimal, selector de
   fecha y hoja de compartir con XLSX, CSV y JSON.
3. Abrir el XLSX exportado en Excel y conectarlo con Power Query.
4. Revisar el modo oscuro en el dispositivo.
5. Ajustar los catálogos iniciales (`DEFAULT_CONFIG` en `js/app.js`, o desde Ajustes) a los datos reales.

## Posibles mejoras futuras

Fuera del alcance de la V1; evaluar después de usarla un tiempo:

- Recordatorio de backup cuando lleve muchos días sin hacerse.
- Duplicar un gasto o plantillas de gastos frecuentes.
- Exportar solo un rango de fechas o lo filtrado en el historial.
- Fusionar backups en lugar de reemplazar.
- Reordenar catálogos; recordar la última categoría o medio de pago usados.
- Sincronización (iCloud u otra), Atajos de iOS / Siri, OCR de comprobantes, presupuestos y alertas.
