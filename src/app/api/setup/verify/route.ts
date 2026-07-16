import { rejectUntrustedLocalRequest } from "@/lib/request-security";
import { clientClosed, isAbortError, rateLimit, rateLimited, readLimitedJson, verificationFailed } from "@/lib/setup-api";
import { verifySetup } from "@/lib/setup-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Verify the currently-configured credential (env or local file) end-to-end.
// Does not accept a credential in the body — that is /api/setup/credentials.
export async function POST(request: Request) {
  const rejected = rejectUntrustedLocalRequest(request, "json");
  if (rejected) return rejected;
  const parsed = await readLimitedJson(request);
  if (!parsed.ok) return parsed.response;
  if (!rateLimit("setup:verify")) return rateLimited();
  try {
    const status = await verifySetup({ signal: request.signal });
    return Response.json(status, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (isAbortError(error)) return clientClosed();
    return verificationFailed();
  }
}
