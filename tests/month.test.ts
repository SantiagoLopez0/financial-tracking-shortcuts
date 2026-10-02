import { beforeEach, describe, expect, it } from "vitest";
import { commit, undo } from "../lib/commit";
import { invalidarCache } from "../lib/data";
import {
  hideRows,
  lineaFiltro,
  lineaStartMonth,
  mesAnterior,
  planHide,
  planShow,
  previsualizar,
  rangosTexto,
  showRows,
  startMonth,
} from "../lib/month";
import { HOJA, formulas, type Cell } from "../lib/rows";
import type { Filtro, InsertRow, Operation } from "../lib/schema";
import { MockSheetRepo } from "../lib/sheet/mock";
import { resumen } from "../lib/summary";
import { validarFiltro } from "../lib/validate";

// El mock trae datos en las filas 2-6 (fechas cercanas a hoy; 5 y 6 Pendiente) y una plantilla de
// 4 filas: Benor (Ingreso, Pagado en la plantilla), Arriendo, Internet y Netflix.
let repo: MockSheetRepo;
const mov = (n: number, col: string) => repo.sheets.get("Movimientos")![n - 1]?.[col.charCodeAt(0) - 65];
const ocultas = () => repo.getHiddenRows(HOJA, 3000);
const movimientos = () => repo.getValues(["Movimientos!A2:Q3000"]).then(([v]) => v);

/** Escribe una fila de datos en Movimientos (A, C..K, O). */
async function fila(n: number, f: { fecha: string; tipo?: string; concepto: string; h?: Cell; j?: Cell; estado: string }) {
  await repo.batchUpdate([
    { range: `Movimientos!A${n}`, values: [[f.fecha]] },
    { range: `Movimientos!C${n}:K${n}`, values: [[f.tipo ?? "Gasto", "Nu Bank", "", "Fijo", f.concepto, f.h ?? "", f.h === undefined ? "" : "COP", f.j ?? "", f.j === undefined ? "" : "USD"]] },
    { range: `Movimientos!O${n}`, values: [[f.estado]] },
  ]);
}

const gasto = (fecha: string, concepto = "Mercado"): Operation => ({
  action: "insert",
  row: {
    fecha, tipo: "Gasto", cuentaOrigen: "Nu Bank", categoria: "Variable", concepto,
    montoOrigen: 50_000, monedaOrigen: "COP", estado: "Pagado",
  } as InsertRow,
});

beforeEach(() => {
  invalidarCache();
  repo = new MockSheetRepo();
});

describe("startMonth", () => {
  it("copia la plantilla con A = día 1 y O = Pendiente, respetando las fórmulas", async () => {
    const { rows, plan } = await startMonth(repo, "2030-01");
    expect(rows).toEqual([7, 8, 9, 10]);
    expect(lineaStartMonth(plan)).toBe("Inicio 2030-01: 4 filas Pendiente nuevas (filas 7–10)");
    expect([7, 8, 9, 10].map((n) => mov(n, "A"))).toEqual(Array(4).fill("2030-01-01"));
    expect([7, 8, 9, 10].map((n) => mov(n, "O"))).toEqual(Array(4).fill("Pendiente")); // Benor era Pagado en la plantilla
    expect([7, 8, 9, 10].map((n) => mov(n, "G"))).toEqual(["Benor", "Arriendo", "Internet", "Netflix"]);
    expect(mov(7, "J")).toBe(1198);
    expect(mov(8, "H")).toBe(1_800_000);
    expect(mov(8, "B")).toBe(formulas(8).B); // la fórmula existente no se toca
    expect(await ocultas()).toEqual([]); // no oculta nada por sí sola
  });

  it("es idempotente: si el mes ya existe no duplica y lo avisa", async () => {
    await startMonth(repo, "2030-01");
    const segunda = await startMonth(repo, "2030-01");
    expect(segunda.rows).toEqual([]);
    expect(segunda.plan.existentes).toEqual(["Benor", "Arriendo", "Internet", "Netflix"]);
    expect(lineaStartMonth(segunda.plan)).toBe(
      "Inicio 2030-01: ya estaba hecho (4 filas de la plantilla ya existen), no agrego nada",
    );
    expect(mov(11, "A") ?? "").toBe("");
  });

  it("solo agrega los conceptos que faltan el día 1 de ese mes", async () => {
    await fila(7, { fecha: "2030-01-01", concepto: "arriendo", h: 1_700_000, estado: "Pendiente" });
    await fila(8, { fecha: "2030-01-15", concepto: "Internet", h: 95_000, estado: "Pagado" }); // no es día 1
    const { rows, plan } = await startMonth(repo, "2030-01");
    expect(plan.existentes).toEqual(["Arriendo"]);
    expect(rows).toEqual([9, 10, 11]);
    expect(lineaStartMonth(plan)).toBe("Inicio 2030-01: 3 filas Pendiente nuevas (filas 9–11) · 1 ya existían");
  });

  it("usa el monto del día 1 del mes anterior si quedó Pagado; si no, el de la plantilla", async () => {
    await fila(7, { fecha: "2029-12-01", concepto: "Arriendo", h: 1_850_000, estado: "Pagado" });
    await fila(8, { fecha: "2029-12-01", concepto: "Internet", h: 99_000, estado: "Pendiente" });
    await fila(9, { fecha: "2029-12-01", tipo: "Ingreso", concepto: "Benor", j: 1250, estado: "Pagado" });
    await fila(10, { fecha: "2029-12-15", concepto: "Netflix", h: 10_000, estado: "Pagado" }); // no es día 1
    const { plan } = await startMonth(repo, "2030-01");
    const monto = (c: string) => plan.nuevas.find((r) => r.concepto === c);
    expect(monto("Arriendo")?.montoOrigen).toBe(1_850_000);
    expect(monto("Internet")?.montoOrigen).toBe(95_000);
    expect(monto("Benor")?.montoDestino).toBe(1250);
    expect(monto("Netflix")?.montoOrigen).toBe(45_000);
    expect(plan.delMesAnterior).toBe(2);
    expect(lineaStartMonth(plan)).toContain("· 2 con el monto Pagado de 2029-12");
  });

  it("mesAnterior cruza el año", () => {
    expect(mesAnterior("2030-01")).toBe("2029-12");
    expect(mesAnterior("2026-11")).toBe("2026-10");
  });
});

describe("hide_rows / show_rows", () => {
  /** Mes 2030-01 con 4 Pendiente del día 1 (filas 7-10) y un gasto Pagado del 20 (fila 11). */
  async function mesDePrueba() {
    await startMonth(repo, "2030-01");
    await commit(repo, [gasto("2030-01-20")]);
    return movimientos();
  }

  it("por defecto no oculta filas Pendiente", async () => {
    const values = await mesDePrueba();
    const plan = planHide({ mes: "2030-01" }, values, new Set());
    expect(plan).toEqual({ filas: [11], pendientesVisibles: 4, yaEstaban: 0 });
    expect(lineaFiltro("hide_rows", { mes: "2030-01" }, plan)).toBe(
      "Ocultar 1 fila de 2030-01 (fila 11) · 4 Pendiente quedan visibles",
    );
  });

  it("con incluirPendientes también oculta las Pendiente", async () => {
    const values = await mesDePrueba();
    expect(planHide({ mes: "2030-01", incluirPendientes: true }, values, new Set()).filas).toEqual([7, 8, 9, 10, 11]);
  });

  it("filtra por rango de fechas (inclusive)", async () => {
    const values = await mesDePrueba();
    const f: Filtro = { desde: "2030-01-01", hasta: "2030-01-15", incluirPendientes: true };
    expect(planHide(f, values, new Set()).filas).toEqual([7, 8, 9, 10]);
    expect(planHide({ desde: "2030-01-02", hasta: "2030-01-20" }, values, new Set()).filas).toEqual([11]);
    expect(lineaFiltro("hide_rows", f, planHide(f, values, new Set()))).toBe(
      "Ocultar 4 filas del 01 ene al 15 ene (filas 7–10)",
    );
  });

  it("antesDe: todo lo anterior a un mes, sin Pendientes", async () => {
    const values = await mesDePrueba();
    // Filas 2-6 son de fechas cercanas a hoy; 5 y 6 son Pendiente.
    expect(planHide({ antesDe: "2030-01" }, values, new Set())).toEqual({ filas: [2, 3, 4], pendientesVisibles: 2, yaEstaban: 0 });
  });

  it("nunca toca la fila 1 y descarta filas fuera de rango", async () => {
    const values = await movimientos();
    expect(planHide({ filaDesde: 1, filaHasta: 3 }, values, new Set()).filas).toEqual([2, 3]);
    expect(planHide({ filas: [1, 2, 2, 3001] }, values, new Set()).filas).toEqual([2]);
    expect(planShow({ todo: true }, values, new Set([1, 2]))).toMatchObject({ filas: [2] });
  });

  it("no cuenta dos veces lo que ya estaba oculto", async () => {
    const values = await movimientos();
    const plan = planHide({ filaDesde: 2, filaHasta: 4 }, values, new Set([2]));
    expect(plan).toEqual({ filas: [3, 4], pendientesVisibles: 0, yaEstaban: 1 });
    expect(lineaFiltro("hide_rows", { filaDesde: 2, filaHasta: 4 }, plan)).toBe("Ocultar 2 filas (filas 3–4) · 1 ya estaba oculta");
  });

  it("show_rows: todo, por mes y cuando no hay nada oculto", async () => {
    const values = await mesDePrueba();
    const ocultasAhora = new Set([2, 3, 8, 11, 40]);
    expect(planShow({ todo: true }, values, ocultasAhora).filas).toEqual([2, 3, 8, 11, 40]);
    expect(planShow({ mes: "2030-01" }, values, ocultasAhora)).toEqual({ filas: [8, 11], pendientesVisibles: 0, yaEstaban: 3 });
    expect(lineaFiltro("show_rows", { todo: true }, planShow({ todo: true }, values, new Set()))).toBe(
      "Mostrar filas ocultas: no hay filas para mostrar",
    );
  });

  it("hideRows y showRows aplican sobre la hoja", async () => {
    await mesDePrueba();
    expect((await hideRows(repo, { mes: "2030-01", incluirPendientes: true })).filas).toEqual([7, 8, 9, 10, 11]);
    expect(await ocultas()).toEqual([7, 8, 9, 10, 11]);
    expect((await showRows(repo, { filas: [8, 9] })).filas).toEqual([8, 9]);
    expect(await ocultas()).toEqual([7, 10, 11]);
  });

  it("rangosTexto agrupa filas contiguas", () => {
    expect(rangosTexto([66, 67, 68, 100, 102, 103])).toBe("66–68, 100, 102–103");
  });
});

describe("commit / undo de operaciones de hoja", () => {
  it("start_month + hide_rows en un commit, y undo revierte las dos cosas", async () => {
    const res = await commit(repo, [
      { action: "start_month", mes: "2030-01" },
      { action: "hide_rows", filtro: { filaDesde: 2, filaHasta: 4 } },
    ]);
    expect(res).toMatchObject({ rows: [7, 8, 9, 10], hidden: [2, 3, 4], shown: [] });
    expect(res.message).toBe("Guardado: inicio 2030-01: 4 filas Pendiente (filas 7–10), 3 filas ocultas (2–4)");
    expect(await ocultas()).toEqual([2, 3, 4]);

    const u = await undo(repo, res.rows, res.previous, res);
    expect(u.message).toBe("Deshecho: 4 movimientos (filas 7-10), 3 filas visibles otra vez (2–4)");
    expect(await ocultas()).toEqual([]);
    expect([7, 8, 9, 10].map((n) => mov(n, "A"))).toEqual(["", "", "", ""]);
    expect(mov(7, "P")).toBe(formulas(7).P);
  });

  it("undo de show_rows vuelve a ocultar solo lo que se mostró", async () => {
    await repo.setRowsHidden(HOJA, [2, 3, 40], true);
    const res = await commit(repo, [{ action: "show_rows", filtro: { filaDesde: 2, filaHasta: 10 } }]);
    expect(res).toMatchObject({ rows: [], hidden: [], shown: [2, 3] });
    expect(await ocultas()).toEqual([40]);
    await undo(repo, [], [], res);
    expect(await ocultas()).toEqual([2, 3, 40]);
  });

  it("commit de start_month es idempotente (si se manda dos veces, no duplica)", async () => {
    await commit(repo, [{ action: "start_month", mes: "2030-01" }]);
    const otra = await commit(repo, [{ action: "start_month", mes: "2030-01" }]);
    expect(otra.rows).toEqual([]);
    expect(otra.message).toBe("Guardado: inicio 2030-01: ya estaba hecho");
  });

  it("los inicios de mes van después de los inserts normales del mismo draft", async () => {
    const ops: Operation[] = [gasto("2030-01-05"), { action: "start_month", mes: "2030-01" }];
    expect(await previsualizar(repo, ops)).toEqual([undefined, "Inicio 2030-01: 4 filas Pendiente nuevas (filas 8–11)"]);
    const res = await commit(repo, ops);
    expect(res.rows).toEqual([7, 8, 9, 10, 11]);
    expect(mov(7, "G")).toBe("Mercado");
    expect(mov(8, "G")).toBe("Benor");
  });

  it("ocultar en el mismo commit lo recién mostrado no deja nada que revertir", async () => {
    await repo.setRowsHidden(HOJA, [2], true);
    const res = await commit(repo, [
      { action: "show_rows", filtro: { filas: [2] } },
      { action: "hide_rows", filtro: { filas: [2] } },
    ]);
    expect(res).toMatchObject({ hidden: [], shown: [] });
    expect(await ocultas()).toEqual([2]);
  });
});

describe("summary y validación", () => {
  it("el summary usa el preview cuando existe y una línea genérica si no", async () => {
    const ops: Operation[] = [
      { action: "start_month", mes: "2030-01" },
      { action: "hide_rows", filtro: { mes: "2026-09" } },
      { action: "show_rows", filtro: { todo: true } },
    ];
    expect(resumen(ops, [])).toBe("Inicio 2030-01\nOcultar filas de 2026-09\nMostrar filas ocultas");
    const previas = await previsualizar(repo, ops);
    expect(resumen(ops, [], previas).split("\n")[0]).toBe("Inicio 2030-01: 4 filas Pendiente nuevas (filas 7–10)");
  });

  it("validarFiltro exige exactamente un criterio y combina bien las opciones", () => {
    expect(validarFiltro({ mes: "2026-09" }, "hide_rows")).toEqual([]);
    expect(validarFiltro({}, "hide_rows").join()).toMatch(/exactamente un criterio/);
    expect(validarFiltro({ mes: "2026-09", antesDe: "2026-10" }, "hide_rows").join()).toMatch(/exactamente un criterio/);
    expect(validarFiltro({ desde: "2026-10-01" }, "hide_rows").join()).toMatch(/desde y hasta van juntos/);
    expect(validarFiltro({ desde: "2026-10-15", hasta: "2026-10-01" }, "hide_rows").join()).toMatch(/posterior/);
    expect(validarFiltro({ filaDesde: 40, filaHasta: 2 }, "hide_rows").join()).toMatch(/mayor/);
    expect(validarFiltro({ todo: true }, "hide_rows").join()).toMatch(/solo aplica en show_rows/);
    expect(validarFiltro({ todo: true, incluirPendientes: true }, "show_rows").join()).toMatch(/solo aplica en hide_rows/);
  });
});
