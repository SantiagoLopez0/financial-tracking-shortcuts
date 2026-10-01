import { describe, expect, it } from "vitest";
import { extraerMontos, parseMonto, parseNumero } from "../lib/montos";

describe("parseNumero", () => {
  it.each([
    ["32", 32],
    ["1.560.000", 1_560_000],
    ["2.500", 2500],
    ["1,560,000", 1_560_000],
    ["13.5", 13.5],
    ["13,5", 13.5],
    ["1,5", 1.5],
    ["abc", null],
  ])("%s → %s", (input, esperado) => {
    expect(parseNumero(input)).toBe(esperado);
  });
});

describe("parseMonto", () => {
  it.each([
    ["Almuerzo 32 mil con Nu", 32_000],
    ["como 80 lucas en uber", 80_000],
    ["una luca", 1_000],
    ["50k", 50_000],
    ["un palo", 1_000_000],
    ["2 palos", 2_000_000],
    ["un millón", 1_000_000],
    ["me llegaron 1 millón 560", 1_560_000],
    ["1 millón 560 mil", 1_560_000],
    ["2 palos 300", 2_300_000],
    ["1,5 millones", 1_500_000],
    ["Le metí 400 mil al ahorro", 400_000],
    ["1198 dólares", 1198],
    ["$1.560.000", 1_560_000],
    ["14.5 USD", 14.5],
    ["sin números", null],
  ])("%s → %s", (input, esperado) => {
    expect(parseMonto(input)).toBe(esperado);
  });

  it("'un' sin multiplicador no es un monto", () => {
    expect(parseMonto("un almuerzo de 32 mil")).toBe(32_000);
  });
});

describe("extraerMontos", () => {
  it("lee varias cantidades literalmente", () => {
    expect(extraerMontos("pagué luz 109 mil y agua 60")).toEqual([
      { texto: "109 mil", valor: 109_000 },
      { texto: "60", valor: 60 },
    ]);
  });

  it("transferencia con conversión", () => {
    expect(
      extraerMontos("Pasé 500 dólares de Deel a Nu y me llegaron 1 millón 560").map((m) => m.valor),
    ).toEqual([500, 1_560_000]);
  });
});
