import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { DatosHoja, Movimiento } from "./data";
import { diaSemana, hoyBogota, sumarDias } from "./fechas";
import { HttpError } from "./http";
import { extraerMontos } from "./montos";
import { ToolInputSchema, toolInputJsonSchema, type Operation, type ToolInput } from "./schema";
import { normalizarOperaciones, validarOperaciones } from "./validate";

export const TOOL_NAME = "registrar_movimientos";

export interface Pedido {
  text: string;
  previous?: Operation[];
  correction?: string;
}

let client: Anthropic | undefined;
function getClient(): Anthropic {
  // Un reintento de red y timeout corto: la ruta tiene maxDuration 30 y puede hacer dos llamadas.
  client ??= new Anthropic({ maxRetries: 1, timeout: 20_000 });
  return client;
}

export function leerReglas(): string {
  return fs.readFileSync(path.join(process.cwd(), "lib", "reglas.md"), "utf8");
}

function lineaMovimiento(m: Movimiento): string {
  const monto = (v: unknown, moneda: string) => (v === "" ? "" : `${v} ${moneda}`.trim());
  return [
    `fila ${m.fila}`,
    m.fecha,
    m.tipo,
    `${m.cuentaOrigen || "-"} → ${m.cuentaDestino || "-"}`,
    `${m.categoria}/${m.concepto}`,
    [monto(m.montoOrigen, m.monedaOrigen), monto(m.montoDestino, m.monedaDestino)]
      .filter(Boolean)
      .join(" → "),
    m.estado,
  ].join(" | ");
}

export function construirSystem(datos: DatosHoja, now: Date = new Date()): string {
  const hoy = hoyBogota(now);
  const dias = Array.from({ length: 8 }, (_, i) => sumarDias(hoy, -i))
    .map((d) => `${diaSemana(d)} ${d}`)
    .join(", ");
  const catalogo = datos.catalogo.categorias
    .map((cat, i) => (cat ? `- ${cat}: ${datos.catalogo.conceptos[i].join(", ")}` : ""))
    .filter(Boolean)
    .join("\n");
  return `Registras mis movimientos financieros en mi Google Sheet. Recibes texto libre dictado por voz desde el iPhone (español colombiano, puede traer errores de dictado) y lo conviertes en operaciones.
Responde siempre llamando a la herramienta ${TOOL_NAME} una sola vez, con todas las operaciones del mensaje. No respondas con texto.

<reglas>
${leerReglas().trim()}
</reglas>

<cuentas>
${datos.cuentas.map((c) => `- ${c.nombre}: ${c.moneda}`).join("\n")}
TRM de referencia: ${datos.trmReferencia ?? "sin dato"}
</cuentas>

<catalogo>
${catalogo}
</catalogo>

<fechas>
Hoy es ${diaSemana(hoy)} ${hoy} (America/Bogota). Días recientes: ${dias}.
</fechas>

<pendientes>
${datos.pendientes.map(lineaMovimiento).join("\n") || "(ninguna)"}
</pendientes>

<ultimos_movimientos>
${datos.recientes.map(lineaMovimiento).join("\n") || "(ninguno)"}
</ultimos_movimientos>`;
}

export function construirMensaje(pedido: Pedido): string {
  const montos = extraerMontos([pedido.text, pedido.correction ?? ""].join(" "));
  const pista =
    montos.length > 0
      ? `\n\nLectura literal de cantidades (referencia; aplica tú las reglas): ${montos
          .map((m) => `"${m.texto}" = ${m.valor}`)
          .join(", ")}`
      : "";
  if (pedido.previous && pedido.correction) {
    return `Texto original: «${pedido.text}»

Borrador anterior (operations):
${JSON.stringify(pedido.previous, null, 2)}

Corrección: «${pedido.correction}»

Devuelve el borrador completo corregido (todas las operaciones, no solo las que cambian).${pista}`;
  }
  return `Texto: «${pedido.text}»${pista}`;
}

function herramienta(): Anthropic.Tool {
  return {
    name: TOOL_NAME,
    description:
      "Registra las operaciones que salen del texto: insert para movimientos nuevos, update para marcar/ajustar una fila existente (por ejemplo una Pendiente que se pagó). Incluye en assumptions todo lo que supusiste.",
    // Sin strict: con strict el decoding restringido omite casi siempre los campos opcionales
    // (cuentas y montos). El input se valida igual con zod y con las reglas, y se reintenta.
    input_schema: toolInputJsonSchema() as Anthropic.Tool.InputSchema,
  };
}

type Revision = { ok: true; value: ToolInput } | { ok: false; errores: string[] };

export function revisar(input: unknown, datos: DatosHoja): Revision {
  const parsed = ToolInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errores: [z.prettifyError(parsed.error)] };
  const operations = normalizarOperaciones(parsed.data.operations, datos);
  const errores = validarOperaciones(operations, datos);
  if (errores.length > 0) return { ok: false, errores };
  return { ok: true, value: { operations, assumptions: parsed.data.assumptions } };
}

/** Convierte el texto en operaciones validadas. Reintenta una vez si la validación falla. */
export async function interpretar(
  pedido: Pedido,
  datos: DatosHoja,
  opts: { client?: Anthropic; now?: Date } = {},
): Promise<ToolInput> {
  const anthropic = opts.client ?? getClient();
  const system = construirSystem(datos, opts.now);
  const tools = [herramienta()];
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: construirMensaje(pedido) }];
  let errores: string[] = [];

  for (let intento = 0; intento < 2; intento++) {
    const response = await anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
      max_tokens: 16000,
      system,
      tools,
      // Forzar la herramienta (tool_choice any/tool) da 400 en los modelos actuales: auto + strict + prompt.
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      output_config: { effort: "low" },
      messages,
    });

    if (response.stop_reason === "refusal") {
      throw new HttpError(502, "Claude rechazó procesar el texto");
    }

    const toolUse = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === TOOL_NAME,
    );
    messages.push({ role: "assistant", content: response.content });

    if (!toolUse) {
      errores = [`no llamó a ${TOOL_NAME} (stop_reason: ${response.stop_reason})`];
      messages.push({ role: "user", content: `Debes responder llamando a ${TOOL_NAME}.` });
      continue;
    }

    const revision = revisar(toolUse.input, datos);
    if (revision.ok) return revision.value;
    errores = revision.errores;
    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUse.id,
          is_error: true,
          content: `Errores de validación:\n- ${errores.join("\n- ")}\n\nCorrige y vuelve a llamar ${TOOL_NAME} con todas las operaciones.`,
        },
      ],
    });
  }

  throw new HttpError(422, `No pude armar un borrador válido: ${errores.join("; ")}`);
}
