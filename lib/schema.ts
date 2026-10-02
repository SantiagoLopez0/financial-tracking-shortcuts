import { z } from "zod";

export const TIPOS = ["Ingreso", "Gasto", "Transferencia", "Ajuste"] as const;
export const ESTADOS = ["Pagado", "Pendiente"] as const;
export const MONEDAS = ["COP", "USD"] as const;

const fecha = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), "fecha inválida")
  .describe("Fecha ISO YYYY-MM-DD (zona America/Bogota)");
const monto = z.number().positive();
const moneda = z.enum(MONEDAS);

/** Datos de una conversión con tasa del proveedor; el código calcula montoDestino y la nota. */
export const ConversionSchema = z.object({
  proveedor: z.string().min(1).describe("Quién hizo el cambio, ej. Deel, DolarApp, Wise"),
  tasa: monto.describe("Tasa del proveedor en COP por USD (ej. 3194)"),
  comision: monto.optional().describe("Comisión cobrada, si la dijo"),
  monedaComision: moneda.optional().describe("Moneda de la comisión"),
});

export const InsertRowSchema = z.object({
  fecha,
  tipo: z.enum(TIPOS),
  cuentaOrigen: z.string().min(1).optional().describe("Columna D"),
  cuentaDestino: z.string().min(1).optional().describe("Columna E"),
  categoria: z.string().min(1).describe("Columna F"),
  concepto: z.string().min(1).describe("Columna G"),
  montoOrigen: monto.optional().describe("Columna H"),
  monedaOrigen: moneda.optional().describe("Columna I"),
  montoDestino: monto.optional().describe("Columna J"),
  monedaDestino: moneda.optional().describe("Columna K"),
  trm: monto.optional().describe("Columna M: TRM COP por USD"),
  estado: z.enum(ESTADOS),
  notas: z.string().min(1).optional().describe("Columna P, solo si hay una nota"),
  newConcept: z
    .boolean()
    .optional()
    .describe("true si el concepto no está en el catálogo y hay que agregarlo"),
  conversion: ConversionSchema.optional().describe(
    "Solo en Transferencia con cambio de moneda cuando dijo la tasa del proveedor y/o la comisión. " +
      "No calcules montoDestino ni pongas la tasa o la comisión en notas: lo hace el sistema. " +
      "Llena montoDestino solo si dijo cuánto recibió.",
  ),
});

export const InsertOperationSchema = z.object({
  action: z.literal("insert"),
  row: InsertRowSchema,
});

export const UpdateOperationSchema = z.object({
  action: z.literal("update"),
  rowNumber: z.number().int().min(2).describe("Número de fila existente en Movimientos"),
  expectedConcepto: z.string().min(1).describe("Concepto (columna G) actual de esa fila"),
  set: z.object({
    estado: z.enum(ESTADOS).optional(),
    fecha: fecha.optional(),
    montoOrigen: monto.optional(),
    cuentaOrigen: z.string().min(1).optional(),
    notas: z.string().min(1).optional(),
  }),
});

const mes = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
  .describe("Mes YYYY-MM");

/** Qué filas de Movimientos ocultar o mostrar. Usa exactamente un criterio. */
export const FiltroSchema = z.object({
  mes: mes.optional().describe("Filas de ese mes (columna B)"),
  desde: fecha.optional().describe("Rango de fechas (columna A), inclusive; va junto con hasta"),
  hasta: fecha.optional(),
  filas: z.array(z.number().int()).optional().describe("Números de fila sueltos"),
  filaDesde: z.number().int().optional().describe("Rango de filas, inclusive; va junto con filaHasta"),
  filaHasta: z.number().int().optional(),
  antesDe: mes.optional().describe("Todas las filas anteriores a ese mes"),
  todo: z.boolean().optional().describe("Solo en show_rows: mostrar todas las filas ocultas"),
  incluirPendientes: z
    .boolean()
    .optional()
    .describe("Solo en hide_rows y solo si dijo explícitamente 'incluyendo pendientes'"),
});

export const StartMonthOperationSchema = z.object({
  action: z.literal("start_month"),
  mes: mes.describe("Mes a iniciar: copia la Plantilla Mensual con fecha día 1"),
});

export const HideRowsOperationSchema = z.object({
  action: z.literal("hide_rows"),
  filtro: FiltroSchema,
});

export const ShowRowsOperationSchema = z.object({
  action: z.literal("show_rows"),
  filtro: FiltroSchema,
});

// z.union (no discriminatedUnion) para que el JSON schema use anyOf.
export const OperationSchema = z.union([
  InsertOperationSchema,
  UpdateOperationSchema,
  StartMonthOperationSchema,
  HideRowsOperationSchema,
  ShowRowsOperationSchema,
]);
export const OperationsSchema = z.array(OperationSchema).min(1);

export const SaldoDichoSchema = z.object({
  cuenta: z.string().min(1),
  saldo: z.number().describe("Saldo que dijo tener, en la moneda de la cuenta"),
  despues: z
    .boolean()
    .optional()
    .describe("true si es el saldo después de los movimientos del mensaje (ej. 'me quedaron 400')"),
});

export const ToolInputSchema = z.object({
  operations: z.array(OperationSchema).describe("Vacío solo si haces una pregunta"),
  assumptions: z.array(z.string()).describe("Supuestos que hiciste, en español, cortos"),
  saldos: z
    .array(SaldoDichoSchema)
    .optional()
    .describe("Saldos que mencionó ('tengo 1200 en Deel'); el sistema los compara con el Sheet"),
  question: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Pregunta corta para el usuario, SOLO si falta algo que no se puede suponer: el monto, " +
        "si es ingreso/gasto/transferencia, o cuánto recibió en una conversión sin tasa. " +
        "En español, para leer en voz alta, sin símbolos.",
    ),
});

export type InsertRow = z.infer<typeof InsertRowSchema>;
export type InsertOperation = z.infer<typeof InsertOperationSchema>;
export type UpdateOperation = z.infer<typeof UpdateOperationSchema>;
export type StartMonthOperation = z.infer<typeof StartMonthOperationSchema>;
export type HideRowsOperation = z.infer<typeof HideRowsOperationSchema>;
export type ShowRowsOperation = z.infer<typeof ShowRowsOperationSchema>;
export type Filtro = z.infer<typeof FiltroSchema>;
export type Operation = z.infer<typeof OperationSchema>;
export type ToolInput = z.infer<typeof ToolInputSchema>;
export type Conversion = z.infer<typeof ConversionSchema>;
export type SaldoDicho = z.infer<typeof SaldoDichoSchema>;

// Claves que acepta el JSON schema de strict tool use. El resto (minimum, pattern, minLength...)
// se quita del schema enviado y se valida del lado nuestro con zod.
const KEEP = new Set([
  "type",
  "properties",
  "required",
  "items",
  "anyOf",
  "enum",
  "const",
  "description",
]);

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!KEEP.has(key)) continue;
    if (key === "properties") {
      out.properties = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, sanitize(v)]),
      );
    } else {
      out[key] = sanitize(value);
    }
  }
  if (out.type === "object") out.additionalProperties = false;
  return out;
}

export function toolInputJsonSchema(): Record<string, unknown> {
  return sanitize(z.toJSONSchema(ToolInputSchema)) as Record<string, unknown>;
}

export function encodeDraft(operations: Operation[]): string {
  return Buffer.from(JSON.stringify(operations), "utf8").toString("base64url");
}

/** Decodifica y valida con zod. Lanza Error si el draft no es válido. */
export function decodeDraft(draft: string): Operation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(draft, "base64url").toString("utf8"));
  } catch {
    throw new Error("draft no es base64url de un JSON válido");
  }
  const result = OperationsSchema.safeParse(parsed);
  if (!result.success) throw new Error(`draft inválido: ${z.prettifyError(result.error)}`);
  return result.data;
}
