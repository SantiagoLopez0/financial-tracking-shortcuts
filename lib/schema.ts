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

// z.union (no discriminatedUnion) para que el JSON schema use anyOf, que es lo que acepta strict.
export const OperationSchema = z.union([InsertOperationSchema, UpdateOperationSchema]);
export const OperationsSchema = z.array(OperationSchema).min(1);

export const ToolInputSchema = z.object({
  operations: OperationsSchema,
  assumptions: z.array(z.string()).describe("Supuestos que hiciste, en español, cortos"),
});

export type InsertRow = z.infer<typeof InsertRowSchema>;
export type InsertOperation = z.infer<typeof InsertOperationSchema>;
export type UpdateOperation = z.infer<typeof UpdateOperationSchema>;
export type Operation = z.infer<typeof OperationSchema>;
export type ToolInput = z.infer<typeof ToolInputSchema>;

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
