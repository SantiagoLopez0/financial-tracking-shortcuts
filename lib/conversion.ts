import type { DatosHoja } from "./data";
import { hoyBogota } from "./fechas";
import type { InsertRow, Operation, SaldoDicho } from "./schema";
import { formatoNumero } from "./summary";
import { norm } from "./validate";

export const CONCEPTO_AJUSTE = "Ajuste de saldo";

/** COP sin decimales, USD con centavos. */
export function redondear(n: number, moneda: string): number {
  return moneda === "COP" ? Math.round(n) : Math.round(n * 100) / 100;
}

/** Convierte entre COP y USD con una tasa en COP por USD. */
function convertir(monto: number, de: string, a: string, tasa: number): number {
  if (de === a) return monto;
  return de === "USD" ? monto * tasa : monto / tasa;
}

const otraMoneda = (m: string) => (m === "USD" ? "COP" : "USD");

/**
 * Completa las Transferencias con `conversion`: calcula montoDestino con la tasa del proveedor y la
 * comisión (comisión en USD → J = (H − comisión) × tasa; en COP → J = H × tasa − comisión) y arma la
 * nota "Tasa real <proveedor>: <tasa>. Comisión: <x USD / y COP>". Quita `conversion` del resultado.
 */
export function aplicarConversiones(
  ops: Operation[],
  datos: DatosHoja,
): { ops: Operation[]; errores: string[] } {
  const errores: string[] = [];
  const out = ops.map((op, i): Operation => {
    if (op.action !== "insert" || !op.row.conversion) return op;
    const pref = `operations[${i}]: `;
    const { conversion: c, ...row } = op.row;
    const mO = row.monedaOrigen;
    const mD = row.monedaDestino ?? datos.cuentas.find((x) => x.nombre === row.cuentaDestino)?.moneda;
    if (row.tipo !== "Transferencia") {
      errores.push(`${pref}conversion solo aplica en una Transferencia`);
      return op;
    }
    if (!row.montoOrigen || !mO || !mD || mO === mD) {
      errores.push(`${pref}conversion requiere montoOrigen y monedas de origen y destino distintas`);
      return op;
    }
    if (row.trm !== undefined && Math.abs(row.trm - c.tasa) < 0.005) {
      errores.push(
        `${pref}trm es la TRM de Google del día, nunca la tasa del proveedor (esa va en conversion.tasa); quítala si no dijo la de Google`,
      );
      return op;
    }

    const comision = c.comision ?? 0;
    const mComision = c.monedaComision ?? mO;
    const comisionEnOrigen = convertir(comision, mComision, mO, c.tasa);
    const calculado = redondear(convertir(row.montoOrigen - comisionEnOrigen, mO, mD, c.tasa), mD);
    if (calculado <= 0) {
      errores.push(`${pref}la comisión es mayor que el monto enviado`);
      return op;
    }
    // Si dijo cuánto recibió, se respeta; si el modelo hizo la cuenta (cerca del cálculo), va el exacto.
    const montoDestino =
      row.montoDestino === undefined || Math.abs(row.montoDestino - calculado) / calculado < 0.02
        ? calculado
        : row.montoDestino;

    let nota = `Tasa real ${c.proveedor}: ${formatoNumero(c.tasa)}`;
    if (comision > 0) {
      const otra = otraMoneda(mComision);
      const enOtra = redondear(convertir(comision, mComision, otra, c.tasa), otra);
      nota += `. Comisión: ${formatoNumero(comision)} ${mComision} / ${formatoNumero(enOtra)} ${otra}`;
    }
    const notas = row.notas && !norm(row.notas).includes("tasa real") ? `${nota}. ${row.notas}` : nota;
    return { ...op, row: { ...row, montoDestino, monedaDestino: mD as InsertRow["monedaDestino"], notas } };
  });
  return { ops: out, errores };
}

/** Cambio en el saldo calculado de `cuenta` (solo movimientos Pagado) que producen las operaciones. */
function deltaSaldo(ops: Operation[], cuenta: string, datos: DatosHoja): number {
  const filas = [...datos.recientes, ...datos.pendientes];
  let delta = 0;
  for (const op of ops) {
    if (op.action === "insert") {
      if (op.row.estado !== "Pagado") continue;
      if (op.row.cuentaDestino === cuenta) delta += op.row.montoDestino ?? 0;
      if (op.row.cuentaOrigen === cuenta) delta -= op.row.montoOrigen ?? 0;
    } else if (op.action === "update" && op.set.estado === "Pagado") {
      const fila = filas.find((m) => m.fila === op.rowNumber);
      if (!fila || fila.estado === "Pagado") continue;
      const origen = op.set.cuentaOrigen ?? fila.cuentaOrigen;
      const montoOrigen = op.set.montoOrigen ?? (typeof fila.montoOrigen === "number" ? fila.montoOrigen : 0);
      if (fila.cuentaDestino === cuenta && typeof fila.montoDestino === "number") delta += fila.montoDestino;
      if (origen === cuenta) delta -= montoOrigen;
    }
  }
  return delta;
}

/**
 * Compara los saldos que dijo el usuario con el saldo calculado de Cuentas (columna C) y devuelve un
 * insert tipo Ajuste por cada diferencia ("saldo dicho 1.200 vs Sheet 1.212").
 */
export function ajustesDeSaldo(
  saldos: SaldoDicho[],
  ops: Operation[],
  datos: DatosHoja,
  now: Date = new Date(),
): { ajustes: Operation[]; supuestos: string[]; errores: string[] } {
  const ajustes: Operation[] = [];
  const supuestos: string[] = [];
  const errores: string[] = [];
  const colAjuste = datos.catalogo.categorias.findIndex((c) => norm(c) === "ajuste");
  const categoria = colAjuste >= 0 ? datos.catalogo.categorias[colAjuste] : "Ajuste";
  const existente = colAjuste >= 0
    ? datos.catalogo.conceptos[colAjuste].find((c) => norm(c) === norm(CONCEPTO_AJUSTE))
    : undefined;

  for (const s of saldos) {
    const cuenta = datos.cuentas.find((c) => norm(c.nombre) === norm(s.cuenta));
    if (!cuenta) {
      errores.push(`saldos: la cuenta "${s.cuenta}" no existe`);
      continue;
    }
    if (cuenta.saldo === null) {
      supuestos.push(`no pude comparar el saldo de ${cuenta.nombre}: el Sheet no tiene saldo calculado`);
      continue;
    }
    const moneda = cuenta.moneda;
    const esperado = redondear(cuenta.saldo + (s.despues ? deltaSaldo(ops, cuenta.nombre, datos) : 0), moneda);
    const diferencia = redondear(s.saldo - esperado, moneda);
    if (diferencia === 0) continue;
    const lado =
      diferencia < 0
        ? { cuentaOrigen: cuenta.nombre, montoOrigen: -diferencia, monedaOrigen: moneda }
        : { cuentaDestino: cuenta.nombre, montoDestino: diferencia, monedaDestino: moneda };
    ajustes.push({
      action: "insert",
      row: {
        fecha: hoyBogota(now),
        tipo: "Ajuste",
        ...(lado as Partial<InsertRow>),
        categoria,
        concepto: existente ?? CONCEPTO_AJUSTE,
        ...(existente ? {} : { newConcept: true }),
        estado: "Pagado",
        notas: `saldo dicho ${formatoNumero(s.saldo)} vs Sheet ${formatoNumero(esperado)}`,
      },
    });
  }
  return { ajustes, supuestos, errores };
}
