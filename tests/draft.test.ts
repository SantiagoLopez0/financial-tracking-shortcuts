import { describe, expect, it } from "vitest";
import { decodeDraft, encodeDraft, type Operation } from "../lib/schema";

const ops: Operation[] = [
  {
    action: "insert",
    row: {
      fecha: "2026-10-01",
      tipo: "Gasto",
      cuentaOrigen: "Nu Bank",
      categoria: "Variable",
      concepto: "Comida",
      montoOrigen: 32000,
      monedaOrigen: "COP",
      estado: "Pagado",
      notas: "almuerzo con ñandú — “comillas”",
    },
  },
  {
    action: "update",
    rowNumber: 48,
    expectedConcepto: "Arriendo",
    set: { estado: "Pagado" },
  },
];

describe("draft base64url", () => {
  it("ida y vuelta conserva las operaciones (incluye tildes y unicode)", () => {
    expect(decodeDraft(encodeDraft(ops))).toEqual(ops);
  });

  it("es base64url: sin +, / ni =", () => {
    expect(encodeDraft(ops)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("rechaza basura", () => {
    expect(() => decodeDraft("%%%no-es-json")).toThrow(/draft/);
  });

  it("rechaza un JSON que no cumple el schema", () => {
    const malo = Buffer.from(JSON.stringify([{ action: "insert", row: { tipo: "Gasto" } }])).toString(
      "base64url",
    );
    expect(() => decodeDraft(malo)).toThrow(/draft inválido/);
  });

  it("rechaza un draft vacío", () => {
    expect(() => decodeDraft(encodeDraft([]))).toThrow(/draft inválido/);
  });

  it("rechaza fechas imposibles", () => {
    const op = structuredClone(ops[0]) as Extract<Operation, { action: "insert" }>;
    op.row.fecha = "2026-13-45";
    expect(() => decodeDraft(encodeDraft([op]))).toThrow(/draft inválido/);
  });
});
