import type { DatosHoja, Movimiento } from "../lib/data";
import type { InsertRow, Operation } from "../lib/schema";

export const arriendo: Movimiento = {
  fila: 48,
  fecha: "2026-10-01",
  tipo: "Gasto",
  cuentaOrigen: "Nu Bank",
  cuentaDestino: "",
  categoria: "Fijo",
  concepto: "Arriendo",
  montoOrigen: 1_800_000,
  monedaOrigen: "COP",
  montoDestino: "",
  monedaDestino: "",
  estado: "Pendiente",
};

export const datos: DatosHoja = {
  cuentas: [
    { nombre: "Nu Bank", moneda: "COP", saldo: 2_500_000 },
    { nombre: "Rappi", moneda: "COP", saldo: 600_000 },
    { nombre: "Ahorro", moneda: "COP", saldo: 130_000 },
    { nombre: "Deel", moneda: "USD", saldo: 1212 },
    { nombre: "DolarApp (ARQ)", moneda: "USD", saldo: 480 },
  ],
  trmReferencia: 3900,
  catalogo: {
    categorias: ["Fijo", "Variable", "Suscripción", "Deuda", "Ingreso", "Conversión", "Ahorro", "Ajuste"],
    conceptos: [
      ["Arriendo", "Luz", "Agua"],
      ["Comida", "Transporte", "Ocio"],
      ["Netflix"],
      ["Tarjeta de crédito"],
      ["Benor"],
      ["USD → COP", "Deel → Nu Bank"],
      ["Ahorro"],
      ["Saldo inicial (ajuste apertura)"],
    ],
  },
  recientes: [arriendo],
  pendientes: [arriendo],
};

export const ins = (row: Partial<InsertRow>): Operation => ({
  action: "insert",
  row: { fecha: "2026-10-01", estado: "Pagado", ...row } as InsertRow,
});
