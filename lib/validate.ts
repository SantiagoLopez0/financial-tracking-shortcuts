import type { DatosHoja } from "./data";
import type { InsertRow, Operation } from "./schema";

export const CATEGORIAS_GASTO = ["Fijo", "Variable", "Suscripción", "Deuda"];

/** Minúsculas, sin tildes ni espacios sobrantes. */
export function norm(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

function buscar(lista: string[], valor: string | undefined): string | undefined {
  if (valor === undefined) return undefined;
  return lista.find((x) => norm(x) === norm(valor));
}

function columnaCatalogo(datos: DatosHoja, categoria: string): number {
  return datos.catalogo.categorias.findIndex((c) => c !== "" && norm(c) === norm(categoria));
}

const esAhorro = (cuenta?: string) => !!cuenta && norm(cuenta).includes("ahorro");

/**
 * Ajusta mayúsculas/tildes de cuentas, categorías y conceptos a como están en el Sheet,
 * y quita newConcept si el concepto ya existe en el catálogo.
 */
export function normalizarOperaciones(ops: Operation[], datos: DatosHoja): Operation[] {
  const cuentas = datos.cuentas.map((c) => c.nombre);
  const categorias = [...datos.catalogo.categorias.filter(Boolean), ...CATEGORIAS_GASTO, "Ingreso"];
  const filas = [...datos.recientes, ...datos.pendientes];
  return ops.map((op) => {
    if (op.action === "update") {
      const fila = filas.find((m) => m.fila === op.rowNumber);
      const expectedConcepto =
        fila && norm(fila.concepto) === norm(op.expectedConcepto) ? fila.concepto : op.expectedConcepto;
      const cuentaOrigen = buscar(cuentas, op.set.cuentaOrigen) ?? op.set.cuentaOrigen;
      return {
        ...op,
        expectedConcepto,
        set: { ...op.set, ...(cuentaOrigen ? { cuentaOrigen } : {}) },
      };
    }
    const row: InsertRow = { ...op.row };
    row.cuentaOrigen = buscar(cuentas, row.cuentaOrigen) ?? row.cuentaOrigen;
    row.cuentaDestino = buscar(cuentas, row.cuentaDestino) ?? row.cuentaDestino;
    row.categoria = buscar(categorias, row.categoria) ?? row.categoria;
    const col = columnaCatalogo(datos, row.categoria);
    if (col >= 0) {
      const existente = buscar(datos.catalogo.conceptos[col], row.concepto);
      if (existente) {
        row.concepto = existente;
        delete row.newConcept;
      }
    }
    for (const k of Object.keys(row) as (keyof InsertRow)[]) {
      if (row[k] === undefined) delete row[k];
    }
    return { ...op, row };
  });
}

function validarInsert(r: InsertRow, datos: DatosHoja): string[] {
  const errores: string[] = [];
  const nombres = datos.cuentas.map((c) => c.nombre);
  const monedaDe = (nombre: string) => datos.cuentas.find((c) => c.nombre === nombre)?.moneda;

  const vacio = (campo: keyof InsertRow) => {
    if (r[campo] !== undefined) errores.push(`en ${r.tipo}, ${campo} debe ir vacío`);
  };
  const requerido = (campo: keyof InsertRow) => {
    if (r[campo] === undefined) errores.push(`en ${r.tipo}, ${campo} es obligatorio`);
  };

  for (const [cuenta, monto, moneda, lado] of [
    [r.cuentaOrigen, r.montoOrigen, r.monedaOrigen, "Origen"],
    [r.cuentaDestino, r.montoDestino, r.monedaDestino, "Destino"],
  ] as const) {
    if ((monto === undefined) !== (moneda === undefined)) {
      errores.push(`monto${lado} y moneda${lado} van juntos`);
    }
    if (cuenta === undefined) continue;
    if (!nombres.includes(cuenta)) {
      errores.push(`la cuenta "${cuenta}" no existe; cuentas válidas: ${nombres.join(", ")}`);
    } else if (moneda !== undefined && monedaDe(cuenta) && monedaDe(cuenta) !== moneda) {
      errores.push(`moneda${lado} es ${moneda} pero la cuenta "${cuenta}" es ${monedaDe(cuenta)}`);
    }
  }

  switch (r.tipo) {
    case "Ingreso":
      requerido("cuentaDestino");
      requerido("montoDestino");
      vacio("cuentaOrigen");
      vacio("montoOrigen");
      vacio("monedaOrigen");
      if (r.categoria !== "Ingreso") errores.push(`en Ingreso, categoria debe ser "Ingreso"`);
      break;
    case "Gasto":
      requerido("cuentaOrigen");
      requerido("montoOrigen");
      vacio("cuentaDestino");
      vacio("montoDestino");
      vacio("monedaDestino");
      if (!CATEGORIAS_GASTO.includes(r.categoria)) {
        errores.push(`en Gasto, categoria debe ser una de: ${CATEGORIAS_GASTO.join(", ")}`);
      }
      break;
    case "Transferencia":
      requerido("cuentaOrigen");
      requerido("cuentaDestino");
      requerido("montoOrigen");
      requerido("montoDestino");
      if (r.cuentaOrigen && r.cuentaOrigen === r.cuentaDestino) {
        errores.push("en Transferencia, cuentaOrigen y cuentaDestino deben ser distintas");
      }
      if (r.monedaOrigen && r.monedaDestino && r.monedaOrigen !== r.monedaDestino) {
        if (r.categoria !== "Conversión") {
          errores.push(`Transferencia con cambio de moneda: categoria debe ser "Conversión"`);
        }
      } else if (esAhorro(r.cuentaOrigen) || esAhorro(r.cuentaDestino)) {
        if (r.categoria !== "Ahorro") {
          errores.push(`Transferencia hacia/desde Ahorro: categoria debe ser "Ahorro"`);
        }
      }
      break;
    case "Ajuste":
      if (r.montoOrigen === undefined && r.montoDestino === undefined) {
        errores.push("en Ajuste, hace falta montoOrigen o montoDestino");
      }
      break;
  }

  if (r.trm !== undefined && r.monedaOrigen !== "USD") {
    errores.push("trm solo aplica cuando monedaOrigen es USD");
  }
  if (
    r.tipo === "Transferencia" &&
    r.trm !== undefined &&
    r.montoOrigen &&
    r.montoDestino !== undefined &&
    Math.abs(r.trm - r.montoDestino / r.montoOrigen) < 0.01
  ) {
    errores.push(
      "en Transferencia, trm es la TRM de Google del día, no la tasa aplicada (esa la calcula la columna L); quítala si no te la di",
    );
  }

  const col = columnaCatalogo(datos, r.categoria);
  if (col >= 0 && !r.newConcept && !buscar(datos.catalogo.conceptos[col], r.concepto)) {
    errores.push(
      `el concepto "${r.concepto}" no está en el catálogo de ${r.categoria} ` +
        `(${datos.catalogo.conceptos[col].join(", ") || "vacío"}); usa uno de esos o marca newConcept=true`,
    );
  }
  return errores;
}

/** Errores de reglas de negocio, vacío si todo está bien. Espera operaciones ya normalizadas. */
export function validarOperaciones(ops: Operation[], datos: DatosHoja): string[] {
  const conocidas = new Map([...datos.recientes, ...datos.pendientes].map((m) => [m.fila, m]));
  const errores: string[] = [];
  ops.forEach((op, i) => {
    const pref = `operations[${i}]: `;
    if (op.action === "insert") {
      errores.push(...validarInsert(op.row, datos).map((e) => pref + e));
      return;
    }
    const fila = conocidas.get(op.rowNumber);
    if (!fila) {
      errores.push(`${pref}la fila ${op.rowNumber} no está entre las filas pendientes o recientes`);
    } else if (norm(fila.concepto) !== norm(op.expectedConcepto)) {
      errores.push(
        `${pref}la fila ${op.rowNumber} tiene concepto "${fila.concepto}", no "${op.expectedConcepto}"`,
      );
    }
    if (Object.keys(op.set).length === 0) errores.push(`${pref}set está vacío`);
    const cuenta = op.set.cuentaOrigen;
    if (cuenta !== undefined) {
      const c = datos.cuentas.find((x) => x.nombre === cuenta);
      if (!c) errores.push(`${pref}la cuenta "${cuenta}" no existe`);
      else if (fila?.monedaOrigen && c.moneda !== fila.monedaOrigen) {
        errores.push(`${pref}la cuenta "${cuenta}" es ${c.moneda} pero la fila es ${fila.monedaOrigen}`);
      }
    }
  });
  return errores;
}
