const ALLOWED_ORIGINS = new Set([
  "https://scriptsalmorejo.github.io",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
]);

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-verify-token",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    Vary: "Origin",
  };
  if (ALLOWED_ORIGINS.has(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

export function empty(req: Request, status = 204): Response {
  return new Response(null, { status, headers: corsHeaders(req) });
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

/** Header `x-verify-token` (o Authorization: Bearer) comparado con VERIFY_TOKEN. */
export function tokenVerificacionOk(req: Request): boolean {
  const secret = Deno.env.get("VERIFY_TOKEN") || "";
  if (!secret) return false;
  const header = (req.headers.get("x-verify-token") || "").trim();
  if (header && timingSafeEqual(header, secret)) return true;
  const auth = req.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(\S+)$/i);
  if (!match) return false;
  return timingSafeEqual(match[1], secret);
}
