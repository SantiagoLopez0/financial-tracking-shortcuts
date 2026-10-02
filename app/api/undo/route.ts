import { z } from "zod";
import { PrevioSchema, undo } from "@/lib/commit";
import { handle, readJson } from "@/lib/http";
import { getSheetRepo } from "@/lib/sheet/repo";

export const runtime = "nodejs";
export const maxDuration = 30;

// Acepta la respuesta de /api/commit tal cual: { rows, previous, hidden, shown } (todas opcionales).
const Body = z
  .object({
    rows: z.array(z.number().int()).default([]),
    previous: z.array(PrevioSchema).default([]),
    hidden: z.array(z.number().int()).default([]),
    shown: z.array(z.number().int()).default([]),
  })
  .refine(
    (b) => b.rows.length + b.previous.length + b.hidden.length + b.shown.length > 0,
    "Hace falta rows, previous, hidden o shown",
  );

export const POST = handle(async (req) => {
  const { rows, previous, hidden, shown } = await readJson(req, Body);
  return undo(getSheetRepo(), rows, previous, { hidden, shown });
});
