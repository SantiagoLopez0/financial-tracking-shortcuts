import { z } from "zod";
import { commit } from "@/lib/commit";
import { HttpError, handle, readJson } from "@/lib/http";
import { decodeDraft, type Operation } from "@/lib/schema";
import { getSheetRepo } from "@/lib/sheet/repo";

export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z.object({ draft: z.string().min(1) });

export const POST = handle(async (req) => {
  const { draft } = await readJson(req, Body);
  let operations: Operation[];
  try {
    operations = decodeDraft(draft);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  return commit(getSheetRepo(), operations);
});
