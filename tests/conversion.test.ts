import { describe, expect, it } from "vitest";
import { ajustesDeSaldo, aplicarConversiones } from "../lib/conversion";
import type { InsertRow, Operation } from "../lib/schema";
import { resumen } from "../lib/summary";
import { validarOperaciones } from "../lib/validate";
import { datos, ins } from "./fixtures";

const NOW = new Date("2026-10-01T15:00:00Z");

const deelANu = (extra: Partial<InsertRow> = {}): Operation =>
  ins({
    tipo: "Transferencia",
    cuentaOrigen: "Deel",
    cuentaDestino: "Nu Bank",
    categoria: "Conversión",
    concepto: "Deel → Nu Bank",
    montoOrigen: 800,
    monedaOrigen: "USD",
    monedaDestino: "COP",
    conversion: { proveedor: "Deel", tasa: 3194, comision: 12.6, monedaComision: "USD" },
    ...extra,
  });

const fila = (op: Operation) => (op.action === "insert" ? op.row : undefined);

describe("aplicarConversiones", () => {
  it("comisión en USD: J = (H − comisión) × tasa, redondeado, y nota con la comisión en COP", () => {
    const { ops, errores } = aplicarConversiones([deelANu()], datos);
    expect(errores).toEqual([]);
    const r = fila(ops[0])!;
    expect(r.montoDestino).toBe(2_514_956); // (800 − 12.6) × 3194 = 2.514.955,6
    expect(r.monedaDestino).toBe("COP");
    expect(r.notas).toBe("Tasa real Deel: 3.194. Comisión: 12,6 USD / 40.244 COP");
    expect(r).not.toHaveProperty("conversion");
    expect(validarOperaciones(ops, datos)).toEqual([]);
  });

  it("comisión en COP: J = H × tasa − comisión, y nota con la comisión en USD", () => {
    const { ops } = aplicarConversiones(
      [deelANu({ montoOrigen: 500, conversion: { proveedor: "DolarApp", tasa: 3129, comision: 21_903, monedaComision: "COP" } })],
      datos,
    );
    expect(fila(ops[0])).toMatchObject({
      montoDestino: 1_542_597, // 500 × 3129 − 21.903
      notas: "Tasa real DolarApp: 3.129. Comisión: 21.903 COP / 7 USD",
    });
  });

  it("solo tasa: J = H × tasa", () => {
    const { ops } = aplicarConversiones([deelANu({ montoOrigen: 300, conversion: { proveedor: "Deel", tasa: 3200 } })], datos);
    expect(fila(ops[0])).toMatchObject({ montoDestino: 960_000, notas: "Tasa real Deel: 3.200" });
  });

  it("sin monedaComision, la comisión está en la moneda de origen", () => {
    const { ops } = aplicarConversiones([deelANu({ conversion: { proveedor: "Deel", tasa: 3194, comision: 12.6 } })], datos);
    expect(fila(ops[0])?.montoDestino).toBe(2_514_956);
  });

  it("respeta el monto recibido que dijo el usuario, pero corrige una cuenta cercana del modelo", () => {
    const dicho = aplicarConversiones([deelANu({ montoDestino: 2_400_000 })], datos);
    expect(fila(dicho.ops[0])?.montoDestino).toBe(2_400_000);
    const cerca = aplicarConversiones([deelANu({ montoDestino: 2_514_900 })], datos);
    expect(fila(cerca.ops[0])?.montoDestino).toBe(2_514_956);
  });

  it("antepone la nota de la tasa a una nota existente", () => {
    const { ops } = aplicarConversiones([deelANu({ notas: "para el arriendo" })], datos);
    expect(fila(ops[0])?.notas).toBe("Tasa real Deel: 3.194. Comisión: 12,6 USD / 40.244 COP. para el arriendo");
  });

  it("M (trm) nunca puede ser la tasa del proveedor; la TRM de Google sí", () => {
    expect(aplicarConversiones([deelANu({ trm: 3194 })], datos).errores.join()).toMatch(/nunca la tasa del proveedor/);
    const ok = aplicarConversiones([deelANu({ trm: 3221 })], datos);
    expect(ok.errores).toEqual([]);
    expect(fila(ok.ops[0])?.trm).toBe(3221);
  });

  it("errores: conversion fuera de Transferencia, misma moneda o comisión mayor al monto", () => {
    const gasto = ins({
      tipo: "Gasto", cuentaOrigen: "Deel", categoria: "Variable", concepto: "Ocio", montoOrigen: 10, monedaOrigen: "USD",
      conversion: { proveedor: "Deel", tasa: 3194 },
    });
    expect(aplicarConversiones([gasto], datos).errores.join()).toMatch(/solo aplica en una Transferencia/);
    expect(aplicarConversiones([deelANu({ cuentaDestino: "DolarApp (ARQ)", monedaDestino: "USD" })], datos).errores.join()).toMatch(/distintas/);
    expect(aplicarConversiones([deelANu({ conversion: { proveedor: "Deel", tasa: 3194, comision: 900 } })], datos).errores.join()).toMatch(/mayor que el monto/);
  });

  it("toma la moneda de destino de la cuenta si no viene", () => {
    const { ops } = aplicarConversiones([deelANu({ monedaDestino: undefined })], datos);
    expect(fila(ops[0])?.monedaDestino).toBe("COP");
  });
});

describe("ajustesDeSaldo", () => {
  it("saldo dicho menor al del Sheet → Ajuste saliendo de la cuenta, con la línea del summary", () => {
    const { ajustes, errores } = ajustesDeSaldo([{ cuenta: "deel", saldo: 1200 }], [], datos, NOW);
    expect(errores).toEqual([]);
    expect(ajustes).toEqual([
      {
        action: "insert",
        row: {
          fecha: "2026-10-01",
          tipo: "Ajuste",
          cuentaOrigen: "Deel",
          montoOrigen: 12,
          monedaOrigen: "USD",
          categoria: "Ajuste",
          concepto: "Ajuste de saldo",
          newConcept: true,
          estado: "Pagado",
          notas: "saldo dicho 1.200 vs Sheet 1.212",
        },
      },
    ]);
    expect(resumen(ajustes, [])).toBe("Ajuste: Deel −12 USD (saldo dicho 1.200 vs Sheet 1.212)");
    expect(validarOperaciones(ajustes, datos)).toEqual([]);
  });

  it("saldo dicho mayor → Ajuste entrando a la cuenta", () => {
    const { ajustes } = ajustesDeSaldo([{ cuenta: "Nu Bank", saldo: 2_550_000 }], [], datos, NOW);
    expect(fila(ajustes[0])).toMatchObject({ cuentaDestino: "Nu Bank", montoDestino: 50_000, monedaDestino: "COP" });
    expect(resumen(ajustes, [])).toBe("Ajuste: Nu Bank +50.000 COP (saldo dicho 2.550.000 vs Sheet 2.500.000)");
  });

  it("sin diferencia no agrega nada", () => {
    expect(ajustesDeSaldo([{ cuenta: "Deel", saldo: 1212 }], [], datos, NOW).ajustes).toEqual([]);
  });

  it("usa el concepto del catálogo si ya existe", () => {
    const conConcepto = structuredClone(datos);
    conConcepto.catalogo.conceptos[7].push("Ajuste de saldo");
    const { ajustes } = ajustesDeSaldo([{ cuenta: "Deel", saldo: 1200 }], [], conConcepto, NOW);
    expect(fila(ajustes[0])).toMatchObject({ concepto: "Ajuste de saldo" });
    expect(fila(ajustes[0])).not.toHaveProperty("newConcept");
  });

  it("despues=true descuenta los movimientos Pagado del mensaje", () => {
    const transfer = aplicarConversiones([deelANu()], datos).ops;
    const { ajustes } = ajustesDeSaldo([{ cuenta: "Deel", saldo: 400, despues: true }], transfer, datos, NOW);
    expect(fila(ajustes[0])?.notas).toBe("saldo dicho 400 vs Sheet 412"); // 1212 − 800
  });

  it("despues=true cuenta un Pendiente que se marca Pagado", () => {
    const pagar: Operation = { action: "update", rowNumber: 48, expectedConcepto: "Arriendo", set: { estado: "Pagado" } };
    // Nu Bank 2.500.000 − arriendo 1.800.000 = 700.000
    expect(ajustesDeSaldo([{ cuenta: "Nu Bank", saldo: 700_000, despues: true }], [pagar], datos, NOW).ajustes).toEqual([]);
  });

  it("cuenta desconocida → error; sin saldo calculado → supuesto", () => {
    expect(ajustesDeSaldo([{ cuenta: "Davivienda", saldo: 1 }], [], datos, NOW).errores.join()).toMatch(/no existe/);
    const sinSaldo = structuredClone(datos);
    sinSaldo.cuentas[3].saldo = null;
    const r = ajustesDeSaldo([{ cuenta: "Deel", saldo: 1200 }], [], sinSaldo, NOW);
    expect(r.ajustes).toEqual([]);
    expect(r.supuestos.join()).toMatch(/no pude comparar el saldo de Deel/);
  });
});
