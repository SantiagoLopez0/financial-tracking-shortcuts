import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { interpretar, type Turno } from "./claude";
import type { DatosHoja } from "./data";
import { HttpError } from "./http";
import { decodeDraft, encodeDraft, type Operation } from "./schema";
import { resumen } from "./summary";

/** Rondas por mensaje: hasta MAX_RONDAS − 1 preguntas; en la última Claude decide con supuestos. */
export const MAX_RONDAS = 3;

export const ParseBodySchema = z.object({
  text: z.string().trim().min(1),
  previousDraft: z.string().min(1).optional(),
  correction: z.string().trim().min(1).optional(),
  history: z
    .array(z.object({ q: z.string().trim().min(1), a: z.string().trim() }))
    .max(MAX_RONDAS)
    .default([]),
  /** Respuesta a la última pregunta de history (la que viene con a vacío). Atajo para iOS. */
  answer: z.string().trim().min(1).optional(),
});
export type ParseBody = z.infer<typeof ParseBodySchema>;

export type ParseResponse =
  | { status: "ok"; summary: string; draft: string }
  | { status: "question"; question: string; history: Turno[] };

/** Junta history y answer en la lista de turnos respondidos. */
export function turnosRespondidos(history: Turno[], answer?: string): Turno[] {
  const turnos = history.map((t) => ({ ...t }));
  if (answer !== undefined) {
    const ultimo = turnos[turnos.length - 1];
    if (!ultimo || ultimo.a !== "") throw new HttpError(400, "answer sin una pregunta pendiente en history");
    ultimo.a = answer;
  }
  const sinRespuesta = turnos.findIndex((t) => t.a === "");
  if (sinRespuesta >= 0) throw new HttpError(400, `history[${sinRespuesta}] no tiene respuesta (manda answer)`);
  return turnos;
}

export async function parsear(
  body: ParseBody,
  datos: DatosHoja,
  opts: { client?: Anthropic; now?: Date } = {},
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
    return { status: "question", question: resultado.question, history: [...history, { q: resultado.question, a: "" }] };
  }
  return {
    status: "ok",
    summary: resumen(resultado.operations, resultado.assumptions),
    draft: encodeDraft(resultado.operations),
  };
}
