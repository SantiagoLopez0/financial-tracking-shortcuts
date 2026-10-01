import { createHash, timingSafeEqual } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Compara x-api-secret con API_SECRET en tiempo constante (hash para igualar longitudes). */
export function requireSecret(req: Request): void {
  const secret = process.env.API_SECRET;
  if (!secret) throw new HttpError(500, "API_SECRET no está configurado");
  const provided = req.headers.get("x-api-secret") ?? "";
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(secret).digest();
  if (!timingSafeEqual(a, b)) throw new HttpError(401, "No autorizado");
}

export async function readJson<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "El body debe ser JSON");
  }
  const result = schema.safeParse(body);
  if (!result.success) throw new HttpError(400, z.prettifyError(result.error));
  return result.data;
}

/** Envuelve un handler: exige el secreto, serializa el resultado y convierte errores en `{ error }`. */
export function handle(fn: (req: Request) => Promise<unknown>) {
  return async (req: Request): Promise<Response> => {
    try {
      requireSecret(req);
      return Response.json(await fn(req));
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status >= 500) console.error(err);
        return Response.json({ error: err.message }, { status: err.status });
      }
      console.error(err);
      if (err instanceof Anthropic.APIError) {
        return Response.json({ error: `Error de la API de Claude: ${err.message}` }, { status: 502 });
      }
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: message }, { status: 500 });
    }
  };
}
