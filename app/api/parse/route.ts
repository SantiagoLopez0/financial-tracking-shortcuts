import { z } from "zod";
import { interpretar } from "@/lib/claude";
import { cargarDatos } from "@/lib/data";
import { HttpError, handle, readJson } from "@/lib/http";
import { decodeDraft, encodeDraft } from "@/lib/schema";
import { getSheetRepo } from "@/lib/sheet/repo";
import { resumen } from "@/lib/summary";

export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z.object({
  text: z.string().trim().min(1),
  previousDraft: z.string().min(1).optional(),
  correction: z.string().trim().min(1).optional(),
});

export const POST = handle(async (req) => {
  const body = await readJson(req, Body);
  if (!!body.previousDraft !== !!body.correction) {
    throw new HttpError(400, "previousDraft y correction van juntos");
  }
  let previous;
  if (body.previousDraft) {
    try {
      previous = decodeDraft(body.previousDraft);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  }
  const datos = await cargarDatos(getSheetRepo());
  const { operations, assumptions } = await interpretar(
    { text: body.text, previous, correction: body.correction },
    datos,
  );
  return { summary: resumen(operations, assumptions), draft: encodeDraft(operations) };
});
