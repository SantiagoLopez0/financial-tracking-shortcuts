import type { InsertRow, UpdateOperation } from "./schema";

export type Cell = string | number | boolean;

export interface Write {
  range: string;
  values: Cell[][];
  /**
   * Valores leídos del Sheet tal cual (fórmulas ya en el formato de su configuración regional):
   * no se les cambia el separador. Sin esto, "=14+13,5" en es_CO quedaría "=14+13;5".
   */
  raw?: boolean;
}

export const HOJA = "Movimientos";
export const PRIMERA_FILA = 2;
export const ULTIMA_FILA = 3000;
export const RANGO_MOVIMIENTOS = `${HOJA}!A${PRIMERA_FILA}:Q${ULTIMA_FILA}`;

export function colIndex(col: string): number {
  return col.charCodeAt(0) - "A".charCodeAt(0);
}

export function colLetter(index: number): string {
  return String.fromCharCode("A".charCodeAt(0) + index);
}

/** Valor de la columna `col` en una fila leída desde la columna A (las filas pueden venir recortadas). */
export function cell(row: Cell[] | undefined, col: string): Cell {
  const v = row?.[colIndex(col)];
  return v === undefined || v === null ? "" : v;
}

export function isEmpty(v: Cell | undefined | null): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

export function filaTieneDatos(row: Cell[] | undefined): boolean {
  return ["A", "C", "G", "H"].some((c) => !isEmpty(cell(row, c)));
}

/** Fila destino de un insert: la siguiente a la última con algo en A, C, G o H. `values` empieza en A2. */
export function siguienteFila(values: Cell[][]): number {
  for (let i = values.length - 1; i >= 0; i--) {
    if (filaTieneDatos(values[i])) return PRIMERA_FILA + i + 1;
  }
  return PRIMERA_FILA;
}

export const COLUMNAS_FORMULA = ["B", "L", "N", "Q"] as const;

export function formulas(n: number): Record<"B" | "L" | "N" | "P" | "Q", string> {
  return {
    B: `=IF(A${n}="","",TEXT(A${n},"yyyy-mm"))`,
    L: `=IF(AND(ISNUMBER(H${n}),ISNUMBER(J${n}),H${n}<>0,I${n}<>K${n}),J${n}/H${n},"")`,
    N: `=IF(AND(ISNUMBER(H${n}),ISNUMBER(M${n}),I${n}="USD",K${n}="COP"),H${n}*M${n}-J${n},"")`,
    P: `=IF(AND(ISNUMBER(H${n}),I${n}="USD"),"≈ $"&TEXT(Q${n},"#,##0")&" COP (tasa "&IF(ISNUMBER(M${n}),TEXT(M${n},"#,##0.00"),TEXT(Cuentas!$D$3,"#,##0.00"))&")","")`,
    Q: `=IF(H${n}="","",IF(I${n}="COP",H${n},IF(ISNUMBER(M${n}),H${n}*M${n},H${n}*Cuentas!$D$3)))`,
  };
}

/**
 * Cambia el separador de argumentos de una fórmula escrita con comas ("=IF(A1,B1,C1)") al de la
 * configuración regional del Sheet. Las comas dentro de strings ("#,##0") no se tocan.
 */
export function localizarFormula(formula: string, separador: "," | ";"): string {
  if (separador === ",") return formula;
  let enString = false;
  let out = "";
  for (const ch of formula) {
    if (ch === '"') enString = !enString;
    out += ch === "," && !enString ? separador : ch;
  }
  return out;
}

function w(col: string, n: number, value: Cell): Write {
  return { range: `${HOJA}!${col}${n}`, values: [[value]] };
}

/**
 * Escrituras para insertar `row` en la fila `n`.
 * `existente` es la fila n leída con valueRenderOption FORMULA (desde la columna A):
 * B, L, N, Q solo se escriben si están vacías; P lleva la nota o, si no hay, la fórmula si está vacía.
 */
export function insertWrites(n: number, row: InsertRow, existente: Cell[] = []): Write[] {
  const out: Write[] = [
    w("A", n, row.fecha),
    {
      range: `${HOJA}!C${n}:K${n}`,
      values: [
        [
          row.tipo,
          row.cuentaOrigen ?? "",
          row.cuentaDestino ?? "",
          row.categoria,
          row.concepto,
          row.montoOrigen ?? "",
          row.monedaOrigen ?? "",
          row.montoDestino ?? "",
          row.monedaDestino ?? "",
        ],
      ],
    },
    w("M", n, row.trm ?? ""),
    w("O", n, row.estado),
  ];
  const f = formulas(n);
  if (row.notas) out.push(w("P", n, row.notas));
  else if (isEmpty(cell(existente, "P"))) out.push(w("P", n, f.P));
  for (const col of COLUMNAS_FORMULA) {
    if (isEmpty(cell(existente, col))) out.push(w(col, n, f[col]));
  }
  return out;
}

/** Columna que escribe cada campo de un update, en orden de columna. */
export const CAMPOS_UPDATE = {
  fecha: "A",
  cuentaOrigen: "D",
  montoOrigen: "H",
  estado: "O",
  notas: "P",
} as const satisfies Record<keyof UpdateOperation["set"], string>;

export type ColumnaUpdate = (typeof CAMPOS_UPDATE)[keyof typeof CAMPOS_UPDATE];
export const COLUMNAS_UPDATE = Object.values(CAMPOS_UPDATE) as ColumnaUpdate[];

/** Columnas que toca un update. */
export function columnasDeUpdate(op: UpdateOperation): ColumnaUpdate[] {
  return (Object.keys(CAMPOS_UPDATE) as (keyof typeof CAMPOS_UPDATE)[])
    .filter((campo) => op.set[campo] !== undefined)
    .map((campo) => CAMPOS_UPDATE[campo]);
}

export function updateWrites(op: UpdateOperation): Write[] {
  return (Object.keys(CAMPOS_UPDATE) as (keyof typeof CAMPOS_UPDATE)[])
    .filter((campo) => op.set[campo] !== undefined)
    .map((campo) => w(CAMPOS_UPDATE[campo], op.rowNumber, op.set[campo]!));
}

/** Restaura celdas con los valores leídos antes de un update (crudos, con valueRenderOption FORMULA). */
export function restoreWrites(n: number, values: Partial<Record<ColumnaUpdate, Cell>>): Write[] {
  return COLUMNAS_UPDATE.filter((col) => values[col] !== undefined).map((col) => ({
    ...w(col, n, values[col]!),
    raw: true,
  }));
}

/** Limpia las columnas de entrada de la fila n y restaura la fórmula de P. No toca B, L, N, Q. */
export function undoWrites(n: number): Write[] {
  return [
    w("A", n, ""),
    { range: `${HOJA}!C${n}:K${n}`, values: [Array<Cell>(9).fill("")] },
    w("M", n, ""),
    w("O", n, ""),
    w("P", n, formulas(n).P),
  ];
}

/** "fila 67", "filas 67-68" o "filas 67, 70". */
export function describirFilas(rows: number[]): string {
  if (rows.length === 1) return `fila ${rows[0]}`;
  const sorted = [...rows].sort((a, b) => a - b);
  const contiguas = sorted.every((r, i) => i === 0 || r === sorted[i - 1] + 1);
  return contiguas
    ? `filas ${sorted[0]}-${sorted[sorted.length - 1]}`
    : `filas ${sorted.join(", ")}`;
}
