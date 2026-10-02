import { serialToISO } from "./fechas";
import { RANGO_MOVIMIENTOS, PRIMERA_FILA, cell, filaTieneDatos, isEmpty, type Cell } from "./rows";
import type { SheetRepo } from "./sheet/repo";

export const RANGO_CUENTAS = "Cuentas!A6:C13";
export const RANGO_TRM = "Cuentas!D3";
export const RANGO_CATALOGO = "'Catálogo'!A4:H29";
export const FILA_CATEGORIAS = 4;

export interface Cuenta {
  nombre: string;
  moneda: string;
  /** Saldo calculado (columna C): suma de movimientos Pagado. */
  saldo: number | null;
}

export interface Catalogo {
  /** Columna A..H → categoría (fila 4). */
  categorias: string[];
  /** Conceptos por columna, en el mismo orden que `categorias`. */
  conceptos: string[][];
}

export interface Movimiento {
  fila: number;
  fecha: string;
  tipo: string;
  cuentaOrigen: string;
  cuentaDestino: string;
  categoria: string;
  concepto: string;
  montoOrigen: Cell;
  monedaOrigen: string;
  montoDestino: Cell;
  monedaDestino: string;
  estado: string;
}

export interface DatosHoja {
  cuentas: Cuenta[];
  trmReferencia: number | null;
  catalogo: Catalogo;
  /** Últimas 25 filas con datos. */
  recientes: Movimiento[];
  /** Todas las filas con Estado "Pendiente". */
  pendientes: Movimiento[];
}

const TTL_MS = 60_000;
const g = globalThis as unknown as { __datosCache?: { at: number; datos: DatosHoja } };

export function invalidarCache(): void {
  g.__datosCache = undefined;
}

export async function cargarDatos(repo: SheetRepo, now = Date.now()): Promise<DatosHoja> {
  const cached = g.__datosCache;
  if (cached && now - cached.at < TTL_MS) return cached.datos;
  const [cuentas, trm, catalogo, movimientos] = await repo.getValues([
    RANGO_CUENTAS,
    RANGO_TRM,
    RANGO_CATALOGO,
    RANGO_MOVIMIENTOS,
  ]);
  const datos = construirDatos(cuentas, trm, catalogo, movimientos);
  g.__datosCache = { at: now, datos };
  return datos;
}

const texto = (v: Cell | undefined) => (v === undefined || v === null ? "" : String(v).trim());

function fechaISO(v: Cell): string {
  if (typeof v === "number") return serialToISO(v);
  return texto(v);
}

export function parseCatalogo(rows: Cell[][]): Catalogo {
  const [header = [], ...resto] = rows;
  const categorias = header.map(texto);
  const conceptos = categorias.map((_, c) =>
    resto.map((r) => texto(r[c])).filter((s) => s !== ""),
  );
  return { categorias, conceptos };
}

export function parseMovimientos(values: Cell[][]): Movimiento[] {
  const out: Movimiento[] = [];
  values.forEach((row, i) => {
    if (!filaTieneDatos(row)) return;
    out.push({
      fila: PRIMERA_FILA + i,
      fecha: fechaISO(cell(row, "A")),
      tipo: texto(cell(row, "C")),
      cuentaOrigen: texto(cell(row, "D")),
      cuentaDestino: texto(cell(row, "E")),
      categoria: texto(cell(row, "F")),
      concepto: texto(cell(row, "G")),
      montoOrigen: cell(row, "H"),
      monedaOrigen: texto(cell(row, "I")),
      montoDestino: cell(row, "J"),
      monedaDestino: texto(cell(row, "K")),
      estado: texto(cell(row, "O")),
    });
  });
  return out;
}

export function construirDatos(
  cuentasRows: Cell[][],
  trmRows: Cell[][],
  catalogoRows: Cell[][],
  movimientosRows: Cell[][],
): DatosHoja {
  const cuentas = cuentasRows
    .map((r) => ({
      nombre: texto(r[0]),
      moneda: texto(r[1]).toUpperCase(),
      saldo: typeof r[2] === "number" ? r[2] : null,
    }))
    .filter((c) => c.nombre !== "");
  const trm = trmRows[0]?.[0];
  const movimientos = parseMovimientos(movimientosRows);
  return {
    cuentas,
    trmReferencia: typeof trm === "number" ? trm : isEmpty(trm) ? null : Number(trm) || null,
    catalogo: parseCatalogo(catalogoRows),
    recientes: movimientos.slice(-25),
    pendientes: movimientos.filter((m) => m.estado.toLowerCase() === "pendiente"),
  };
}
