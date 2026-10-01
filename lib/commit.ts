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
  /** Filas insertadas (undo las limpia). */
  rows: number[];
  /** Valores anteriores de las filas actualizadas (undo los restaura). */
  previous: Previo[];
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

  const [movimientos, catalogoRows] = await repo.getValues([RANGO_MOVIMIENTOS, RANGO_CATALOGO]);

  for (const op of updates) {
    const actual = String(cell(movimientos[op.rowNumber - PRIMERA_FILA], "G")).trim();
    if (actual !== op.expectedConcepto.trim()) {
      throw new HttpError(
        409,
        `La fila ${op.rowNumber} tiene concepto "${actual}", se esperaba "${op.expectedConcepto}". Vuelve a generar el borrador.`,
      );
    }
  }

  const inicio = siguienteFila(movimientos);
  const fin = inicio + inserts.length - 1;
  if (inserts.length > 0 && fin > ULTIMA_FILA) {
    throw new HttpError(409, `No hay espacio: la hoja llega hasta la fila ${ULTIMA_FILA}`);
  }

  // Contenido crudo (FORMULA) de las filas destino y de las filas a actualizar, en una sola lectura.
  const rangos = [
    ...(inserts.length > 0 ? [`${HOJA}!A${inicio}:Q${fin}`] : []),
    ...updates.map((u) => `${HOJA}!A${u.rowNumber}:Q${u.rowNumber}`),
  ];
  const crudos = rangos.length > 0 ? await repo.getFormulas(rangos) : [];
  const existentes = inserts.length > 0 ? crudos[0] : [];
  const filasUpdate = crudos.slice(inserts.length > 0 ? 1 : 0).map((r) => r[0] ?? []);

  const writes: Write[] = [];
  const rows: number[] = [];
  inserts.forEach((op, i) => {
    const n = inicio + i;
    rows.push(n);
    writes.push(...insertWrites(n, op.row, existentes[i]));
  });

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

  await repo.batchUpdate(writes);
  invalidarCache();

  const partes: string[] = [];
  if (rows.length > 0) {
    partes.push(`${plural(rows.length, "movimiento", "movimientos")} (${describirFilas(rows)})`);
  }
  if (updates.length > 0) {
    partes.push(
      `${plural(updates.length, "actualización", "actualizaciones")} (${describirFilas(updates.map((u) => u.rowNumber))})`,
    );
  }
  let message = `Guardado: ${partes.join(", ")}`;
  if (nuevos.writes.length > 0) {
    message += `. ${plural(nuevos.writes.length, "concepto nuevo", "conceptos nuevos")} en Catálogo`;
  }
  if (nuevos.omitidos.length > 0) message += `. No agregué al catálogo: ${nuevos.omitidos.join(", ")}`;
  return { message, rows, previous };
}

/**
 * Limpia las filas insertadas (`rows`) y restaura los valores previos de las actualizadas (`previous`),
 * todo en un solo batchUpdate. Antes verifica que el concepto de cada fila actualizada no haya cambiado.
 */
export async function undo(repo: SheetRepo, rows: number[], previous: Previo[] = []): Promise<Resultado> {
  const unicas = [...new Set(rows)];
  const fuera = unicas.filter((r) => r < PRIMERA_FILA || r > ULTIMA_FILA);
  if (fuera.length > 0) throw new HttpError(400, `Filas fuera de rango: ${fuera.join(", ")}`);
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
  await repo.batchUpdate(writes);
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
  return { message: `Deshecho: ${partes.join(", ")}`, rows: unicas, previous };
}
