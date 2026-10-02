import { cargarDatos } from "@/lib/data";
import { handle, readJson } from "@/lib/http";
import { ParseBodySchema, parsear } from "@/lib/parse";
import { getSheetRepo } from "@/lib/sheet/repo";

export const runtime = "nodejs";
export const maxDuration = 30;

export const POST = handle(async (req) => {
  const body = await readJson(req, ParseBodySchema);
  const repo = getSheetRepo();
  const datos = await cargarDatos(repo);
  return parsear(body, datos, { repo });
});
