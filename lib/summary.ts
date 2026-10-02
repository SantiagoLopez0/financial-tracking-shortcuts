import { fechaCorta } from "./fechas";
import { describirFiltro } from "./month";
import type { InsertRow, Operation, UpdateOperation } from "./schema";

const numero = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 2 });

/** 2514956 → "2.514.956", 12.6 → "12,6" */
export function formatoNumero(n: number): string {
  return numero.format(n);
}

export function dinero(monto: number, moneda?: string): string {
  return `$${numero.format(monto)}${moneda ? ` ${moneda}` : ""}`;
}

/** "Ajuste: Deel −12 USD (saldo dicho 1.200 vs Sheet 1.212)" */
function lineaAjuste(r: InsertRow): string {
  const sale = r.montoOrigen !== undefined;
  const cuenta = sale ? r.cuentaOrigen : r.cuentaDestino;
  const monto = (sale ? r.montoOrigen : r.montoDestino) ?? 0;
  const moneda = sale ? r.monedaOrigen : r.monedaDestino;
  const signo = sale ? "−" : "+";
  return `Ajuste: ${cuenta} ${signo}${numero.format(monto)} ${moneda}${r.notas ? ` (${r.notas})` : ""}`;
}

function lineaInsert(r: InsertRow): string {
  if (r.tipo === "Ajuste") return lineaAjuste(r);
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

/**
 * Texto plano, una línea por operación, más una línea de supuestos. `previas` trae las líneas ya
 * calculadas de las operaciones de hoja (inicio de mes, ocultar/mostrar), con cuántas filas y cuáles.
 */
export function resumen(ops: Operation[], assumptions: string[], previas: (string | undefined)[] = []): string {
  const lineas = ops.map((op, i) => {
    if (previas[i]) return previas[i];
    switch (op.action) {
      case "insert":
        return lineaInsert(op.row);
      case "update":
        return lineaUpdate(op);
      case "start_month":
        return `Inicio ${op.mes}`;
      case "hide_rows":
      case "show_rows":
        return `${op.action === "hide_rows" ? "Ocultar" : "Mostrar"} filas ${describirFiltro(op.filtro)}`.trim();
    }
  });
  if (assumptions.length > 0) lineas.push(`Supuse: ${assumptions.join("; ")}`);
  return lineas.join("\n");
}
