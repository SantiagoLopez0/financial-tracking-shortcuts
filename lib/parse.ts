import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { interpretar, type Turno } from "./claude";
import type { DatosHoja } from "./data";
import { HttpError } from "./http";
import { previsualizar } from "./month";
import { decodeDraft, encodeDraft, type Operation } from "./schema";
import type { SheetRepo } from "./sheet/repo";
import { resumen } from "./summary";

/** Rondas por mensaje: hasta MAX_RONDAS − 1 preguntas; en la última Claude decide con supuestos. */
export const MAX_RONDAS = 3;

/** El Atajo manda siempre todas las claves: "" o null cuentan como ausentes. */
const opcional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === null || (typeof v === "string" && v.trim() === "") ? undefined : v), schema.optional());

export const ParseBodySchema = z.object({
  text: z.string().trim().min(1),
  previousDraft: opcional(z.string()),
  correction: opcional(z.string().trim()),
  /** String opaco que devolvió la última respuesta con status "question". */
  history: opcional(z.string()),
  /** Respuesta del usuario a la última pregunta de history. */
  answer: opcional(z.string().trim()),
});
export type ParseBody = z.infer<typeof ParseBodySchema>;

export type ParseResponse =
  | { status: "ok"; summary: string; draft: string; history: "" }
  | { status: "question"; question: string; history: string };

const TurnosSchema = z
  .array(z.object({ q: z.string().trim().min(1), a: z.string().trim() }))
  .max(MAX_RONDAS);

export function encodeHistory(turnos: Turno[]): string {
  return Buffer.from(JSON.stringify(turnos), "utf8").toString("base64url");
}

export function decodeHistory(history: string): Turno[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(history, "base64url").toString("utf8"));
  } catch {
    throw new HttpError(400, "history no es un valor válido (manda el que llegó en la última respuesta)");
  }
  const result = TurnosSchema.safeParse(parsed);
  if (!result.success) throw new HttpError(400, `history inválido: ${z.prettifyError(result.error)}`);
  return result.data;
}

/** Decodifica history, pone answer en la última pregunta y exige que todas tengan respuesta. */
export function turnosRespondidos(history: string | undefined, answer?: string): Turno[] {
  const turnos = history ? decodeHistory(history) : [];
  if (answer !== undefined) {
    const ultimo = turnos[turnos.length - 1];
    if (!ultimo || ultimo.a !== "") throw new HttpError(400, "answer sin una pregunta pendiente en history");
    ultimo.a = answer;
  }
  if (turnos.some((t) => t.a === "")) throw new HttpError(400, "falta answer para la pregunta pendiente");
  return turnos;
}

export async function parsear(
  body: ParseBody,
  datos: DatosHoja,
  opts: { client?: Anthropic; now?: Date; repo?: SheetRepo } = {},
): Promise<ParseResponse> {
  if (!!body.previousDraft !== !!body.correction) {
    throw new HttpError(400, "previousDraft y correction van juntos");
  }
  let previous: Operation[] | undefined;
  if (body.previousDraft) {
    try {
      previous = decodeDraft(body.previousDraft);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  }
  const history = turnosRespondidos(body.history, body.answer);
  const resultado = await interpretar(
    {
      text: body.text,
      previous,
      correction: body.correction,
      history,
      puedePreguntar: history.length < MAX_RONDAS - 1,
    },
    datos,
    opts,
  );
  if (resultado.tipo === "pregunta") {
    return {
      status: "question",
      question: resultado.question,
      history: encodeHistory([...history, { q: resultado.question, a: "" }]),
    };
  }
  // Inicio de mes y ocultar/mostrar: el summary dice cuántas filas y cuáles antes de confirmar.
  const previas = opts.repo ? await previsualizar(opts.repo, resultado.operations) : [];
  return {
    status: "ok",
    summary: resumen(resultado.operations, resultado.assumptions, previas),
    draft: encodeDraft(resultado.operations),
    history: "",
  };
}
