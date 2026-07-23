import { rejectUntrustedLocalRequest } from "@/lib/request-security";
import { getSetupStatus } from "@/lib/setup-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only, UI-safe setup status. Returns provider id, state, capability
// readiness, and a masked credential status — never a credential.
export async function GET(request: Request) {
  const rejected = rejectUntrustedLocalRequest(request);
  if (rejected) return rejected;
  const url = new URL(request.url);
  const providerId = url.searchParams.get("providerId") || url.searchParams.get("provider") || undefined;
  return Response.json(getSetupStatus(providerId), { headers: { "Cache-Control": "no-store" } });
}
