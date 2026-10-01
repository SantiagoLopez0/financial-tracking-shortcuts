import { z } from "zod";
import { PrevioSchema, undo } from "@/lib/commit";
import { handle, readJson } from "@/lib/http";
import { getSheetRepo } from "@/lib/sheet/repo";

export const runtime = "nodejs";
export const maxDuration = 30;

// Acepta la respuesta de /api/commit tal cual: { rows, previous } (cualquiera de los dos puede faltar).
const Body = z
  .object({
    rows: z.array(z.number().int()).default([]),
    previous: z.array(PrevioSchema).default([]),
  })
  .refine((b) => b.rows.length + b.previous.length > 0, "Hace falta rows o previous");

export const POST = handle(async (req) => {
  const { rows, previous } = await readJson(req, Body);
  return undo(getSheetRepo(), rows, previous);
});
