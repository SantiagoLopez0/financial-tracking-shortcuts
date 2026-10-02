import { z } from "zod";
import { FILA_CATEGORIAS, RANGO_CATALOGO, invalidarCache, parseCatalogo } from "./data";
import { HttpError } from "./http";
import {
  COLUMNAS_UPDATE,
  HOJA,
  PRIMERA_FILA,
  RANGO_MOVIMIENTOS,
  ULTIMA_FILA,
  cell,
  colLetter,
  columnasDeUpdate,
  describirFilas,
  insertWrites,
  restoreWrites,
  siguienteFila,
  undoWrites,
  updateWrites,
  type Cell,
  type ColumnaUpdate,
  type Write,
} from "./rows";
import type { InsertOperation, Operation, UpdateOperation } from "./schema";
import type { SheetRepo } from "./sheet/repo";
import { RANGO_PLANTILLA, necesitaHoja, planificarHoja, rangosTexto, startMonthWrites } from "./month";
import { norm } from "./validate";

/** Valores que tenía una fila antes de un update, para poder revertirlo con /api/undo. */
export const PrevioSchema = z.object({
  rowNumber: z.number().int().min(PRIMERA_FILA).max(ULTIMA_FILA),
  /** Concepto (G) de la fila; undo verifica que no haya cambiado antes de revertir. */
  concepto: z.string(),
  values: z.partialRecord(
    z.enum(COLUMNAS_UPDATE as [ColumnaUpdate, ...ColumnaUpdate[]]),
    z.union([z.string(), z.number(), z.boolean()]),
  ),
});
export type Previo = z.infer<typeof PrevioSchema>;

export interface Resultado {
  message: string;
  /** Filas insertadas, incluidas las de start_month (undo las limpia). */
  rows: number[];
  /** Valores anteriores de las filas actualizadas (undo los restaura). */
  previous: Previo[];
  /** Filas que este commit ocultó (undo las vuelve a mostrar). */
  hidden: number[];
  /** Filas que este commit mostró (undo las vuelve a ocultar). */
  shown: number[];
}

function plural(n: number, singular: string, pluralForm: string): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

/** Escrituras para agregar los conceptos nuevos al final de su columna en Catálogo. */
function conceptosNuevos(
  inserts: InsertOperation[],
  catalogoRows: Parameters<typeof parseCatalogo>[0],
): { writes: Write[]; omitidos: string[] } {
  const catalogo = parseCatalogo(catalogoRows);
  const siguiente = new Map<number, number>();
  const vistos = new Set<string>();
  const writes: Write[] = [];
  const omitidos: string[] = [];
  for (const { row } of inserts) {
    if (!row.newConcept) continue;
    const col = catalogo.categorias.findIndex((c) => c !== "" && norm(c) === norm(row.categoria));
    if (col < 0) {
      omitidos.push(`${row.concepto} (no hay columna ${row.categoria} en Catálogo)`);
      continue;
    }
    const clave = `${col}|${norm(row.concepto)}`;
    if (vistos.has(clave) || catalogo.conceptos[col].some((c) => norm(c) === norm(row.concepto))) {
      continue;
    }
    vistos.add(clave);
    if (!siguiente.has(col)) {
      // Última fila con algo en esa columna (catalogoRows[0] es la fila 4 de encabezados).
      let ultima = 0;
      catalogoRows.forEach((r, i) => {
        if (i > 0 && String(r[col] ?? "").trim() !== "") ultima = i;
      });
      siguiente.set(col, FILA_CATEGORIAS + ultima + 1);
    }
    const fila = siguiente.get(col)!;
    siguiente.set(col, fila + 1);
    writes.push({ range: `'Catálogo'!${colLetter(col)}${fila}`, values: [[row.concepto]] });
  }
  return { writes, omitidos };
}

export async function commit(repo: SheetRepo, ops: Operation[]): Promise<Resultado> {
  const inserts = ops.filter((o): o is InsertOperation => o.action === "insert");
  const updates = ops.filter((o): o is UpdateOperation => o.action === "update");
  const necesita = necesitaHoja(ops);

  const [[movimientos, catalogoRows, plantilla = []], ocultasAhora] = await Promise.all([
    repo.getValues([RANGO_MOVIMIENTOS, RANGO_CATALOGO, ...(necesita.plantilla ? [RANGO_PLANTILLA] : [])]),
    necesita.ocultas ? repo.getHiddenRows(HOJA, ULTIMA_FILA) : Promise.resolve([]),
  ]);

  for (const op of updates) {
    const actual = String(cell(movimientos[op.rowNumber - PRIMERA_FILA], "G")).trim();
    if (actual !== op.expectedConcepto.trim()) {
      throw new HttpError(
        409,
        `La fila ${op.rowNumber} tiene concepto "${actual}", se esperaba "${op.expectedConcepto}". Vuelve a generar el borrador.`,
      );
    }
  }

  // Los inicios de mes van después de los inserts normales; se recalculan aquí (no se duplica nada).
  const inicio = siguienteFila(movimientos);
  const hoja = planificarHoja(ops, { movimientos, plantilla, ocultas: new Set(ocultasAhora) }, inicio + inserts.length);
  const inicios = hoja.planes.flatMap((p) => (p?.tipo === "start_month" ? [p.plan] : []));
  const nuevasFilas = inserts.length + inicios.reduce((n, p) => n + p.nuevas.length, 0);
  const fin = inicio + nuevasFilas - 1;
  if (nuevasFilas > 0 && fin > ULTIMA_FILA) {
    throw new HttpError(409, `No hay espacio: la hoja llega hasta la fila ${ULTIMA_FILA}`);
  }

  // Contenido crudo (FORMULA) de las filas destino y de las filas a actualizar, en una sola lectura.
  const rangos = [
    ...(nuevasFilas > 0 ? [`${HOJA}!A${inicio}:Q${fin}`] : []),
    ...updates.map((u) => `${HOJA}!A${u.rowNumber}:Q${u.rowNumber}`),
  ];
  const crudos = rangos.length > 0 ? await repo.getFormulas(rangos) : [];
  const existentes = nuevasFilas > 0 ? crudos[0] : [];
  const filasUpdate = crudos.slice(nuevasFilas > 0 ? 1 : 0).map((r) => r[0] ?? []);

  const writes: Write[] = [];
  const rows: number[] = [];
  inserts.forEach((op, i) => {
    const n = inicio + i;
    rows.push(n);
    writes.push(...insertWrites(n, op.row, existentes[i]));
  });
  for (const plan of inicios) {
    writes.push(...startMonthWrites(plan, plan.filas.map((n) => existentes[n - inicio])));
    rows.push(...plan.filas);
  }

  const previous: Previo[] = updates.map((op, i) => ({
    rowNumber: op.rowNumber,
    concepto: op.expectedConcepto,
    values: Object.fromEntries(
      columnasDeUpdate(op).map((col): [ColumnaUpdate, Cell] => [col, cell(filasUpdate[i], col)]),
    ),
  }));
  for (const op of updates) writes.push(...updateWrites(op));

  const nuevos = conceptosNuevos(inserts, catalogoRows);
  writes.push(...nuevos.writes);

  if (writes.length > 0) await repo.batchUpdate(writes);
  await repo.setRowsHidden(HOJA, hoja.hidden, true);
  await repo.setRowsHidden(HOJA, hoja.shown, false);
  invalidarCache();

  const partes: string[] = [];
  if (inserts.length > 0) {
    const filas = rows.slice(0, inserts.length);
    partes.push(`${plural(filas.length, "movimiento", "movimientos")} (${describirFilas(filas)})`);
  }
  if (updates.length > 0) {
    partes.push(
      `${plural(updates.length, "actualización", "actualizaciones")} (${describirFilas(updates.map((u) => u.rowNumber))})`,
    );
  }
  for (const plan of inicios) {
    partes.push(
      plan.nuevas.length > 0
        ? `inicio ${plan.mes}: ${plural(plan.nuevas.length, "fila Pendiente", "filas Pendiente")} (filas ${rangosTexto(plan.filas)})`
        : `inicio ${plan.mes}: ya estaba hecho`,
    );
  }
  if (hoja.hidden.length > 0) partes.push(`${plural(hoja.hidden.length, "fila oculta", "filas ocultas")} (${rangosTexto(hoja.hidden)})`);
  if (hoja.shown.length > 0) partes.push(`${plural(hoja.shown.length, "fila visible", "filas visibles")} (${rangosTexto(hoja.shown)})`);
  let message = `Guardado: ${partes.join(", ") || "sin cambios"}`;
  if (nuevos.writes.length > 0) {
    message += `. ${plural(nuevos.writes.length, "concepto nuevo", "conceptos nuevos")} en Catálogo`;
  }
  if (nuevos.omitidos.length > 0) message += `. No agregué al catálogo: ${nuevos.omitidos.join(", ")}`;
  return { message, rows, previous, hidden: hoja.hidden, shown: hoja.shown };
}

export interface CambiosVisibilidad {
  /** Filas que el commit ocultó: se vuelven a mostrar. */
  hidden?: number[];
  /** Filas que el commit mostró: se vuelven a ocultar. */
  shown?: number[];
}

/**
 * Limpia las filas insertadas (`rows`), restaura los valores previos de las actualizadas (`previous`)
 * y revierte los cambios de visibilidad. Antes verifica que el concepto de cada fila actualizada no
 * haya cambiado.
 */
export async function undo(
  repo: SheetRepo,
  rows: number[],
  previous: Previo[] = [],
  visibilidad: CambiosVisibilidad = {},
): Promise<Resultado> {
  const unicas = [...new Set(rows)];
  const hidden = [...new Set(visibilidad.hidden ?? [])];
  const shown = [...new Set(visibilidad.shown ?? [])];
  const fuera = [...unicas, ...hidden, ...shown].filter((r) => r < PRIMERA_FILA || r > ULTIMA_FILA);
  if (fuera.length > 0) throw new HttpError(400, `Filas fuera de rango: ${[...new Set(fuera)].join(", ")}`);
  const choque = previous.find((p) => unicas.includes(p.rowNumber));
  if (choque) throw new HttpError(400, `La fila ${choque.rowNumber} está en rows y en previous`);

  if (previous.length > 0) {
    const [movimientos] = await repo.getValues([RANGO_MOVIMIENTOS]);
    for (const p of previous) {
      const actual = String(cell(movimientos[p.rowNumber - PRIMERA_FILA], "G")).trim();
      if (actual !== p.concepto.trim()) {
        throw new HttpError(
          409,
          `La fila ${p.rowNumber} ahora tiene concepto "${actual}", no "${p.concepto}"; no la revierto.`,
        );
      }
    }
  }

  // previous en orden inverso: si una fila se actualizó dos veces, queda el valor más antiguo.
  const writes = [
    ...unicas.flatMap(undoWrites),
    ...[...previous].reverse().flatMap((p) => restoreWrites(p.rowNumber, p.values)),
  ];
  if (writes.length > 0) await repo.batchUpdate(writes);
  await repo.setRowsHidden(HOJA, hidden, false);
  await repo.setRowsHidden(HOJA, shown, true);
  invalidarCache();

  const partes: string[] = [];
  if (unicas.length > 0) {
    partes.push(`${plural(unicas.length, "movimiento", "movimientos")} (${describirFilas(unicas)})`);
  }
  const revertidas = [...new Set(previous.map((p) => p.rowNumber))];
  if (revertidas.length > 0) {
    partes.push(
      `${plural(revertidas.length, "actualización revertida", "actualizaciones revertidas")} (${describirFilas(revertidas)})`,
    );
  }
  if (hidden.length > 0) partes.push(`${plural(hidden.length, "fila visible otra vez", "filas visibles otra vez")} (${rangosTexto(hidden)})`);
  if (shown.length > 0) partes.push(`${plural(shown.length, "fila oculta otra vez", "filas ocultas otra vez")} (${rangosTexto(shown)})`);
  return { message: `Deshecho: ${partes.join(", ") || "nada que deshacer"}`, rows: unicas, previous, hidden, shown };
}
