import { rejectUntrustedLocalRequest } from "@/lib/request-security";
import {
  grantSession,
  listApprovals,
  listGrants,
  resolveApprovalRequest,
  revokeSession,
} from "@/lib/approval-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Owner-facing view + control of the approval ledger and session grants. The
// agent never grants itself approval; only the owner (through this route / UI)
// can grant or revoke a session-scoped auto-approval or resolve a pending item.
export async function GET(request: Request) {
  const rejected = rejectUntrustedLocalRequest(request);
  if (rejected) return rejected;
  const conversationId = new URL(request.url).searchParams.get("conversationId") ?? undefined;
  const [records, grants] = await Promise.all([
    listApprovals({ conversationId, limit: 100 }),
    listGrants(conversationId),
  ]);
  return Response.json({ records, grants }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const rejected = rejectUntrustedLocalRequest(request, "json");
  if (rejected) return rejected;
  try {
    const body = (await request.json().catch(() => ({}))) as {
      action?: string;
      conversationId?: string;
      tool?: string;
      id?: string;
      status?: string;
    };
    const action = String(body.action ?? "");
    if (action === "grant" && body.conversationId && body.tool) {
      return Response.json({ grant: await grantSession({ conversationId: body.conversationId, tool: body.tool }) });
    }
    if (action === "revoke" && body.conversationId && body.tool) {
      return Response.json({ revoked: await revokeSession(body.conversationId, body.tool) });
    }
    if (action === "resolve" && body.id && (body.status === "approved" || body.status === "rejected")) {
      return Response.json({ record: await resolveApprovalRequest(body.id, body.status) });
    }
    return Response.json({ error: "Unknown or incomplete approvals action" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Approvals request failed" }, { status: 400 });
  }
}
