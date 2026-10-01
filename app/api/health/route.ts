export const runtime = "nodejs";
export const maxDuration = 30;

export function GET() {
  return Response.json({ ok: true });
}
