# finanzas-tool

API en Next.js (App Router, runtime nodejs) que recibe texto dictado en español desde un Atajo de iOS,
lo convierte con Claude en movimientos financieros y, después de confirmar, los escribe en un Google Sheet.

Flujo: `POST /api/parse` → muestra `summary` en el iPhone → `POST /api/commit` con el `draft` →
si algo salió mal, `POST /api/undo` con las `rows` devueltas.

## Setup

```bash
npm install
# crea .env.local con las variables de abajo
npm run dev    # http://localhost:3000
npm test       # vitest
```

Sin `SHEET_ID` la API usa un Sheet en memoria (`lib/sheet/mock.ts`) con cuentas, catálogo y un par de
filas Pendiente (Arriendo e Internet), así que `/api/parse` se puede probar solo con `ANTHROPIC_API_KEY`.
El mock se reinicia cada vez que se reinicia el servidor.

Las reglas de negocio que van al system prompt están en [`lib/reglas.md`](lib/reglas.md); edítalas ahí.

### Google Sheet

1. Crea una service account en Google Cloud, habilita la Google Sheets API y genera una llave JSON.
2. Comparte el Sheet con el email de la service account como **Editor**.
3. Copia `client_email` → `GOOGLE_SERVICE_ACCOUNT_EMAIL` y `private_key` → `GOOGLE_PRIVATE_KEY`.

**Primera prueba real:** después del primer commit revisa que la columna A quede como fecha (no texto) y
que B, L, N, P y Q calculen bien con la configuración regional Colombia. Si A queda como texto, hay que
escribir la fecha como número serial (`lib/rows.ts`, `insertWrites`/`updateWrites`).

## Variables de entorno

| Variable | Descripción |
|---|---|
| `ANTHROPIC_API_KEY` | API key de Anthropic |
| `ANTHROPIC_MODEL` | Modelo; por defecto `claude-sonnet-5-5` |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Email de la service account |
| `GOOGLE_PRIVATE_KEY` | Llave privada; los `\n` literales se convierten en saltos de línea |
| `SHEET_ID` | ID del Google Sheet (el tramo entre `/d/` y `/edit` de la URL). Si falta, se usa el mock |
| `API_SECRET` | Secreto que debe llegar en el header `x-api-secret` (todas las rutas menos `/api/health`) |

En Vercel, agrégalas en *Settings → Environment Variables*. Para `GOOGLE_PRIVATE_KEY` pega el valor tal cual
viene en el JSON (con `\n` literales).

## Endpoints

| Ruta | Body | Respuesta |
|---|---|---|
| `POST /api/parse` | `{ text, previousDraft?, correction?, history?, answer? }` | `{ status: "ok", summary, draft }` o `{ status: "question", question, history }` |
| `POST /api/commit` | `{ draft }` | `{ message, rows, previous }` (409 si una fila a actualizar cambió) |
| `POST /api/undo` | `{ rows?, previous? }` | `{ message, rows, previous }` |

`rows` son las filas insertadas y `previous` los valores que tenían las filas actualizadas antes del
commit. Para deshacer todo, manda a `/api/undo` la respuesta del commit tal cual: limpia los inserts y
restaura los updates (409 si el concepto de una fila actualizada cambió desde entonces).
| `GET /api/health` | | `{ ok: true }` |

Los errores responden `{ error }` con el status correspondiente (400, 401, 409, 422, 500, 502).

### Preguntas

Si falta algo que no se puede suponer (el monto, si es ingreso/gasto/transferencia, o cuánto llegó en
una conversión sin tasa), `/api/parse` responde `{ status: "question", question, history }`. La pregunta
es corta y se puede leer en voz alta. Para responder, vuelve a llamar con el mismo `text`, el `history`
que llegó y la respuesta en `answer` (o con `history` ya completo: `[{ q, a }]`). Hay como máximo
3 rondas por mensaje: en la tercera Claude decide con supuestos.

### Atajo de iOS

1. **Dictar texto** → variable `Texto`. Variable `History` = lista vacía; `Answer` = vacío.
2. **Repetir 3 veces:**
   - **Obtener contenido de URL** `POST /api/parse`, header `x-api-secret`, JSON
     `{ text: Texto, history: History, answer: Answer }` → `Respuesta`.
   - **Si** `Respuesta.status` = `question`:
     **Leer texto** `Respuesta.question` → **Dictar texto** → `Answer`; `History` = `Respuesta.history`.
   - **Si no:** salir del ciclo (o no hacer nada en las vueltas que quedan).
3. **Mostrar** `Respuesta.summary` con las opciones *Guardar / Corregir / Cancelar*.
   - *Corregir*: dictar la corrección y llamar `/api/parse` con `previousDraft: Respuesta.draft` y `correction`.
   - *Guardar*: `POST /api/commit` con `{ draft: Respuesta.draft }` y guardar la respuesta para deshacer.
4. **Deshacer** (otro Atajo o una opción final): `POST /api/undo` con la respuesta del commit tal cual.

### Conversiones y saldos

- Con la tasa del proveedor y/o la comisión, el sistema calcula el monto recibido (comisión en USD:
  `(H − comisión) × tasa`; en COP: `H × tasa − comisión`) y escribe la nota
  "Tasa real Deel: 3.194. Comisión: 12,6 USD / 40.244 COP". M (TRM de Google) solo se llena si se dice
  explícitamente que es la de Google.
- Si mencionas un saldo ("tengo 1.200 en Deel"), se compara con `Cuentas!C` (saldo calculado) y, si
  difiere, se agrega un Ajuste: "Ajuste: Deel −12 USD (saldo dicho 1.200 vs Sheet 1.212)". Se puede quitar
  con *Corregir*.

## Ejemplos

```bash
export URL=http://localhost:3000
export API_SECRET=tu-secreto
```

1. Gasto simple

```bash
curl -s -X POST "$URL/api/parse" -H "x-api-secret: $API_SECRET" -H "content-type: application/json" \
  -d '{"text":"Almuerzo 32 mil con Nu"}'
```

2. Pago de algo Pendiente → update de esa fila

```bash
curl -s -X POST "$URL/api/parse" -H "x-api-secret: $API_SECRET" -H "content-type: application/json" \
  -d '{"text":"Pagué el arriendo"}'
```

3. Ingreso en USD

```bash
curl -s -X POST "$URL/api/parse" -H "x-api-secret: $API_SECRET" -H "content-type: application/json" \
  -d '{"text":"Me llegaron 1198 dólares de Benor a DolarApp"}'
```

4. Conversión USD → COP

```bash
curl -s -X POST "$URL/api/parse" -H "x-api-secret: $API_SECRET" -H "content-type: application/json" \
  -d '{"text":"Pasé 500 dólares de Deel a Nu y me llegaron 1 millón 560"}'
```

5. Fecha relativa y varios conceptos

```bash
curl -s -X POST "$URL/api/parse" -H "x-api-secret: $API_SECRET" -H "content-type: application/json" \
  -d '{"text":"Ayer gasté como 80 lucas en uber y comida"}'
```

6. Ahorro

```bash
curl -s -X POST "$URL/api/parse" -H "x-api-secret: $API_SECRET" -H "content-type: application/json" \
  -d '{"text":"Le metí 400 mil al ahorro desde Rappi"}'
```

7. Pregunta y respuesta

```bash
curl -s -X POST "$URL/api/parse" -H "x-api-secret: $API_SECRET" -H "content-type: application/json" \
  -d '{"text":"Mandé 300 dólares de Deel a Nu"}'
# → {"status":"question","question":"¿Cuántos pesos te llegaron a Nu Bank?","history":[...]}
curl -s -X POST "$URL/api/parse" -H "x-api-secret: $API_SECRET" -H "content-type: application/json" \
  -d '{"text":"Mandé 300 dólares de Deel a Nu","history":[{"q":"¿Cuántos pesos te llegaron a Nu Bank?","a":""}],"answer":"me llegaron 940 mil"}'
```

Corregir, confirmar y deshacer:

```bash
# Corrección: manda el draft anterior y lo que hay que cambiar
curl -s -X POST "$URL/api/parse" -H "x-api-secret: $API_SECRET" -H "content-type: application/json" \
  -d '{"text":"Almuerzo 32 mil con Nu","previousDraft":"<draft>","correction":"fue con Rappi"}'

curl -s -X POST "$URL/api/commit" -H "x-api-secret: $API_SECRET" -H "content-type: application/json" \
  -d '{"draft":"<draft>"}'

# Deshacer: la respuesta del commit tal cual
curl -s -X POST "$URL/api/undo" -H "x-api-secret: $API_SECRET" -H "content-type: application/json" \
  -d '{"rows":[67,68],"previous":[{"rowNumber":48,"concepto":"Arriendo","values":{"O":"Pendiente"}}]}'
```

## Smoke test (local, con `.env.local`)

```bash
npm run smoke              # build + servidor en :3123; solo lee el Sheet
npm run smoke -- --commit  # además inserta una fila de PRUEBA en el Sheet real y la deshace
```

Revisa variables, acceso al Sheet (hojas, cuentas, catálogo, pendientes, fórmulas), la API key y el
modelo, la fórmula P de una fila USD real, auth, los 6 casos de ejemplo, una corrección y los errores 400.
Con `--commit` hace un commit real (un insert COP, un insert USD y un update de una fila Pendiente, todo
marcado "PRUEBA smoke-test") y lo deshace: verifica que A quede como fecha, que B, Q y P calculen sin
`#ERROR!`, que la fórmula P que escribe la API sea idéntica a la del Sheet y que la fila actualizada quede
exactamente como estaba.
Escribe `reports/smoke-<fecha>.md` y `.json` (con log del servidor y sin secretos). `reports/` está en
`.gitignore` porque contiene datos del Sheet.

## Estructura

```
app/api/{parse,commit,undo,health}/route.ts   rutas (maxDuration 30)
lib/schema.ts       zod: operaciones, JSON schema del tool, draft base64url
lib/reglas.md       reglas de negocio (system prompt)
lib/claude.ts       prompt, llamada a Claude, preguntas y reintento con errores de validación
lib/parse.ts        /api/parse: rondas de preguntas, history y answer
lib/conversion.ts   monto recibido con tasa/comisión del proveedor y Ajustes de saldo
lib/validate.ts     reglas por tipo, moneda vs cuenta, catálogo, updates
lib/data.ts         lectura de Cuentas, Catálogo y contexto (caché 60 s)
lib/rows.ts         construcción de escrituras por fila y fórmulas
lib/commit.ts       commit y undo
lib/sheet/          SheetRepo: Google Sheets y mock en memoria
lib/montos.ts       lectura de montos coloquiales
tests/              vitest
```
