# Importar un histórico de gastos

Procedimiento para llevar a la app un histórico anotado a mano (Notas), sin inventar datos y con
trazabilidad completa:

```
histórico original  →  transformar.mjs + reglas.json  →  archivo de importación validado + reportes
                                                        →  Ajustes > Importar gastos (vista previa → confirmar)
```

## Privacidad (leer primero)

- El histórico, las reglas reales y **todos** los resultados contienen datos personales. Viven **fuera
  del repositorio** (por ejemplo `../import/`, hermana de la carpeta del proyecto) o en `import/`, que
  está en `.gitignore`. La herramienta se niega a escribir en una carpeta versionable por git.
- En el repositorio solo hay código, la muestra ficticia (`muestra/`) y `reglas.ejemplo.json`.
- Todo se procesa en local; nada se envía a servicios externos. Los originales nunca se modifican.
- Antes de cada commit: `git status` no debe listar nada de `import/`.

## Formatos de entrada

Archivos `.txt` o recortes `.textClipping` de macOS (se convierten con `plutil`/`textutil`). Se reconocen:

- líneas `Concepto: importe` bajo una línea de fecha `d/m` (`3/6:`), y
- columnas separadas por tabulador: `fecha, concepto, medio de pago, importe`.

El histórico no indica el año: se declara en `reglas.json` (`anio`).

## Pasos

1. Copiar `reglas.ejemplo.json` a la carpeta privada como `reglas.json` y adaptarla.
2. Transformar:
   ```sh
   node tools/historico/transformar.mjs \
     --entrada ../import/Junio-Julio.textClipping ../import/Agosto-a-hoy.textClipping \
     --reglas ../import/reglas.json --salida ../import/salida \
     --correcciones ../import/correcciones.csv      # opcional
   ```
3. Revisar en `salida/`:
   - `resumen.md`: totales, confianza por campo y gasto por categoría.
   - `revision_manual.csv`: lo no importado (`1-no importado`), lo que conviene verificar (`2-verificar`)
     y lo que entra sin categoría (`3-sin categoría`).
   - `revision_por_concepto.csv`: conceptos sin categoría agrupados; una regla nueva resuelve todo el grupo.
   - `reporte_transformacion.csv`: una fila por línea del histórico con, por cada campo, valor final,
     origen (`original`, `normalizado`, `inferido`, `manual`, `ausente`), confianza y regla aplicada.
4. Corregir y repetir el paso 2 hasta estar conforme:
   - algo que se repite → añadir o ajustar una regla en `reglas.json`;
   - un registro puntual → una fila en `correcciones.csv`.
5. Hacer un **backup** en la app (Ajustes > Crear backup).
6. Ajustes > **Importar archivo…** y elegir `gastos_import_historico.json`. La app muestra cuántos gastos
   se agregarán, duplicados, rechazados con su motivo y catálogos nuevos. Nada se guarda hasta pulsar
   **Importar**; **Cancelar** no modifica nada.
7. Si el resultado no convence: **Deshacer importación** (retira el último lote; conserva lo que se haya
   editado después y todos los demás gastos), corregir y volver a importar.

En el iPhone: pasar el JSON por AirDrop o Archivos (no por un servicio público) e importarlo desde la
app instalada.

## Reglas (`reglas.json`)

- `reglas`: `si` es una expresión regular evaluada contra el concepto en minúsculas y sin tildes; gana la
  primera que coincide. `conf`: `alta` | `media` | `baja` | `pendiente`.
- **`alta` y `media` se incorporan; `baja` nunca**: queda como sugerencia en los reportes y el campo vacío.
- `categorias`: la taxonomía. Toda regla debe apuntar a una categoría/subcategoría declarada aquí.
- `mediosDePago`: texto del histórico → medio de pago y alias de tarjeta/cuenta, cada uno con su confianza.
- `comercios`: solo cuando el concepto nombra el comercio.
- `noGasto`: conceptos que no deben contarse (p. ej. el pago de la tarjeta). Quedan fuera del archivo:
  como pendientes de revisión, o como exclusión justificada (`excluido`) si la regla lleva `"confirmado": true`.
- `sinCantidad`: conceptos donde un número final no es una cantidad (p. ej. "Taxi … 2").
- `marcarRevisionEnNota`: añade `Revisar: categoría/fecha/importe` a la observación de los gastos que lo
  necesitan, para encontrarlos buscando "Revisar" en el historial. Ponerlo en `false` para no añadirlo.

Qué no se infiere nunca: el concepto se conserva tal cual; sin cantidad explícita la cantidad queda vacía;
sin medio de pago queda vacío; un registro sin fecha o sin importe no se importa.

## Correcciones (`correcciones.csv`)

```csv
ref,campo,valor,comentario
Junio-Julio:521,fecha,2026-07-28,errata en el mes
Agosto-a-hoy:10,importe,24.9,
Junio-Julio:527,estado,excluir,pago de tarjeta
```

`ref` es `archivo:línea` (columna `ref` de los reportes). Campos: `fecha`, `categoria`, `subcategoria`,
`cantidad`, `unidad`, `comercio`, `medio`, `cuenta`, `importe`, `moneda`, `nota`, `estado`
(`importar` | `excluir`). Prevalecen sobre cualquier regla y quedan trazadas con origen `manual`.

## Duplicados

Cada gasto recibe un identificador determinista (fecha + concepto + importe + n.º de repetición en el día).
Volver a generar e importar el mismo histórico no duplica nada. Además, la app avisa de los registros que
coinciden en fecha, concepto e importe con gastos registrados a mano y, por defecto, los omite.

Consecuencia: cambiar reglas **después** de importar no actualiza lo ya importado (son duplicados). Para
recargar: Deshacer importación → regenerar → importar.

## Pruebas (solo datos ficticios)

```sh
node --test tests/historico.test.mjs       # transformación y plan de importación
PW_HOME=~/pw-gastos node tests/e2e.mjs     # incluye el flujo de importación en el navegador
```
