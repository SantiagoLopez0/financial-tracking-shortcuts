import { fechaCorta } from "./fechas";
import type { InsertRow, Operation, UpdateOperation } from "./schema";

const numero = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 2 });

export function dinero(monto: number, moneda?: string): string {
  return `$${numero.format(monto)}${moneda ? ` ${moneda}` : ""}`;
}

function lineaInsert(r: InsertRow): string {
  const origen = r.montoOrigen !== undefined ? dinero(r.montoOrigen, r.monedaOrigen) : undefined;
  const destino = r.montoDestino !== undefined ? dinero(r.montoDestino, r.monedaDestino) : undefined;
  const monto = [origen, destino].filter(Boolean).join(" → ");
  const cuentas = [r.cuentaOrigen, r.cuentaDestino].filter(Boolean).join(" → ");
  const concepto = `${r.categoria}/${r.concepto}${r.newConcept ? " (nuevo)" : ""}`;
  const nota = r.notas ? `Nota: ${r.notas}` : undefined;
  return [r.tipo, monto, cuentas, concepto, fechaCorta(r.fecha), r.estado, nota]
    .filter(Boolean)
    .join(" · ");
}

function lineaUpdate(op: UpdateOperation): string {
  const { estado, fecha, montoOrigen, cuentaOrigen, notas } = op.set;
  const titulo = estado ? `Marcar ${estado}` : "Actualizar";
  const cambios = [
    montoOrigen !== undefined ? dinero(montoOrigen) : undefined,
    cuentaOrigen,
    fecha ? fechaCorta(fecha) : undefined,
    notas ? `Nota: ${notas}` : undefined,
  ].filter(Boolean);
  return [`${titulo}: ${op.expectedConcepto} (fila ${op.rowNumber})`, ...cambios].join(" · ");
}

/** Texto plano, una línea por operación, más una línea de supuestos. */
export function resumen(ops: Operation[], assumptions: string[]): string {
  const lineas = ops.map((op) => (op.action === "insert" ? lineaInsert(op.row) : lineaUpdate(op)));
  if (assumptions.length > 0) lineas.push(`Supuse: ${assumptions.join("; ")}`);
  return lineas.join("\n");
}
