// Shared helpers for the /api/setup/* routes: strict body-size limits, JSON
// parsing, and a local rate limiter for verification attempts. SERVER-ONLY.

const MAX_BODY_BYTES = 8 * 1024; // Credentials are tiny; anything larger is suspect.

export type LimitedJson =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: Response };

export async function readLimitedJson(request: Request): Promise<LimitedJson> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, response: tooLarge() };
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return { ok: false, response: tooLarge() };
  }
  if (!text.trim()) return { ok: true, body: {} };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return { ok: false, response: Response.json({ error: "The request body must be a JSON object." }, { status: 400 }) };
    }
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, response: Response.json({ error: "The request body must be valid JSON." }, { status: 400 }) };
  }
}

function tooLarge(): Response {
  return Response.json({ error: "The request body is too large." }, { status: 413, headers: { "Cache-Control": "no-store" } });
}

// In-memory sliding window. Local, single-process; enough to stop a runaway
// verify loop from hammering the provider from the browser.
const attempts = new Map<string, number[]>();

export function rateLimit(key: string, max = 6, windowMs = 60_000): boolean {
  const now = Date.now();
  const recent = (attempts.get(key) ?? []).filter((time) => now - time < windowMs);
  if (recent.length >= max) {
    attempts.set(key, recent);
    return false;
  }
  recent.push(now);
  attempts.set(key, recent);
  return true;
}

export function resetRateLimit(key?: string): void {
  if (key) attempts.delete(key);
  else attempts.clear();
}

export function rateLimited(): Response {
  return Response.json(
    { error: "Too many verification attempts. Wait a moment and try again." },
    { status: 429, headers: { "Cache-Control": "no-store" } },
  );
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Client disconnected mid-verification. */
export function clientClosed(): Response {
  return new Response(null, { status: 499 });
}

/** Generic, sanitized failure — never leaks upstream detail or credentials. */
export function verificationFailed(): Response {
  return Response.json(
    { error: "Verification could not be completed." },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  );
}
