import { deleteStoredCredential } from "@/lib/credential-store";
import { rejectUntrustedLocalRequest } from "@/lib/request-security";
import { clientClosed, isAbortError, rateLimit, rateLimited, readLimitedJson, verificationFailed } from "@/lib/setup-api";
import { getSetupStatus, verifySetup } from "@/lib/setup-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Accept a candidate credential, verify it end-to-end, and persist it ONLY on
// full success. The key is never echoed back or logged.
export async function POST(request: Request) {
  const rejected = rejectUntrustedLocalRequest(request, "json");
  if (rejected) return rejected;
  const parsed = await readLimitedJson(request);
  if (!parsed.ok) return parsed.response;

  const apiKey = typeof parsed.body.apiKey === "string" ? parsed.body.apiKey.trim() : "";
  const override = parsed.body.override === true;
  if (!apiKey) {
    return Response.json({ error: "An API key is required." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  if (!rateLimit("setup:credentials")) return rateLimited();

  try {
    const status = await verifySetup({ apiKey, override, signal: request.signal });
    const httpStatus = status.state === "ready" ? 200 : 400;
    return Response.json(status, { status: httpStatus, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (isAbortError(error)) return clientClosed();
    return verificationFailed();
  }
}

// Remove the local credential. Resolution falls back to an env credential when
// present; setup status is recomputed accordingly.
export async function DELETE(request: Request) {
  const rejected = rejectUntrustedLocalRequest(request);
  if (rejected) return rejected;
  deleteStoredCredential("venice");
  return Response.json(getSetupStatus(), { headers: { "Cache-Control": "no-store" } });
}
