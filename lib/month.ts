import { fechaISO } from "./data";
import { fechaCorta } from "./fechas";
import {
  HOJA,
  PRIMERA_FILA,
  RANGO_MOVIMIENTOS,
  ULTIMA_FILA,
  cell,
  filaTieneDatos,
  insertWrites,
  isEmpty,
  siguienteFila,
  type Cell,
  type Write,
} from "./rows";
import type { Filtro, InsertRow, Operation } from "./schema";
import { tramos, type SheetRepo } from "./sheet/repo";
import { norm } from "./validate";

export const HOJA_PLANTILLA = "Plantilla Mensual";
export const PRIMERA_FILA_PLANTILLA = 5;
export const RANGO_PLANTILLA = `'${HOJA_PLANTILLA}'!A${PRIMERA_FILA_PLANTILLA}:P200`;

const texto = (v: Cell | undefined) => (v === undefined || v === null ? "" : String(v).trim());
const numero = (v: Cell | undefined) => (typeof v === "number" ? v : undefined);

export function mesAnterior(mes: string): string {
  const [y, m] = mes.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** Fecha ISO de la columna A, o "" si no hay una fecha. */
export function fechaFila(row: Cell[] | undefined): string {
  const a = cell(row, "A");
  if (isEmpty(a)) return "";
  const iso = fechaISO(a);
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : "";
}

/** Mes de la fila: la columna B si es "yyyy-mm"; si no, el de la fecha en A. */
export function mesFila(row: Cell[] | undefined): string {
  const b = texto(cell(row, "B"));
  if (/^\d{4}-\d{2}$/.test(b)) return b;
  return fechaFila(row).slice(0, 7);
}

const esPendiente = (row: Cell[] | undefined) => norm(texto(cell(row, "O"))) === "pendiente";

// ---------------------------------------------------------------- Inicio de mes

/** Filas de la Plantilla Mensual (las que tienen Tipo en C), como filas a insertar sin fecha. */
export function leerPlantilla(values: Cell[][]): InsertRow[] {
  return values.flatMap((r) => {
    const tipo = texto(cell(r, "C"));
    if (!tipo) return [];
    const row: Record<string, unknown> = {
      fecha: "",
      tipo,
      cuentaOrigen: texto(cell(r, "D")) || undefined,
      cuentaDestino: texto(cell(r, "E")) || undefined,
      categoria: texto(cell(r, "F")),
      concepto: texto(cell(r, "G")),
      montoOrigen: numero(cell(r, "H")),
      monedaOrigen: texto(cell(r, "I")) || undefined,
      montoDestino: numero(cell(r, "J")),
      monedaDestino: texto(cell(r, "K")) || undefined,
      trm: numero(cell(r, "M")),
      estado: "Pendiente",
      notas: texto(cell(r, "P")) || undefined,
    };
    for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k];
    return [row as InsertRow];
  });
}

export interface PlanInicio {
  mes: string;
  /** Filas a insertar, con fecha día 1 y estado Pendiente. */
  nuevas: InsertRow[];
  /** Números de fila donde irían las nuevas. */
  filas: number[];
  /** Conceptos de la plantilla que ya están el día 1 de ese mes. */
  existentes: string[];
  /** Cuántas nuevas toman el monto del mes anterior (fila del día 1 que quedó Pagado). */
  delMesAnterior: number;
  totalPlantilla: number;
}

/**
 * Plan de inicio de mes: una fila por concepto de la plantilla con A = día 1 y O = Pendiente.
 * No duplica conceptos que ya están el día 1 de ese mes. El monto sale de la fila del mismo concepto
 * del día 1 del mes anterior si quedó Pagado; si no, de la plantilla.
 */
export function planStartMonth(
  plantillaValues: Cell[][],
  movimientos: Cell[][],
  mes: string,
  inicio = siguienteFila(movimientos),
): PlanInicio {
  const plantilla = leerPlantilla(plantillaValues);
  const dia1 = `${mes}-01`;
  const dia1Anterior = `${mesAnterior(mes)}-01`;
  const yaEstan = new Set<string>();
  const pagadasAnterior = new Map<string, Cell[]>();
  for (const row of movimientos) {
    const fecha = fechaFila(row);
    const concepto = norm(texto(cell(row, "G")));
    if (!concepto) continue;
    if (fecha === dia1) yaEstan.add(concepto);
    if (fecha === dia1Anterior && norm(texto(cell(row, "O"))) === "pagado") {
      if (!pagadasAnterior.has(concepto)) pagadasAnterior.set(concepto, row);
    }
  }

  const nuevas: InsertRow[] = [];
  const existentes: string[] = [];
  let delMesAnterior = 0;
  for (const base of plantilla) {
    const clave = norm(base.concepto);
    if (yaEstan.has(clave)) {
      existentes.push(base.concepto);
      continue;
    }
    yaEstan.add(clave); // un concepto repetido en la plantilla solo entra una vez
    const row: InsertRow = { ...base, fecha: dia1 };
    const previa = pagadasAnterior.get(clave);
    if (previa) {
      const h = numero(cell(previa, "H"));
      const j = numero(cell(previa, "J"));
      let usado = false;
      if (row.montoOrigen !== undefined && h !== undefined) {
        row.montoOrigen = h;
        usado = true;
      }
      if (row.montoDestino !== undefined && j !== undefined) {
        row.montoDestino = j;
        usado = true;
      }
      if (usado) delMesAnterior++;
    }
    nuevas.push(row);
  }
  return {
    mes,
    nuevas,
    filas: nuevas.map((_, i) => inicio + i),
    existentes,
    delMesAnterior,
    totalPlantilla: plantilla.length,
  };
}

/** Escrituras de un plan de inicio de mes; `existentes` es el contenido (FORMULA) de esas filas. */
export function startMonthWrites(plan: PlanInicio, existentes: Cell[][] = []): Write[] {
  return plan.nuevas.flatMap((row, i) => insertWrites(plan.filas[i], row, existentes[i]));
}

// ---------------------------------------------------------------- Ocultar / mostrar

export interface PlanFiltro {
  /** Filas que cambian de estado. */
  filas: number[];
  /** Pendientes que cumplen el filtro y se dejan visibles (solo al ocultar). */
  pendientesVisibles: number;
  /** Filas que ya estaban como se pide (ocultas al ocultar, visibles al mostrar). */
  yaEstaban: number;
}

/** Filas de Movimientos que cumplen el filtro (nunca la fila 1). */
export function filasDelFiltro(f: Filtro, movimientos: Cell[][], ocultas: Set<number>): number[] {
  const enRango = (r: number) => r >= PRIMERA_FILA && r <= ULTIMA_FILA;
  if (f.todo) return [...ocultas].filter(enRango).sort((a, b) => a - b);
  if (f.filas) return [...new Set(f.filas)].filter(enRango).sort((a, b) => a - b);
  if (f.filaDesde !== undefined && f.filaHasta !== undefined) {
    const out: number[] = [];
    for (let r = Math.max(PRIMERA_FILA, f.filaDesde); r <= Math.min(ULTIMA_FILA, f.filaHasta); r++) out.push(r);
    return out;
  }
  return movimientos.flatMap((row, i) => {
    if (!filaTieneDatos(row)) return [];
    const mes = mesFila(row);
    const fecha = fechaFila(row);
    const cumple = f.mes
      ? mes === f.mes
      : f.desde && f.hasta
        ? fecha !== "" && fecha >= f.desde && fecha <= f.hasta
        : f.antesDe
          ? mes !== "" && mes < f.antesDe
          : false;
    return cumple ? [PRIMERA_FILA + i] : [];
  });
}

/** Ocultar: por defecto no toca filas Pendiente (salvo incluirPendientes) ni las que ya están ocultas. */
export function planHide(f: Filtro, movimientos: Cell[][], ocultas: Set<number>): PlanFiltro {
  const plan: PlanFiltro = { filas: [], pendientesVisibles: 0, yaEstaban: 0 };
  for (const n of filasDelFiltro(f, movimientos, ocultas)) {
    if (ocultas.has(n)) plan.yaEstaban++;
    else if (!f.incluirPendientes && esPendiente(movimientos[n - PRIMERA_FILA])) plan.pendientesVisibles++;
    else plan.filas.push(n);
  }
  return plan;
}

export function planShow(f: Filtro, movimientos: Cell[][], ocultas: Set<number>): PlanFiltro {
  const candidatas = filasDelFiltro(f, movimientos, ocultas);
  const filas = candidatas.filter((n) => ocultas.has(n));
  return { filas, pendientesVisibles: 0, yaEstaban: candidatas.length - filas.length };
}

// ---------------------------------------------------------------- Varias operaciones juntas

export interface EstadoHoja {
  movimientos: Cell[][];
  plantilla: Cell[][];
  ocultas: Set<number>;
}

export type PlanHoja =
  | { tipo: "start_month"; plan: PlanInicio }
  | { tipo: "hide_rows" | "show_rows"; filtro: Filtro; plan: PlanFiltro };

const esDeHoja = (op: Operation) =>
  op.action === "start_month" || op.action === "hide_rows" || op.action === "show_rows";

export function necesitaHoja(ops: Operation[]) {
  return {
    plantilla: ops.some((o) => o.action === "start_month"),
    ocultas: ops.some((o) => o.action === "hide_rows" || o.action === "show_rows"),
  };
}

/** Lee lo que necesitan las operaciones de hoja (plantilla y filas ocultas solo si hacen falta). */
export async function leerEstado(
  repo: SheetRepo,
  opts: { plantilla?: boolean; ocultas?: boolean },
): Promise<EstadoHoja> {
  const [values, ocultas] = await Promise.all([
    repo.getValues([RANGO_MOVIMIENTOS, ...(opts.plantilla ? [RANGO_PLANTILLA] : [])]),
    opts.ocultas ? repo.getHiddenRows(HOJA, ULTIMA_FILA) : Promise.resolve([]),
  ]);
  return { movimientos: values[0] ?? [], plantilla: values[1] ?? [], ocultas: new Set(ocultas) };
}

/**
 * Planes de las operaciones de hoja en orden: los inicios de mes van después de `inicio` (las filas
 * de los inserts normales), y ocultar/mostrar se calculan sobre el estado que dejan las anteriores.
 * Devuelve también qué filas terminan ocultas o visibles respecto al estado inicial.
 */
export function planificarHoja(ops: Operation[], estado: EstadoHoja, inicio: number) {
  const planes: (PlanHoja | undefined)[] = [];
  const ocultas = new Set(estado.ocultas);
  const meses = new Set<string>();
  let siguiente = inicio;
  for (const op of ops) {
    if (!esDeHoja(op)) {
      planes.push(undefined);
    } else if (op.action === "start_month") {
      const plan = planStartMonth(estado.plantilla, estado.movimientos, op.mes, siguiente);
      if (meses.has(op.mes)) {
        plan.existentes = [...plan.existentes, ...plan.nuevas.map((r) => r.concepto)];
        plan.nuevas = [];
        plan.filas = [];
      }
      meses.add(op.mes);
      siguiente += plan.nuevas.length;
      planes.push({ tipo: "start_month", plan });
    } else if (op.action === "hide_rows" || op.action === "show_rows") {
      const plan = (op.action === "hide_rows" ? planHide : planShow)(op.filtro, estado.movimientos, ocultas);
      for (const n of plan.filas) {
        if (op.action === "hide_rows") ocultas.add(n);
        else ocultas.delete(n);
      }
      planes.push({ tipo: op.action, filtro: op.filtro, plan });
    }
  }
  const hidden = [...ocultas].filter((n) => !estado.ocultas.has(n)).sort((a, b) => a - b);
  const shown = [...estado.ocultas].filter((n) => !ocultas.has(n)).sort((a, b) => a - b);
  return { planes, hidden, shown, siguiente };
}

// ---------------------------------------------------------------- Textos

/** [66..96, 100] → "66–96, 100" */
export function rangosTexto(rows: number[]): string {
  return tramos(rows)
    .map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`))
    .join(", ");
}

const nFilas = (n: number) => `${n} ${n === 1 ? "fila" : "filas"}`;
const filasTexto = (rows: number[]) => `${rows.length === 1 ? "fila" : "filas"} ${rangosTexto(rows)}`;

export function describirFiltro(f: Filtro): string {
  if (f.mes) return `de ${f.mes}`;
  if (f.desde && f.hasta) return `del ${fechaCorta(f.desde)} al ${fechaCorta(f.hasta)}`;
  if (f.antesDe) return `antes de ${f.antesDe}`;
  if (f.todo) return "ocultas";
  return "";
}

/** "Inicio 2026-11: 24 filas Pendiente nuevas (filas 120–143)" */
export function lineaStartMonth(plan: PlanInicio): string {
  if (plan.totalPlantilla === 0) return `Inicio ${plan.mes}: la Plantilla Mensual no tiene filas`;
  if (plan.nuevas.length === 0) {
    return `Inicio ${plan.mes}: ya estaba hecho (${nFilas(plan.existentes.length)} de la plantilla ya existen), no agrego nada`;
  }
  let linea = `Inicio ${plan.mes}: ${nFilas(plan.nuevas.length)} Pendiente nuevas (${filasTexto(plan.filas)})`;
  if (plan.delMesAnterior > 0) linea += ` · ${plan.delMesAnterior} con el monto Pagado de ${mesAnterior(plan.mes)}`;
  if (plan.existentes.length > 0) linea += ` · ${plan.existentes.length} ya existían`;
  return linea;
}

/** "Ocultar 31 filas de 2026-09 (filas 66–96) · 2 Pendiente quedan visibles" */
export function lineaFiltro(accion: "hide_rows" | "show_rows", f: Filtro, plan: PlanFiltro): string {
  const verbo = accion === "hide_rows" ? "Ocultar" : "Mostrar";
  const desc = describirFiltro(f);
  let linea = plan.filas.length
    ? `${verbo} ${nFilas(plan.filas.length)}${desc ? ` ${desc}` : ""} (${filasTexto(plan.filas)})`
    : `${verbo} filas${desc ? ` ${desc}` : ""}: no hay filas para ${accion === "hide_rows" ? "ocultar" : "mostrar"}`;
  if (plan.pendientesVisibles > 0) {
    linea += ` · ${plan.pendientesVisibles} Pendiente ${plan.pendientesVisibles === 1 ? "queda visible" : "quedan visibles"}`;
  }
  if (plan.yaEstaban > 0) {
    const estado = accion === "hide_rows" ? "oculta" : "visible";
    linea += plan.yaEstaban === 1 ? ` · 1 ya estaba ${estado}` : ` · ${plan.yaEstaban} ya estaban ${estado}s`;
  }
  return linea;
}

export function lineaPlan(p: PlanHoja): string {
  return p.tipo === "start_month" ? lineaStartMonth(p.plan) : lineaFiltro(p.tipo, p.filtro, p.plan);
}

/** Líneas del summary para las operaciones de hoja (undefined para las demás). */
export async function previsualizar(repo: SheetRepo, ops: Operation[]): Promise<(string | undefined)[]> {
  const necesita = necesitaHoja(ops);
  if (!necesita.plantilla && !necesita.ocultas) return [];
  const estado = await leerEstado(repo, necesita);
  const inserts = ops.filter((o) => o.action === "insert").length;
  const { planes } = planificarHoja(ops, estado, siguienteFila(estado.movimientos) + inserts);
  return planes.map((p) => (p ? lineaPlan(p) : undefined));
}

// ---------------------------------------------------------------- Funciones sueltas

/** Copia la Plantilla Mensual al mes dado (sin duplicar). No oculta nada. */
export async function startMonth(repo: SheetRepo, mes: string): Promise<{ plan: PlanInicio; rows: number[] }> {
  const estado = await leerEstado(repo, { plantilla: true });
  const plan = planStartMonth(estado.plantilla, estado.movimientos, mes);
  if (plan.nuevas.length === 0) return { plan, rows: [] };
  const fin = plan.filas[plan.filas.length - 1];
  if (fin > ULTIMA_FILA) throw new Error(`No hay espacio: la hoja llega hasta la fila ${ULTIMA_FILA}`);
  const [existentes] = await repo.getFormulas([`${HOJA}!A${plan.filas[0]}:Q${fin}`]);
  await repo.batchUpdate(startMonthWrites(plan, existentes));
  return { plan, rows: plan.filas };
}

export async function hideRows(repo: SheetRepo, filtro: Filtro): Promise<PlanFiltro> {
  const estado = await leerEstado(repo, { ocultas: true });
  const plan = planHide(filtro, estado.movimientos, estado.ocultas);
  await repo.setRowsHidden(HOJA, plan.filas, true);
  return plan;
}

export async function showRows(repo: SheetRepo, filtro: Filtro): Promise<PlanFiltro> {
  const estado = await leerEstado(repo, { ocultas: true });
  const plan = planShow(filtro, estado.movimientos, estado.ocultas);
  await repo.setRowsHidden(HOJA, plan.filas, false);
  return plan;
}
