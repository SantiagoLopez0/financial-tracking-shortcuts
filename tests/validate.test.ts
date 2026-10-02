import { describe, expect, it } from "vitest";
import type { Operation } from "../lib/schema";
import { normalizarOperaciones, validarOperaciones } from "../lib/validate";
import { datos, ins } from "./fixtures";

const errores = (ops: Operation[]) => validarOperaciones(normalizarOperaciones(ops, datos), datos);

const gasto = {
  tipo: "Gasto",
  cuentaOrigen: "Nu Bank",
  categoria: "Variable",
  concepto: "Comida",
  montoOrigen: 32_000,
  monedaOrigen: "COP",
} as const;

const ingreso = {
  tipo: "Ingreso",
  cuentaDestino: "DolarApp (ARQ)",
  categoria: "Ingreso",
  concepto: "Benor",
  montoDestino: 1198,
  monedaDestino: "USD",
} as const;

const conversion = {
  tipo: "Transferencia",
  cuentaOrigen: "Deel",
  cuentaDestino: "Nu Bank",
  categoria: "Conversión",
  concepto: "USD → COP",
  montoOrigen: 500,
  monedaOrigen: "USD",
  montoDestino: 1_560_000,
  monedaDestino: "COP",
} as const;

const ahorro = {
  tipo: "Transferencia",
  cuentaOrigen: "Rappi",
  cuentaDestino: "Ahorro",
  categoria: "Ahorro",
  concepto: "Ahorro",
  montoOrigen: 400_000,
  monedaOrigen: "COP",
  montoDestino: 400_000,
  monedaDestino: "COP",
} as const;

describe("validación por tipo", () => {
  it("acepta los casos válidos", () => {
    expect(errores([ins(gasto), ins(ingreso), ins(conversion), ins(ahorro)])).toEqual([]);
  });

  describe("Gasto", () => {
    it("exige cuentaOrigen y montoOrigen", () => {
      const e = errores([ins({ ...gasto, cuentaOrigen: undefined, montoOrigen: undefined, monedaOrigen: undefined })]);
      expect(e.join("\n")).toMatch(/cuentaOrigen es obligatorio/);
      expect(e.join("\n")).toMatch(/montoOrigen es obligatorio/);
    });
    it("no admite destino", () => {
      expect(errores([ins({ ...gasto, cuentaDestino: "Rappi" })]).join()).toMatch(/cuentaDestino debe ir vacío/);
    });
    it("categoría debe ser de gasto", () => {
      expect(errores([ins({ ...gasto, categoria: "Ingreso", concepto: "Benor" })]).join()).toMatch(
        /categoria debe ser una de/,
      );
    });
    it("moneda debe coincidir con la cuenta", () => {
      expect(errores([ins({ ...gasto, monedaOrigen: "USD" })]).join()).toMatch(/cuenta "Nu Bank" es COP/);
    });
    it("trm solo con USD", () => {
      expect(errores([ins({ ...gasto, trm: 3900 })]).join()).toMatch(/trm solo aplica/);
      expect(
        errores([
          ins({ ...gasto, cuentaOrigen: "DolarApp (ARQ)", montoOrigen: 20, monedaOrigen: "USD", trm: 3950 }),
        ]),
      ).toEqual([]);
    });
  });

  describe("Ingreso", () => {
    it("categoría debe ser Ingreso", () => {
      expect(errores([ins({ ...ingreso, categoria: "Variable", concepto: "Comida" })]).join()).toMatch(
        /categoria debe ser "Ingreso"/,
      );
    });
    it("no admite origen", () => {
      expect(errores([ins({ ...ingreso, montoOrigen: 1, monedaOrigen: "USD" })]).join()).toMatch(
        /montoOrigen debe ir vacío/,
      );
    });
    it("moneda debe coincidir con la cuenta", () => {
      expect(errores([ins({ ...ingreso, monedaDestino: "COP" })]).join()).toMatch(/es USD/);
    });
  });

  describe("Transferencia", () => {
    it("con cambio de moneda debe ser Conversión", () => {
      expect(errores([ins({ ...conversion, categoria: "Ahorro", concepto: "Ahorro" })]).join()).toMatch(
        /"Conversión"/,
      );
    });
    it("hacia Ahorro debe ser Ahorro", () => {
      expect(errores([ins({ ...ahorro, categoria: "Variable", concepto: "Comida" })]).join()).toMatch(/"Ahorro"/);
    });
    it("exige ambos lados", () => {
      expect(errores([ins({ ...ahorro, cuentaDestino: undefined })]).join()).toMatch(/cuentaDestino es obligatorio/);
    });
    it("trm no puede ser la tasa aplicada", () => {
      expect(errores([ins({ ...conversion, trm: 3120 })]).join()).toMatch(/TRM de Google/);
      expect(errores([ins({ ...conversion, trm: 3900 })])).toEqual([]);
    });
    it("monto y moneda van juntos", () => {
      expect(errores([ins({ ...ahorro, monedaDestino: undefined })]).join()).toMatch(/montoDestino y monedaDestino/);
    });
  });

  it("rechaza cuentas inexistentes", () => {
    expect(errores([ins({ ...gasto, cuentaOrigen: "Davivienda" })]).join()).toMatch(/no existe/);
  });

  describe("catálogo", () => {
    it("concepto fuera del catálogo exige newConcept", () => {
      expect(errores([ins({ ...gasto, concepto: "Uber" })]).join()).toMatch(/newConcept=true/);
      expect(errores([ins({ ...gasto, concepto: "Uber", newConcept: true })])).toEqual([]);
    });
    it("normaliza mayúsculas/tildes y quita newConcept si ya existe", () => {
      const [op] = normalizarOperaciones(
        [ins({ ...gasto, cuentaOrigen: "nu bank", categoria: "variable", concepto: "comida", newConcept: true })],
        datos,
      );
      expect(op).toMatchObject({ row: { cuentaOrigen: "Nu Bank", categoria: "Variable", concepto: "Comida" } });
      expect(op.action === "insert" && op.row.newConcept).toBeFalsy();
    });
  });

  describe("update", () => {
    const update = (o: Partial<Extract<Operation, { action: "update" }>>): Operation => ({
      action: "update",
      rowNumber: 48,
      expectedConcepto: "Arriendo",
      set: { estado: "Pagado" },
      ...o,
    });
    it("acepta marcar Pagado una fila pendiente", () => {
      expect(errores([update({})])).toEqual([]);
    });
    it("normaliza expectedConcepto al texto exacto de la fila", () => {
      const [op] = normalizarOperaciones([update({ expectedConcepto: "arriendo" })], datos);
      expect(op).toMatchObject({ expectedConcepto: "Arriendo" });
    });
    it("rechaza filas desconocidas o concepto distinto", () => {
      expect(errores([update({ rowNumber: 99 })]).join()).toMatch(/no está entre/);
      expect(errores([update({ expectedConcepto: "Luz" })]).join()).toMatch(/tiene concepto "Arriendo"/);
    });
    it("rechaza set vacío", () => {
      expect(errores([update({ set: {} })]).join()).toMatch(/set está vacío/);
    });
    it("cuenta del update debe coincidir con la moneda de la fila", () => {
      expect(errores([update({ set: { estado: "Pagado", cuentaOrigen: "Deel" } })]).join()).toMatch(/es USD/);
    });
  });
});
