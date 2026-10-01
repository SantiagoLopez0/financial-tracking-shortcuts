import { beforeEach, describe, expect, it } from "vitest";
import { commit, undo } from "../lib/commit";
import { invalidarCache } from "../lib/data";
import {
  describirFilas,
  formulas,
  insertWrites,
  localizarFormula,
  siguienteFila,
  undoWrites,
  updateWrites,
  type Cell,
} from "../lib/rows";
import type { InsertRow, Operation } from "../lib/schema";
import { GoogleSheetRepo } from "../lib/sheet/google";
import { MockSheetRepo } from "../lib/sheet/mock";
import { resumen } from "../lib/summary";

const gasto: InsertRow = {
  fecha: "2026-10-01",
  tipo: "Gasto",
  cuentaOrigen: "Nu Bank",
  categoria: "Variable",
  concepto: "Comida",
  montoOrigen: 32000,
  monedaOrigen: "COP",
  estado: "Pagado",
};

const ranges = (ws: { range: string }[]) => ws.map((w) => w.range);

describe("formulas", () => {
  it("usa el número de fila", () => {
    const f = formulas(67);
    expect(f.B).toBe('=IF(A67="","",TEXT(A67,"yyyy-mm"))');
    expect(f.Q).toBe('=IF(H67="","",IF(I67="COP",H67,IF(ISNUMBER(M67),H67*M67,H67*Cuentas!$D$3)))');
    expect(f.P).toContain("Cuentas!$D$3");
    for (const formula of Object.values(f)) expect(formula).not.toMatch(/[A-Q]n\b/);
  });
});

describe("localizarFormula", () => {
  // Así muestra el Sheet real (locale es_CO) las fórmulas de las filas 98 y 99.
  it("cambia comas por ; fuera de los strings", () => {
    expect(localizarFormula(formulas(98).P, ";")).toBe(
      '=IF(AND(ISNUMBER(H98);I98="USD");"≈ $"&TEXT(Q98;"#,##0")&" COP (tasa "&IF(ISNUMBER(M98);TEXT(M98;"#,##0.00");TEXT(Cuentas!$D$3;"#,##0.00"))&")";"")',
    );
    expect(localizarFormula(formulas(99).B, ";")).toBe('=IF(A99="";"";TEXT(A99;"yyyy-mm"))');
    expect(localizarFormula(formulas(99).Q, ";")).toBe(
      '=IF(H99="";"";IF(I99="COP";H99;IF(ISNUMBER(M99);H99*M99;H99*Cuentas!$D$3)))',
    );
  });
  it("no toca las comas dentro de strings literales", () => {
    expect(localizarFormula('=TEXT(Q99,"#,##0")', ";")).toBe('=TEXT(Q99;"#,##0")');
    expect(localizarFormula('=TEXT(M99,"#,##0.00")&" COP, aprox"', ";")).toBe(
      '=TEXT(M99;"#,##0.00")&" COP, aprox"',
    );
    // Comillas escapadas ("") dentro de un string: la coma sigue estando dentro del string.
    expect(localizarFormula('=IF(A1,"dijo ""a,b""",B1)', ";")).toBe('=IF(A1;"dijo ""a,b""";B1)');
    const p = localizarFormula(formulas(99).P, ";");
    expect(p).toContain('TEXT(Q99;"#,##0")');
    expect(p).toContain('TEXT(M99;"#,##0.00")');
    expect(p).toContain('TEXT(Cuentas!$D$3;"#,##0.00")');
  });
  it("con separador coma no cambia nada", () => {
    expect(localizarFormula(formulas(5).L, ",")).toBe(formulas(5).L);
  });
});

describe("siguienteFila", () => {
  it("es la siguiente a la última con algo en A, C, G o H", () => {
    const values: Cell[][] = [
      ["2026-10-01", "=f", "Gasto"], // fila 2
      [],
      ["", "=f", "", "", "", "", "Arriendo"], // fila 4 (solo G)
      ["", '=IF(A5="","",...)', "", "", "", "", "", "", "", "", "", "=f"], // fila 5: solo fórmulas
    ];
    expect(siguienteFila(values)).toBe(5);
  });
  it("hoja vacía → fila 2", () => {
    expect(siguienteFila([])).toBe(2);
  });
  it("considera solo H", () => {
    expect(siguienteFila([[], ["", "", "", "", "", "", "", 14]])).toBe(4);
  });
});

describe("insertWrites", () => {
  it("escribe las columnas de entrada y las fórmulas faltantes", () => {
    const ws = insertWrites(67, gasto, []);
    expect(ranges(ws)).toEqual([
      "Movimientos!A67",
      "Movimientos!C67:K67",
      "Movimientos!M67",
      "Movimientos!O67",
      "Movimientos!P67",
      "Movimientos!B67",
      "Movimientos!L67",
      "Movimientos!N67",
      "Movimientos!Q67",
    ]);
    expect(ws[1].values).toEqual([["Gasto", "Nu Bank", "", "Variable", "Comida", 32000, "COP", "", ""]]);
    expect(ws[4].values).toEqual([[formulas(67).P]]);
  });

  it("no sobrescribe fórmulas existentes en B, L, N, P, Q", () => {
    const f = formulas(67);
    const existente: Cell[] = ["", f.B, "", "", "", "", "", "", "", "", "", f.L, "", f.N, "", f.P, f.Q];
    expect(ranges(insertWrites(67, gasto, existente))).toEqual([
      "Movimientos!A67",
      "Movimientos!C67:K67",
      "Movimientos!M67",
      "Movimientos!O67",
    ]);
  });

  it("con notas escribe el texto en P aunque haya fórmula", () => {
    const existente: Cell[] = [];
    existente[15] = formulas(67).P;
    const ws = insertWrites(67, { ...gasto, notas: "con Juan" }, existente);
    expect(ws.find((w) => w.range === "Movimientos!P67")?.values).toEqual([["con Juan"]]);
  });

  it("transferencia llena origen y destino, y M con la TRM", () => {
    const ws = insertWrites(10, {
      fecha: "2026-10-01",
      tipo: "Transferencia",
      cuentaOrigen: "Deel",
      cuentaDestino: "Nu Bank",
      categoria: "Conversión",
      concepto: "USD → COP",
      montoOrigen: 500,
      monedaOrigen: "USD",
      montoDestino: 1_560_000,
      monedaDestino: "COP",
      trm: 3900,
      estado: "Pagado",
    });
    expect(ws[1].values[0]).toEqual(["Transferencia", "Deel", "Nu Bank", "Conversión", "USD → COP", 500, "USD", 1_560_000, "COP"]);
    expect(ws[2]).toEqual({ range: "Movimientos!M10", values: [[3900]] });
  });
});

describe("updateWrites", () => {
  it("solo toca las columnas del set", () => {
    const ws = updateWrites({
      action: "update",
      rowNumber: 48,
      expectedConcepto: "Arriendo",
      set: { estado: "Pagado", montoOrigen: 1_850_000, fecha: "2026-10-01" },
    });
    expect(ws).toEqual([
      { range: "Movimientos!A48", values: [["2026-10-01"]] },
      { range: "Movimientos!H48", values: [[1_850_000]] },
      { range: "Movimientos!O48", values: [["Pagado"]] },
    ]);
  });
});

describe("undoWrites", () => {
  it("limpia entradas, restaura P y no toca B, L, N, Q", () => {
    const ws = undoWrites(67);
    expect(ranges(ws)).toEqual([
      "Movimientos!A67",
      "Movimientos!C67:K67",
      "Movimientos!M67",
      "Movimientos!O67",
      "Movimientos!P67",
    ]);
    expect(ws[4].values).toEqual([[formulas(67).P]]);
  });
});

describe("describirFilas", () => {
  it.each([
    [[67], "fila 67"],
    [[68, 67], "filas 67-68"],
    [[67, 70], "filas 67, 70"],
  ])("%j → %s", (rows, esperado) => {
    expect(describirFilas(rows)).toBe(esperado);
  });
});

describe("commit / undo con el mock", () => {
  let repo: MockSheetRepo;
  const mov = (n: number, col: string) => repo.sheets.get("Movimientos")![n - 1]?.[col.charCodeAt(0) - 65];

  beforeEach(() => {
    invalidarCache();
    repo = new MockSheetRepo(); // filas 2-6 con datos; Arriendo pendiente en la fila 5
  });

  it("inserta después de la última fila, actualiza y agrega concepto nuevo", async () => {
    const ops: Operation[] = [
      { action: "insert", row: gasto },
      { action: "insert", row: { ...gasto, concepto: "Uber", newConcept: true } },
      { action: "update", rowNumber: 5, expectedConcepto: "Arriendo", set: { estado: "Pagado" } },
    ];
    const res = await commit(repo, ops);
    expect(res).toEqual({
      message: "Guardado: 2 movimientos (filas 7-8), 1 actualización (fila 5). 1 concepto nuevo en Catálogo",
      rows: [7, 8],
      previous: [{ rowNumber: 5, concepto: "Arriendo", values: { O: "Pendiente" } }],
    });
    expect(mov(7, "G")).toBe("Comida");
    expect(mov(8, "G")).toBe("Uber");
    expect(mov(7, "B")).toBe(formulas(7).B);
    expect(mov(5, "O")).toBe("Pagado");
    // Variable (columna B del catálogo) tiene 5 conceptos en filas 5-9 → Uber va en la fila 10.
    expect(repo.sheets.get("Catálogo")![9][1]).toBe("Uber");
  });

  it("409 si el concepto de la fila no coincide", async () => {
    await expect(
      commit(repo, [{ action: "update", rowNumber: 5, expectedConcepto: "Luz", set: { estado: "Pagado" } }]),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("undo limpia la fila y deja las fórmulas", async () => {
    const { rows } = await commit(repo, [{ action: "insert", row: { ...gasto, notas: "nota" } }]);
    expect(await undo(repo, rows)).toEqual({
      message: "Deshecho: 1 movimiento (fila 7)",
      rows: [7],
      previous: [],
    });
    expect(mov(7, "A")).toBe("");
    expect(mov(7, "G")).toBe("");
    expect(mov(7, "P")).toBe(formulas(7).P);
    expect(mov(7, "Q")).toBe(formulas(7).Q);
  });

  it("guarda los valores previos del update (incluida la fórmula de P) y undo los restaura", async () => {
    const antes = structuredClone(repo.sheets.get("Movimientos")![4]);
    const res = await commit(repo, [
      { action: "insert", row: gasto },
      {
        action: "update",
        rowNumber: 5,
        expectedConcepto: "Arriendo",
        set: { estado: "Pagado", montoOrigen: 1_850_000, notas: "pagado tarde" },
      },
    ]);
    expect(res.previous).toEqual([
      {
        rowNumber: 5,
        concepto: "Arriendo",
        values: { H: 1_800_000, O: "Pendiente", P: formulas(5).P },
      },
    ]);
    expect(mov(5, "P")).toBe("pagado tarde");

    // El Atajo reenvía la respuesta del commit tal cual.
    const u = await undo(repo, res.rows, res.previous);
    expect(u.message).toBe("Deshecho: 1 movimiento (fila 7), 1 actualización revertida (fila 5)");
    expect(repo.sheets.get("Movimientos")![4]).toEqual(antes);
    expect(mov(7, "G")).toBe("");
  });

  it("un valor previo vacío se restaura como vacío", async () => {
    const res = await commit(repo, [
      { action: "update", rowNumber: 6, expectedConcepto: "Internet", set: { cuentaOrigen: "Rappi" } },
    ]);
    expect(res.previous[0].values).toEqual({ D: "Nu Bank" });
    await undo(repo, [], [{ ...res.previous[0], values: { D: "" } }]);
    expect(mov(6, "D")).toBe("");
  });

  it("undo de un update da 409 si el concepto de la fila cambió", async () => {
    const res = await commit(repo, [
      { action: "update", rowNumber: 5, expectedConcepto: "Arriendo", set: { estado: "Pagado" } },
    ]);
    await repo.batchUpdate([{ range: "Movimientos!G5", values: [["Otro"]] }]);
    await expect(undo(repo, [], res.previous)).rejects.toMatchObject({ status: 409 });
    expect(mov(5, "O")).toBe("Pagado");
  });

  it("undo rechaza una fila que viene en rows y en previous", async () => {
    await expect(
      undo(repo, [5], [{ rowNumber: 5, concepto: "Arriendo", values: { O: "Pendiente" } }]),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("GoogleSheetRepo.batchUpdate", () => {
  // Cliente de Sheets falso: captura lo que se enviaría a la API.
  function repoFalso() {
    const enviados: unknown[] = [];
    const repo = new GoogleSheetRepo("id", "email", "key");
    const fake = {
      spreadsheets: {
        values: { batchUpdate: async (req: { requestBody: { data: unknown[] } }) => enviados.push(...req.requestBody.data) },
      },
    };
    Object.assign(repo, { client: Promise.resolve(fake), separador: Promise.resolve(";") });
    return { repo, enviados };
  }

  it("localiza las fórmulas propias y deja intactos los valores raw leídos del Sheet", async () => {
    const { repo, enviados } = repoFalso();
    await repo.batchUpdate([
      { range: "Movimientos!P99", values: [[formulas(99).P]] },
      { range: "Movimientos!H77", values: [["=14+13,5"]], raw: true },
      { range: "Movimientos!O77", values: [["Pendiente"]], raw: true },
    ]);
    expect(enviados).toEqual([
      { range: "Movimientos!P99", values: [[localizarFormula(formulas(99).P, ";")]] },
      { range: "Movimientos!H77", values: [["=14+13,5"]] },
      { range: "Movimientos!O77", values: [["Pendiente"]] },
    ]);
  });
});

describe("resumen", () => {
  it("muestra la nota cuando existe", () => {
    expect(
      resumen(
        [
          { action: "insert", row: { ...gasto, notas: "Almuerzo" } },
          { action: "update", rowNumber: 48, expectedConcepto: "Arriendo", set: { estado: "Pagado", notas: "tarde" } },
        ],
        [],
      ),
    ).toBe(
      [
        "Gasto · $32.000 COP · Nu Bank · Variable/Comida · 01 oct · Pagado · Nota: Almuerzo",
        "Marcar Pagado: Arriendo (fila 48) · Nota: tarde",
      ].join("\n"),
    );
  });

  it("una línea por operación más supuestos", () => {
    const texto = resumen(
      [
        { action: "insert", row: gasto },
        {
          action: "insert",
          row: {
            fecha: "2026-09-30",
            tipo: "Transferencia",
            cuentaOrigen: "Deel",
            cuentaDestino: "Nu Bank",
            categoria: "Conversión",
            concepto: "USD → COP",
            montoOrigen: 500,
            monedaOrigen: "USD",
            montoDestino: 1_560_000,
            monedaDestino: "COP",
            estado: "Pagado",
          },
        },
        { action: "update", rowNumber: 48, expectedConcepto: "Arriendo", set: { estado: "Pagado" } },
      ],
      ["cuenta Nu Bank por defecto"],
    );
    expect(texto).toBe(
      [
        "Gasto · $32.000 COP · Nu Bank · Variable/Comida · 01 oct · Pagado",
        "Transferencia · $500 USD → $1.560.000 COP · Deel → Nu Bank · Conversión/USD → COP · 30 sep · Pagado",
        "Marcar Pagado: Arriendo (fila 48)",
        "Supuse: cuenta Nu Bank por defecto",
      ].join("\n"),
    );
  });
});
