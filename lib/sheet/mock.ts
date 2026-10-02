import { colIndex, formulas, type Cell, type Write } from "../rows";
import { hoyBogota, sumarDias } from "../fechas";
import type { SheetRepo } from "./repo";

/** "'Catálogo'!A5:H29" o "Movimientos!A67" → hoja + rectángulo (filas/columnas 0-indexadas, inclusivas). */
export function parseA1(range: string) {
  const m = range.match(/^(?:'((?:[^']|'')+)'|([^!]+))!([A-Z])(\d+)(?::([A-Z])(\d+))?$/);
  if (!m) throw new Error(`Rango A1 no soportado: ${range}`);
  const sheet = (m[1] ?? m[2]).replace(/''/g, "'");
  const r1 = Number(m[4]) - 1;
  const c1 = colIndex(m[3]);
  return {
    sheet,
    r1,
    c1,
    r2: m[6] ? Number(m[6]) - 1 : r1,
    c2: m[5] ? colIndex(m[5]) : c1,
  };
}

/**
 * Sheet en memoria para probar sin SHEET_ID. No evalúa fórmulas: getValues devuelve el contenido
 * crudo, y las fechas quedan como texto ISO (el Sheet real las devuelve como número serial).
 */
export class MockSheetRepo implements SheetRepo {
  readonly sheets = new Map<string, Cell[][]>();
  /** Filas ocultas por hoja (1-indexadas). */
  readonly hidden = new Map<string, Set<number>>();

  constructor() {
    const hoy = hoyBogota();
    // Plantilla Mensual: datos desde la fila 5, columnas A..P (A y B vacías, como en el Sheet real).
    this.set("Plantilla Mensual", "A5", [
      ["", "", "Ingreso", "", "Deel", "Ingreso", "Benor", "", "USD", 1198, "USD", "", "", "", "Pagado", ""],
      ["", "", "Gasto", "Nu Bank", "", "Fijo", "Arriendo", 1_800_000, "COP", "", "", "", "", "", "Pendiente", ""],
      ["", "", "Gasto", "Nu Bank", "", "Fijo", "Internet", 95_000, "COP", "", "", "", "", "", "Pendiente", ""],
      ["", "", "Gasto", "Nu Bank", "", "Suscripción", "Netflix", 45_000, "COP", "", "", "", "", "", "Pendiente", ""],
    ]);
    this.set("Cuentas", "D3", [[3900]]);
    this.set("Cuentas", "A6", [
      ["Nu Bank", "COP", 2_500_000],
      ["Bancolombia", "COP", 0],
      ["Rappi", "COP", 600_000],
      ["Ahorro", "COP", 130_000],
      ["Efectivo", "COP", 50_000],
      ["Deel", "USD", 1212],
      ["DolarApp (ARQ)", "USD", 480],
    ]);
    this.set("Catálogo", "A4", [
      ["Fijo", "Variable", "Suscripción", "Deuda", "Ingreso", "Conversión", "Ahorro", "Ajuste"],
      ["Arriendo", "Mercado", "Netflix", "Tarjeta de crédito", "Benor", "USD → COP", "Ahorro", "Ajuste"],
      ["Luz", "Comida", "Spotify", "", "Freelance", "", "", ""],
      ["Agua", "Transporte", "ChatGPT", "", "", "", "", ""],
      ["Internet", "Ocio", "", "", "", "", "", ""],
      ["Celular", "Salud", "", "", "", "", "", ""],
    ]);
    // Filas vacías con sus fórmulas, como en el Sheet real.
    for (let n = 2; n <= 60; n++) {
      const f = formulas(n);
      this.set("Movimientos", `B${n}`, [[f.B]]);
      this.set("Movimientos", `L${n}`, [[f.L]]);
      this.set("Movimientos", `N${n}`, [[f.N]]);
      this.set("Movimientos", `P${n}`, [[f.P]]);
      this.set("Movimientos", `Q${n}`, [[f.Q]]);
    }
    const filas: Cell[][] = [
      [sumarDias(hoy, -5), "Gasto", "Nu Bank", "", "Variable", "Mercado", 185000, "COP", "", "", "", "Pagado"],
      [sumarDias(hoy, -3), "Ingreso", "", "Deel", "Ingreso", "Benor", "", "", 1198, "USD", "", "Pagado"],
      [sumarDias(hoy, -2), "Gasto", "DolarApp (ARQ)", "", "Suscripción", "ChatGPT", 20, "USD", "", "", "", "Pagado"],
      [hoy, "Gasto", "Nu Bank", "", "Fijo", "Arriendo", 1800000, "COP", "", "", "", "Pendiente"],
      [hoy, "Gasto", "Nu Bank", "", "Fijo", "Internet", 95000, "COP", "", "", "", "Pendiente"],
    ];
    filas.forEach((f, i) => {
      const n = 2 + i;
      this.set("Movimientos", `A${n}`, [[f[0]]]);
      this.set("Movimientos", `C${n}`, [f.slice(1, 10)]);
      this.set("Movimientos", `M${n}`, [[f[10]]]);
      this.set("Movimientos", `O${n}`, [[f[11]]]);
    });
  }

  private set(sheet: string, a1: string, values: Cell[][]) {
    this.write({ range: `'${sheet}'!${a1}`, values });
  }

  private write({ range, values }: Write) {
    const { sheet, r1, c1 } = parseA1(range);
    const grid = this.sheets.get(sheet) ?? [];
    this.sheets.set(sheet, grid);
    values.forEach((row, i) => {
      grid[r1 + i] ??= [];
      row.forEach((v, j) => {
        grid[r1 + i][c1 + j] = v;
      });
    });
  }

  private read(range: string): Cell[][] {
    const { sheet, r1, c1, r2, c2 } = parseA1(range);
    const grid = this.sheets.get(sheet) ?? [];
    const out: Cell[][] = [];
    for (let r = r1; r <= r2; r++) {
      const row: Cell[] = [];
      for (let c = c1; c <= c2; c++) row.push(grid[r]?.[c] ?? "");
      out.push(row);
    }
    return out;
  }

  async getValues(ranges: string[]): Promise<Cell[][][]> {
    return ranges.map((r) => this.read(r));
  }

  async getFormulas(ranges: string[]): Promise<Cell[][][]> {
    return ranges.map((r) => this.read(r));
  }

  async batchUpdate(data: Write[]): Promise<void> {
    data.forEach((d) => this.write(d));
  }

  async getHiddenRows(sheet: string, ultimaFila: number): Promise<number[]> {
    return [...(this.hidden.get(sheet) ?? [])].filter((r) => r <= ultimaFila).sort((a, b) => a - b);
  }

  async setRowsHidden(sheet: string, rows: number[], hidden: boolean): Promise<void> {
    const set = this.hidden.get(sheet) ?? new Set<number>();
    this.hidden.set(sheet, set);
    for (const r of rows) {
      if (hidden) set.add(r);
      else set.delete(r);
    }
  }
}
