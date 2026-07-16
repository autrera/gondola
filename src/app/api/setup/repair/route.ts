import { rejectUntrustedLocalRequest } from "@/lib/request-security";
import { clientClosed, isAbortError, rateLimit, rateLimited, readLimitedJson, verificationFailed } from "@/lib/setup-api";
import { verifySetup } from "@/lib/setup-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Non-destructive repair: re-verify the active credential and refresh capability
// discovery. Does not erase settings; it only re-runs the readiness checks and
// updates the persisted verification when they pass.
export async function POST(request: Request) {
  const rejected = rejectUntrustedLocalRequest(request, "json");
  if (rejected) return rejected;
  const parsed = await readLimitedJson(request);
  if (!parsed.ok) return parsed.response;
  if (!rateLimit("setup:repair")) return rateLimited();
  try {
    const status = await verifySetup({ signal: request.signal });
    return Response.json(status, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (isAbortError(error)) return clientClosed();
    return verificationFailed();
  }
}
