// Pruebas locales de punta a punta con las variables de .env.local.
// Uso: npm run smoke            (build + servidor propio en :3123, solo lectura en el Sheet)
//      npm run smoke -- --commit (además inserta una fila de PRUEBA en el Sheet real y la deshace)
//      node scripts/smoke-test.mjs --url http://localhost:3000   (usa un servidor ya corriendo)
// Escribe reports/smoke-<fecha>.md y .json. Nunca imprime valores de las variables de entorno.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const DO_COMMIT = args.includes("--commit");
const urlArg = args.indexOf("--url");
const PORT = 3123;
const BASE = urlArg >= 0 ? args[urlArg + 1] : `http://localhost:${PORT}`;

try {
  process.loadEnvFile(".env.local");
} catch {
  console.error("No encontré .env.local");
}
const env = process.env;
const MODEL = env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const SECRETOS = ["ANTHROPIC_API_KEY", "GOOGLE_PRIVATE_KEY", "API_SECRET"]
  .map((k) => env[k])
  .filter((v) => v && v.length > 8);

const checks = [];
let serverLog = "";

function redactar(texto) {
  let s = String(texto);
  for (const v of SECRETOS) s = s.split(v).join("[REDACTADO]");
  return s;
}
function check(seccion, nombre, status, detalle = "") {
  checks.push({ seccion, nombre, status, detalle: redactar(detalle) });
  const icon = { ok: "✅", warn: "⚠️", fail: "❌" }[status];
  console.log(`${icon} [${seccion}] ${nombre}${detalle ? ` — ${redactar(detalle).split("\n")[0]}` : ""}`);
}
const norm = (s) =>
  String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const decodeDraft = (d) => JSON.parse(Buffer.from(d, "base64url").toString("utf8"));
const hoyBogota = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date());
const sumarDias = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function api(method, ruta, body, { secret = env.API_SECRET } = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(BASE + ruta, {
      method,
      headers: { "content-type": "application/json", ...(secret ? { "x-api-secret": secret } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { _raw: text.slice(0, 2000) };
    }
    return { status: res.status, ms: Date.now() - t0, json };
  } catch (err) {
    return { status: 0, ms: Date.now() - t0, json: { error: `fetch falló: ${err.message}` } };
  }
}

// ---------------------------------------------------------------- 1. Entorno
function probarEntorno() {
  for (const k of ["ANTHROPIC_API_KEY", "GOOGLE_SERVICE_ACCOUNT_EMAIL", "GOOGLE_PRIVATE_KEY", "SHEET_ID", "API_SECRET"]) {
    check("Entorno", `${k} definida`, env[k] ? "ok" : "fail", env[k] ? `${env[k].length} caracteres` : "vacía");
  }
  check("Entorno", "ANTHROPIC_MODEL", "ok", env.ANTHROPIC_MODEL ? env.ANTHROPIC_MODEL : `sin definir, se usa ${MODEL}`);
  if (env.GOOGLE_PRIVATE_KEY) {
    try {
      crypto.createPrivateKey(env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"));
      check("Entorno", "GOOGLE_PRIVATE_KEY es una llave válida", "ok");
    } catch (err) {
      check("Entorno", "GOOGLE_PRIVATE_KEY es una llave válida", "fail", err.code || err.message);
    }
  }
}

// ---------------------------------------------------------------- 2. Google Sheets
let sheets;
const ctxSheet = { pendientes: [], cuentas: [], siguienteFila: null, trm: null, formulaPUSD: null };

async function probarSheets() {
  if (!env.SHEET_ID) return check("Google Sheets", "SHEET_ID", "warn", "sin SHEET_ID: la API usa el mock");
  try {
    const { google } = await import("googleapis");
    const auth = new google.auth.JWT({
      email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    sheets = google.sheets({ version: "v4", auth });
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: env.SHEET_ID,
      fields: "properties(title,locale,timeZone),sheets(properties(title))",
    });
    const p = meta.data.properties;
    const hojas = meta.data.sheets.map((s) => s.properties.title);
    check("Google Sheets", "acceso al Sheet", "ok", `"${p.title}", locale ${p.locale}, zona ${p.timeZone}`);
    if (p.timeZone !== "America/Bogota") {
      check("Google Sheets", "zona horaria del Sheet", "warn", `${p.timeZone} (la API calcula fechas en America/Bogota)`);
    }
    for (const h of ["Movimientos", "Cuentas", "Catálogo"]) {
      check("Google Sheets", `hoja "${h}" existe`, hojas.includes(h) ? "ok" : "fail", hojas.includes(h) ? "" : `hojas: ${hojas.join(", ")}`);
    }

    const res = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: env.SHEET_ID,
      ranges: ["Cuentas!A6:C13", "Cuentas!D3", "'Catálogo'!A4:H29", "Movimientos!A2:Q3000"],
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "SERIAL_NUMBER",
    });
    const [cuentas, trm, catalogo, movs] = res.data.valueRanges.map((v) => v.values ?? []);
    ctxSheet.cuentas = cuentas.filter((r) => r[0]).map((r) => ({ nombre: String(r[0]).trim(), moneda: String(r[1] ?? "").trim(), saldo: typeof r[2] === "number" ? r[2] : null }));
    check("Google Sheets", "Cuentas!A6:C13", ctxSheet.cuentas.length ? "ok" : "fail", ctxSheet.cuentas.map((c) => `${c.nombre} (${c.moneda || "sin moneda"}, saldo ${c.saldo ?? "sin dato"})`).join(", ") || "vacío");
    for (const c of ctxSheet.cuentas) {
      if (!["COP", "USD"].includes(c.moneda.toUpperCase())) check("Google Sheets", `moneda de "${c.nombre}"`, "warn", `"${c.moneda}" no es COP ni USD`);
    }
    for (const esperada of ["Nu Bank", "DolarApp (ARQ)", "Deel"]) {
      const existe = ctxSheet.cuentas.some((c) => norm(c.nombre) === norm(esperada));
      check("Google Sheets", `cuenta "${esperada}" (usada en reglas)`, existe ? "ok" : "warn", existe ? "" : "no está en Cuentas!A6:A13");
    }
    const trmVal = trm[0]?.[0];
    ctxSheet.trm = typeof trmVal === "number" ? trmVal : null;
    check("Google Sheets", "TRM Cuentas!D3", typeof trmVal === "number" ? "ok" : "warn", `${JSON.stringify(trmVal)}`);
    const cats = (catalogo[0] ?? []).map((c) => String(c).trim());
    check("Google Sheets", "Catálogo fila 4 (categorías)", cats.filter(Boolean).length ? "ok" : "fail", cats.join(" | "));
    for (const c of ["Fijo", "Variable", "Suscripción", "Deuda"]) {
      if (!cats.some((x) => norm(x) === norm(c))) check("Google Sheets", `categoría "${c}" en Catálogo`, "warn", "no está en A4:H4");
    }

    const datos = movs
      .map((r, i) => ({ r, fila: i + 2 }))
      .filter(({ r }) => [0, 2, 6, 7].some((c) => r[c] !== undefined && String(r[c]).trim() !== ""));
    ctxSheet.siguienteFila = datos.length ? datos[datos.length - 1].fila + 1 : 2;
    ctxSheet.pendientes = datos.filter(({ r }) => norm(r[14]) === "pendiente").map(({ r, fila }) => ({ fila, concepto: r[6], moneda: r[8] }));
    check("Google Sheets", "Movimientos", "ok", `${datos.length} filas con datos; siguiente fila de insert: ${ctxSheet.siguienteFila}`);
    check("Google Sheets", "filas Pendiente", "ok", ctxSheet.pendientes.map((p) => `fila ${p.fila}: ${p.concepto}`).join(", ") || "ninguna");
    const fechasTexto = datos.filter(({ r }) => typeof r[0] === "string" && r[0].trim() !== "");
    if (fechasTexto.length) {
      check("Google Sheets", "fechas en columna A", "warn", `${fechasTexto.length} filas tienen la fecha como texto (ej. fila ${fechasTexto[0].fila}: "${fechasTexto[0].r[0]}")`);
    }

    // Fórmula real de P en una fila USD: debe conservar "#,##0" dentro de TEXT y renderizar sin error.
    const leerP = async (opt) =>
      (await sheets.spreadsheets.values.get({ spreadsheetId: env.SHEET_ID, range: "Movimientos!P2:P3000", valueRenderOption: opt })).data.values ?? [];
    const [pFormulas, pFormato] = [await leerP("FORMULA"), await leerP("FORMATTED_VALUE")];
    const usd = [...datos]
      .reverse()
      .find(({ r, fila }) => r[8] === "USD" && typeof r[7] === "number" && String(pFormulas[fila - 2]?.[0] ?? "").startsWith("="));
    if (usd) {
      const formula = String(pFormulas[usd.fila - 2][0]);
      const visto = String(pFormato[usd.fila - 2]?.[0] ?? "");
      ctxSheet.formulaPUSD = { fila: usd.fila, formula };
      const conserva = formula.includes(`TEXT(Q${usd.fila};"#,##0")`) && formula.includes('"#,##0.00"');
      const rinde = /^≈ \$[\d.]+ COP \(tasa [\d.]+,\d{2}\)$/.test(visto);
      check("Google Sheets", `fórmula P real en la fila USD ${usd.fila}`, conserva && rinde ? "ok" : "fail",
        `se ve "${visto}" — ${formula}`);
    } else {
      check("Google Sheets", "fórmula P real en una fila USD", "warn", "no hay filas USD con fórmula en P");
    }

    const n = ctxSheet.siguienteFila;
    const f = await sheets.spreadsheets.values.get({
      spreadsheetId: env.SHEET_ID,
      range: `Movimientos!A${n}:Q${n}`,
      valueRenderOption: "FORMULA",
    });
    const fila = f.data.values?.[0] ?? [];
    const conFormula = { B: 1, L: 11, N: 13, P: 15, Q: 16 };
    const resumen = Object.entries(conFormula).map(([col, i]) => `${col}: ${String(fila[i] ?? "").startsWith("=") ? "fórmula" : "vacía"}`);
    check("Google Sheets", `fórmulas en la fila vacía ${n}`, "ok", `${resumen.join(", ")} (si están vacías, la API las escribe)`);
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    let pista = "";
    if (/permission|403/i.test(msg)) pista = `\nPista: comparte el Sheet con ${env.GOOGLE_SERVICE_ACCOUNT_EMAIL} como Editor.`;
    if (/not found|404/i.test(msg)) pista = "\nPista: revisa SHEET_ID.";
    if (/has not been used|disabled/i.test(msg)) pista = "\nPista: habilita la Google Sheets API en el proyecto de la service account.";
    if (/invalid_grant|JWT/i.test(msg)) pista = "\nPista: el email o la llave de la service account no coinciden o la llave fue revocada.";
    check("Google Sheets", "acceso al Sheet", "fail", msg + pista);
  }
}

// ---------------------------------------------------------------- 3. Anthropic
async function probarAnthropic() {
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const m = await new Anthropic().models.retrieve(MODEL);
    check("Anthropic", `API key y modelo ${MODEL}`, "ok", m.display_name ?? m.id);
  } catch (err) {
    check("Anthropic", `API key y modelo ${MODEL}`, "fail", `${err.status ?? ""} ${err.message}`);
  }
}

// ---------------------------------------------------------------- 4. Servidor
let server;
async function levantarServidor() {
  if (urlArg >= 0) return true;
  if (!fs.existsSync(".next/BUILD_ID")) {
    check("Servidor", "build", "fail", "no hay build; corre `npm run build` o `npm run smoke`");
    return false;
  }
  // Si algo ya responde en el puerto, las pruebas irían contra otro servidor (otro build u otras variables).
  const previo = await api("GET", "/api/health", undefined, { secret: null });
  if (previo.status !== 0) {
    check("Servidor", "arranque", "fail", `el puerto ${PORT} ya está ocupado por otro proceso; ciérralo o usa --url`);
    return false;
  }
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], {
    env: { ...process.env, NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));
  let salio = null;
  server.on("exit", (code) => (salio = code));
  for (let i = 0; i < 60; i++) {
    if (salio !== null) {
      check("Servidor", "arranque", "fail", `next start terminó con código ${salio}: ${serverLog.slice(-500)}`);
      return false;
    }
    const r = await api("GET", "/api/health", undefined, { secret: null });
    if (r.status === 200) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  check("Servidor", "arranque", "fail", "no respondió /api/health en 30 s");
  return false;
}

async function probarServidor() {
  const h = await api("GET", "/api/health", undefined, { secret: null });
  check("Servidor", "GET /api/health", h.status === 200 && h.json.ok === true ? "ok" : "fail", `${h.status} ${JSON.stringify(h.json)}`);
  const s = await api("POST", "/api/parse", { text: "x" }, { secret: null });
  check("Servidor", "401 sin x-api-secret", s.status === 401 ? "ok" : "fail", `${s.status}`);
  const b = await api("POST", "/api/parse", { text: "x" }, { secret: "incorrecto" });
  check("Servidor", "401 con secreto incorrecto", b.status === 401 ? "ok" : "fail", `${b.status}`);
}

// ---------------------------------------------------------------- 5. Casos de parse
const hoy = hoyBogota();
const ayer = sumarDias(hoy, -1);
const inserts = (ops) => ops.filter((o) => o.action === "insert").map((o) => o.row);

const CASOS = [
  {
    texto: "Almuerzo 32 mil con Nu",
    esperar: (ops) => {
      const [r] = inserts(ops);
      return [
        [ops.length === 1 && r?.tipo === "Gasto", "1 insert tipo Gasto"],
        [r?.montoOrigen === 32000 && r?.monedaOrigen === "COP", "32000 COP"],
        [norm(r?.cuentaOrigen).includes("nu"), "cuenta Nu"],
        [r?.fecha === hoy, `fecha hoy (${hoy})`],
      ];
    },
  },
  {
    texto: "Pagué el arriendo",
    esperar: (ops) => {
      const pend = ctxSheet.pendientes.find((p) => norm(p.concepto).includes("arriendo"));
      const u = ops.find((o) => o.action === "update");
      if (!pend && env.SHEET_ID) return [[true, "no hay Arriendo Pendiente en el Sheet; no se puede esperar un update"]];
      return [
        [!!u && inserts(ops).length === 0, "update (no insert)"],
        [u?.set?.estado === "Pagado", "estado Pagado"],
        [!pend || u?.rowNumber === pend.fila, pend ? `fila ${pend.fila}` : "fila del mock"],
      ];
    },
  },
  {
    texto: "Me llegaron 1198 dólares de Benor a DolarApp",
    esperar: (ops) => {
      // Si hay un ingreso de Benor Pendiente, lo correcto es marcarlo Pagado en vez de insertar.
      const pend = ctxSheet.pendientes.find((p) => norm(p.concepto).includes("benor"));
      const u = ops.find((o) => o.action === "update");
      if (pend && u) {
        return [
          [u.rowNumber === pend.fila, `update de la fila ${pend.fila}`],
          [u.set?.estado === "Pagado", "estado Pagado"],
        ];
      }
      const [r] = inserts(ops);
      return [
        [r?.tipo === "Ingreso", "Ingreso"],
        [r?.montoDestino === 1198 && r?.monedaDestino === "USD", "1198 USD en destino"],
        [norm(r?.cuentaDestino).includes("dolarapp"), "cuenta DolarApp"],
        [r?.montoOrigen === undefined && r?.cuentaOrigen === undefined, "origen vacío"],
      ];
    },
  },
  {
    texto: "Pasé 500 dólares de Deel a Nu y me llegaron 1 millón 560",
    esperar: (ops) => {
      const [r] = inserts(ops);
      return [
        [r?.tipo === "Transferencia", "Transferencia"],
        [r?.montoOrigen === 500 && r?.monedaOrigen === "USD", "500 USD origen"],
        [r?.montoDestino === 1560000 && r?.monedaDestino === "COP", "1.560.000 COP destino"],
        [norm(r?.categoria) === "conversion", "categoría Conversión"],
        [norm(r?.cuentaOrigen).includes("deel") && norm(r?.cuentaDestino).includes("nu"), "Deel → Nu"],
      ];
    },
  },
  {
    texto: "Ayer gasté como 80 lucas en uber y comida",
    esperar: (ops) => {
      const rows = inserts(ops);
      const total = rows.reduce((s, r) => s + (r.montoOrigen ?? 0), 0);
      return [
        [rows.length >= 1 && rows.every((r) => r.tipo === "Gasto"), "gasto(s)"],
        [total === 80000, `total 80.000 (fue ${total})`],
        [rows.every((r) => r.fecha === ayer), `fecha ayer (${ayer})`],
      ];
    },
  },
  {
    texto: "Le metí 400 mil al ahorro desde Rappi",
    esperar: (ops) => {
      const [r] = inserts(ops);
      return [
        [r?.tipo === "Transferencia", "Transferencia"],
        [r?.montoOrigen === 400000 && r?.montoDestino === 400000, "400.000 en ambos lados"],
        [norm(r?.categoria) === "ahorro", "categoría Ahorro"],
        [norm(r?.cuentaOrigen).includes("rappi") && norm(r?.cuentaDestino).includes("ahorro"), "Rappi → Ahorro"],
      ];
    },
  },
  {
    texto: "Tengo 1200 en Deel, voy a pasar 800 a Nu, el dólar de Deel está a 3194 y me cobra 12.6 dólares",
    esperar: (ops, summary) => {
      const rows = inserts(ops);
      const t = rows.find((r) => r.tipo === "Transferencia");
      const ajuste = rows.find((r) => r.tipo === "Ajuste");
      const saldo = ctxSheet.cuentas.find((c) => norm(c.nombre) === "deel")?.saldo;
      const dif = typeof saldo === "number" ? Math.round((1200 - saldo) * 100) / 100 : null;
      const checks = [
        [t && norm(t.cuentaOrigen) === "deel" && norm(t.cuentaDestino).includes("nu"), "Transferencia Deel → Nu"],
        [t?.montoOrigen === 800 && t?.monedaOrigen === "USD", "800 USD de origen"],
        [t?.montoDestino === 2_514_956, `J = (800 − 12,6) × 3194 = 2.514.956 (fue ${t?.montoDestino})`],
        [!!t?.notas?.includes("Tasa real Deel: 3.194") && !!t?.notas?.includes("Comisión: 12,6 USD / 40.244 COP"), `nota con tasa y comisión (fue "${t?.notas}")`],
        [t?.trm === undefined, `M vacío: no dijo la TRM de Google (fue ${t?.trm})`],
      ];
      if (dif === null) checks.push([true, "Deel sin saldo calculado en el Sheet"]);
      else if (dif === 0) checks.push([!ajuste, "sin Ajuste (el saldo coincide)"]);
      else {
        checks.push(
          [!!ajuste && Math.abs((ajuste.montoOrigen ?? ajuste.montoDestino) - Math.abs(dif)) < 0.01, `Ajuste por ${dif} USD (saldo dicho 1200 vs Sheet ${saldo})`],
          [summary.includes("Ajuste: Deel"), "el summary muestra el Ajuste"],
        );
      }
      return checks;
    },
  },
  {
    texto: "Pasé 500 de DolarApp a Rappi a 3129, comisión 7 dólares, el dólar en Google estaba a 3221",
    esperar: (ops) => {
      const t = inserts(ops).find((r) => r.tipo === "Transferencia");
      return [
        [!!t && norm(t.cuentaOrigen).includes("dolarapp") && norm(t.cuentaDestino).includes("rappi"), "DolarApp → Rappi"],
        [t?.montoOrigen === 500 && t?.monedaOrigen === "USD", "500 USD de origen"],
        [t?.montoDestino === 1_542_597, `J = (500 − 7) × 3129 = 1.542.597 (fue ${t?.montoDestino})`],
        [t?.trm === 3221, `M = TRM de Google 3221 (fue ${t?.trm})`],
        [!!t?.notas?.includes("Tasa real DolarApp") && !!t?.notas?.includes("3.129") && !!t?.notas?.includes("Comisión: 7 USD / 21.903 COP"), `nota con tasa y comisión (fue "${t?.notas}")`],
      ];
    },
  },
  {
    texto: "Mandé 300 dólares de Deel a Nu",
    // Sin tasa ni monto recibido: debe preguntar; con la respuesta, armar el borrador.
    pregunta: true,
    respuesta: "me llegaron 940 mil",
    esperar: (ops) => {
      const t = inserts(ops).find((r) => r.tipo === "Transferencia");
      return [
        [t?.montoOrigen === 300 && t?.monedaOrigen === "USD", "300 USD de origen"],
        [t?.montoDestino === 940_000 && t?.monedaDestino === "COP", `940.000 COP recibidos (fue ${t?.montoDestino})`],
      ];
    },
  },
];

const resultados = [];
async function probarCasos() {
  for (const [i, caso] of CASOS.entries()) {
    let nombre = `${i + 1}. "${caso.texto}"`;
    let r = await api("POST", "/api/parse", { text: caso.texto });
    let res = { caso: caso.texto, status: r.status, ms: r.ms, respuesta: r.json };
    resultados.push(res);
    if (r.status !== 200) {
      check("Parse", nombre, "fail", `${r.status} en ${r.ms} ms: ${r.json.error ?? JSON.stringify(r.json)}`);
      continue;
    }

    if (caso.pregunta) {
      if (r.json.status !== "question") {
        check("Parse", nombre, "fail", `esperaba una pregunta y llegó status "${r.json.status}": ${r.json.summary ?? ""}`);
        continue;
      }
      const q = r.json.question;
      const simbolos = /[→$*#_`<>|]/.test(q);
      const historyOk = r.json.history?.at(-1)?.q === q && r.json.history?.at(-1)?.a === "";
      check("Parse", `${nombre} → pregunta`, simbolos || !historyOk ? "warn" : "ok",
        `${r.ms} ms — "${q}"${simbolos ? " (tiene símbolos)" : ""}${historyOk ? "" : " (history sin la pregunta pendiente)"}`);
      // Lo que hace el Atajo: reenviar history y la respuesta dictada.
      r = await api("POST", "/api/parse", { text: caso.texto, history: r.json.history, answer: caso.respuesta });
      nombre = `${nombre} + respuesta "${caso.respuesta}"`;
      res = { caso: `${caso.texto} + respuesta "${caso.respuesta}"`, status: r.status, ms: r.ms, respuesta: r.json };
      resultados.push(res);
      if (r.status !== 200 || r.json.status !== "ok") {
        check("Parse", nombre, "fail", `${r.status} en ${r.ms} ms: ${r.json.error ?? `status "${r.json.status}" ${r.json.question ?? ""}`}`);
        continue;
      }
    } else if (r.json.status !== "ok") {
      check("Parse", nombre, "warn", `${r.ms} ms — preguntó en vez de suponer: "${r.json.question}"`);
      continue;
    }

    res.operations = decodeDraft(r.json.draft);
    const fallidas = caso.esperar(res.operations, r.json.summary).filter(([ok]) => !ok).map(([, d]) => d);
    for (const op of res.operations) {
      const nota = op.action === "insert" ? op.row.notas : op.set?.notas;
      if (!nota) continue;
      const esperado = op.action === "insert" && op.row.tipo === "Ajuste" ? `(${nota})` : `Nota: ${nota}`;
      if (!r.json.summary.includes(esperado)) fallidas.push(`el summary no muestra la nota "${nota}"`);
    }
    res.expectativasFallidas = fallidas;
    const lento = r.ms > 20_000 ? ` — LENTO (límite de Vercel: 30 s)` : "";
    check("Parse", nombre, fallidas.length ? "warn" : "ok", `${r.ms} ms${lento}${fallidas.length ? ` — no cumple: ${fallidas.join(", ")}` : ""}`);
  }
}

async function probarCorreccion() {
  const base = resultados[0];
  if (base?.status !== 200) return check("Corrección", "previousDraft + correction", "warn", "omitido: el caso 1 falló");
  const destino = ctxSheet.cuentas.find((c) => c.moneda === "COP" && !norm(c.nombre).includes("nu"))?.nombre ?? "Rappi";
  const correction = `no, fue con ${destino}`;
  const r = await api("POST", "/api/parse", { text: CASOS[0].texto, previousDraft: base.respuesta.draft, correction });
  const res = { caso: `corrección: "${correction}"`, status: r.status, ms: r.ms, respuesta: r.json };
  resultados.push(res);
  if (r.status !== 200 || r.json.status !== "ok") return check("Corrección", correction, "fail", `${r.status}: ${r.json.error ?? r.json.question}`);
  res.operations = decodeDraft(r.json.draft);
  const [row] = inserts(res.operations);
  const ok = row?.cuentaOrigen === destino && row?.montoOrigen === 32000;
  check("Corrección", correction, ok ? "ok" : "warn", `${r.ms} ms — cuenta ${row?.cuentaOrigen}, monto ${row?.montoOrigen}`);
}

async function probarErrores() {
  const r1 = await api("POST", "/api/parse", { text: "" });
  check("Errores", "parse con texto vacío → 400", r1.status === 400 ? "ok" : "fail", `${r1.status}`);
  const r2 = await api("POST", "/api/commit", { draft: "no-es-un-draft" });
  check("Errores", "commit con draft inválido → 400", r2.status === 400 ? "ok" : "fail", `${r2.status}`);
  const r3 = await api("POST", "/api/parse", { text: "x", correction: "y" });
  check("Errores", "correction sin previousDraft → 400", r3.status === 400 ? "ok" : "fail", `${r3.status}`);
}

// ---------------------------------------------------------------- 6. Commit real + undo
const ERROR_FORMULA = /^#(ERROR|NAME|VALUE|REF|N\/A|DIV)/;
const letra = (i) => String.fromCharCode(65 + i);
const pad = (fila) => Array.from({ length: 17 }, (_, i) => fila[i] ?? "");
// Fórmula sin el número de fila, para comparar fórmulas de filas distintas.
const sinFila = (f, n) => String(f ?? "").replace(new RegExp(`([A-Q])${n}(?!\\d)`, "g"), "$1#");

async function leerFila(n) {
  const get = async (opt) =>
    pad(
      (
        await sheets.spreadsheets.values.get({
          spreadsheetId: env.SHEET_ID,
          range: `Movimientos!A${n}:Q${n}`,
          valueRenderOption: opt,
          dateTimeRenderOption: "SERIAL_NUMBER",
        })
      ).data.values?.[0] ?? [],
    );
  const [crudo, formato, formula] = await Promise.all([get("UNFORMATTED_VALUE"), get("FORMATTED_VALUE"), get("FORMULA")]);
  return { crudo, formato, formula };
}

const erroresDe = (f) =>
  f.formato.flatMap((v, i) => (ERROR_FORMULA.test(String(v)) ? [`${letra(i)}: ${v} (${f.formula[i]})`] : []));

async function probarCommit() {
  if (!DO_COMMIT) return check("Commit", "escritura real", "warn", "omitida (corre con --commit para probar commit + undo en el Sheet)");
  if (!sheets) return check("Commit", "escritura real", "warn", "omitida: requiere SHEET_ID");
  const base = resultados[0];
  if (base?.status !== 200) return check("Commit", "escritura real", "warn", "omitida: el caso 1 falló");

  // Todo marcado como PRUEBA por si el undo falla; sin conceptos nuevos (el catálogo no se deshace).
  const MARCA = "PRUEBA smoke-test, borrar si quedó";
  const cuentaUSD = ctxSheet.cuentas.find((c) => c.moneda.toUpperCase() === "USD")?.nombre;
  const insertCOP = { ...inserts(base.operations)[0], newConcept: undefined, notas: MARCA };
  const insertUSD = {
    fecha: hoy, tipo: "Gasto", cuentaOrigen: cuentaUSD, categoria: "Suscripción",
    concepto: "PRUEBA smoke-test", montoOrigen: 20, monedaOrigen: "USD", estado: "Pagado",
  };
  const ops = [insertCOP, insertUSD].map((row) => ({ action: "insert", row }));
  // Update sobre una fila Pendiente (de preferencia en USD, para que P tenga una fórmula con valor).
  const pend = ctxSheet.pendientes.find((p) => p.moneda === "USD") ?? ctxSheet.pendientes[0];
  let antesUpdate;
  if (pend) {
    antesUpdate = await leerFila(pend.fila);
    resultados.push({ caso: `respaldo de la fila ${pend.fila} antes del update`, status: "-", ms: 0, respuesta: { formula: antesUpdate.formula } });
    ops.push({ action: "update", rowNumber: pend.fila, expectedConcepto: String(pend.concepto).trim(), set: { estado: "Pagado", notas: MARCA } });
  }

  const draft = Buffer.from(JSON.stringify(ops)).toString("base64url");
  const c = await api("POST", "/api/commit", { draft });
  resultados.push({ caso: "commit de prueba", status: c.status, ms: c.ms, respuesta: c.json });
  if (c.status !== 200) return check("Commit", "POST /api/commit", "fail", `${c.status}: ${c.json.error}`);
  check("Commit", "POST /api/commit", "ok", `${c.ms} ms — ${c.json.message}`);
  const { rows, previous } = c.json;
  if (pend) {
    const p = previous?.find((x) => x.rowNumber === pend.fila);
    const esperado = { O: antesUpdate.formula[14], P: antesUpdate.formula[15] };
    const ok = p && p.values.O === esperado.O && p.values.P === esperado.P;
    check("Commit", "respuesta trae los valores previos del update", ok ? "ok" : "fail", JSON.stringify(previous));
  }

  try {
    const [nCOP, nUSD] = rows;
    const cop = await leerFila(nCOP);
    const detalle = `A: ${JSON.stringify(cop.crudo[0])} (se ve "${cop.formato[0]}"), B: "${cop.formato[1]}", Q: ${JSON.stringify(cop.crudo[16])}`;
    check("Commit", `columna A de la fila ${nCOP} es fecha`, typeof cop.crudo[0] === "number" ? "ok" : "fail",
      typeof cop.crudo[0] === "number" ? detalle : `${detalle}\nA quedó como texto: hay que escribir la fecha como número serial.`);
    const mes = insertCOP.fecha.slice(0, 7);
    check("Commit", `fórmula B (Mes) en la fila ${nCOP}`, cop.formato[1] === mes ? "ok" : "fail", `esperaba "${mes}", quedó "${cop.formato[1]}" — ${cop.formula[1]}`);
    if (insertCOP.monedaOrigen === "COP") {
      check("Commit", `fórmula Q en la fila ${nCOP}`, cop.crudo[16] === insertCOP.montoOrigen ? "ok" : "fail", `esperaba ${insertCOP.montoOrigen}, quedó ${JSON.stringify(cop.crudo[16])}`);
    }

    const usd = await leerFila(nUSD);
    const qEsperado = ctxSheet.trm ? 20 * ctxSheet.trm : null;
    check("Commit", `fórmula Q en la fila USD ${nUSD}`, qEsperado === null || Math.abs(usd.crudo[16] - qEsperado) < 0.01 ? "ok" : "fail",
      `esperaba ${qEsperado} (20 × TRM ${ctxSheet.trm}), quedó ${JSON.stringify(usd.crudo[16])}`);
    const pFormato = /^≈ \$[\d.]+ COP \(tasa [\d.]+,\d{2}\)$/;
    check("Commit", `P en la fila USD ${nUSD} conserva los formatos "#,##0"`, pFormato.test(usd.formato[15]) ? "ok" : "fail",
      `se ve "${usd.formato[15]}" — ${usd.formula[15]}`);

    for (const [n, f] of [[nCOP, cop], [nUSD, usd]]) {
      const e = erroresDe(f);
      check("Commit", `sin errores de fórmula en la fila ${n}`, e.length ? "fail" : "ok", e.join("; "));
    }
    if (pend) {
      const u = await leerFila(pend.fila);
      check("Commit", `update de la fila ${pend.fila}`, u.formato[14] === "Pagado" && u.formato[15] === MARCA ? "ok" : "fail",
        `O: "${u.formato[14]}", P: "${u.formato[15]}"`);
    }
  } finally {
    // El Atajo reenvía la respuesta del commit tal cual.
    const u = await api("POST", "/api/undo", { rows, previous });
    resultados.push({ caso: "undo de prueba", status: u.status, ms: u.ms, respuesta: u.json });
    check("Commit", "POST /api/undo", u.status === 200 ? "ok" : "fail",
      u.status === 200
        ? u.json.message
        : `${u.status}: ${u.json.error} — BORRA A MANO las filas ${rows.join(", ")} (marca "PRUEBA smoke-test")` +
            (pend ? ` y restaura la fila ${pend.fila} con el respaldo del reporte` : ""));
    if (u.status === 200) {
      for (const n of rows) {
        const f = await leerFila(n);
        const sucias = [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14].filter((i) => f.formula[i] !== "").map(letra);
        check("Commit", `fila ${n} limpia después del undo`, sucias.length ? "fail" : "ok", sucias.length ? `quedaron datos en ${sucias.join(", ")}` : "");
        const e = erroresDe(f);
        check("Commit", `sin errores de fórmula en la fila ${n} después del undo`, e.length ? "fail" : "ok", e.join("; "));
        if (ctxSheet.formulaPUSD) {
          const igual = sinFila(f.formula[15], n) === sinFila(ctxSheet.formulaPUSD.formula, ctxSheet.formulaPUSD.fila);
          check("Commit", `fórmula P escrita por la API en la fila ${n} = la de la fila USD ${ctxSheet.formulaPUSD.fila}`, igual ? "ok" : "fail",
            igual ? "" : `API: ${f.formula[15]}\nSheet: ${ctxSheet.formulaPUSD.formula}`);
        }
      }
      if (pend) {
        const despues = await leerFila(pend.fila);
        const difs = antesUpdate.formula.flatMap((v, i) =>
          v !== despues.formula[i] || antesUpdate.formato[i] !== despues.formato[i]
            ? [`${letra(i)}: antes ${JSON.stringify(antesUpdate.formula[i])} ("${antesUpdate.formato[i]}"), ahora ${JSON.stringify(despues.formula[i])} ("${despues.formato[i]}")`]
            : [],
        );
        check("Commit", `fila ${pend.fila} idéntica a antes del update`, difs.length ? "fail" : "ok",
          difs.length ? difs.join("\n") : `O: "${despues.formato[14]}", P: "${despues.formato[15] || "(vacío)"}"`);
      }
    }
  }
}

// ---------------------------------------------------------------- Reporte
function escribirReporte() {
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  fs.mkdirSync("reports", { recursive: true });
  const cuenta = (s) => checks.filter((c) => c.status === s).length;
  const icon = { ok: "✅", warn: "⚠️", fail: "❌" };
  const tabla = (filtro) =>
    checks
      .filter(filtro)
      .map((c) => `| ${icon[c.status]} | ${c.seccion} | ${c.nombre} | ${c.detalle.replace(/\|/g, "\\|").replace(/\n/g, "<br>")} |`)
      .join("\n");
  const problemas = checks.filter((c) => c.status !== "ok");
  const casos = resultados
    .map((r) => {
      const ops = r.operations ? `\n<details><summary>operations</summary>\n\n\`\`\`json\n${JSON.stringify(r.operations, null, 2)}\n\`\`\`\n</details>` : "";
      const cuerpo = r.respuesta?.summary
        ? `\`\`\`\n${r.respuesta.summary}\n\`\`\``
        : `\`\`\`json\n${JSON.stringify(r.respuesta, null, 2)}\n\`\`\``;
      const exp = r.expectativasFallidas?.length ? `\n**No cumple:** ${r.expectativasFallidas.join(", ")}\n` : "";
      return `### ${r.caso}\nstatus ${r.status} · ${r.ms} ms\n\n${cuerpo}\n${exp}${ops}`;
    })
    .join("\n\n");
  const md = `# Smoke test — ${new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" })}

Servidor: ${BASE} · Modelo: ${MODEL} · Sheet: ${env.SHEET_ID ? "real" : "mock"} · Commit real: ${DO_COMMIT ? "sí" : "no"}

**${cuenta("ok")} ok · ${cuenta("warn")} avisos · ${cuenta("fail")} fallas**

## Problemas
${problemas.length ? `| | Sección | Prueba | Detalle |\n|---|---|---|---|\n${tabla((c) => c.status !== "ok")}` : "Ninguno."}

## Todas las pruebas
| | Sección | Prueba | Detalle |
|---|---|---|---|
${tabla(() => true)}

## Respuestas
${redactar(casos)}

## Log del servidor
\`\`\`
${redactar(serverLog.split("\n").slice(-200).join("\n")) || "(sin salida)"}
\`\`\`
`;
  const base = path.join("reports", `smoke-${stamp}`);
  fs.writeFileSync(`${base}.md`, md);
  fs.writeFileSync(`${base}.json`, redactar(JSON.stringify({ base: BASE, model: MODEL, checks, resultados, serverLog }, null, 2)));
  console.log(`\nReporte: ${base}.md (${cuenta("ok")} ok, ${cuenta("warn")} avisos, ${cuenta("fail")} fallas)`);
  return cuenta("fail");
}

// ---------------------------------------------------------------- main
let fallas = 0;
try {
  probarEntorno();
  await probarSheets();
  await probarAnthropic();
  if (await levantarServidor()) {
    await probarServidor();
    await probarCasos();
    await probarCorreccion();
    await probarErrores();
    await probarCommit();
  }
} catch (err) {
  check("Script", "error inesperado", "fail", err.stack || String(err));
} finally {
  fallas = escribirReporte();
  server?.kill();
}
process.exit(fallas ? 1 : 0);
