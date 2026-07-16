import { rejectUntrustedLocalRequest } from "@/lib/request-security";
import { buildRuntimeSnapshot } from "@/lib/runtime-snapshot";
import { renderRuntimeExplain, renderRuntimeSummary, selectRuntimeSection, type RuntimeSection } from "@/lib/runtime-state";
import { DEFAULT_AGENT_ID, getAgentRuntime } from "@/lib/workspace";
import { DEFAULT_SETTINGS } from "@/lib/app-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only view of the runtime snapshot for a conversation, for a client panel
// or debugging. The agent's own runtime_status tool is authoritative for the
// full live toolset (MCP + abilities); here the capability registry uses the
// standard built-in set so the endpoint works without a live session.
const BASE_CAPABILITIES: { name: string }[] = [
  "generate_image", "generate_video", "generate_music", "media_task_list", "media_task_await",
  "inspect_camera", "search_web", "session_search", "search_memory", "memory",
  "read_file", "write_file", "edit_file", "list_directory", "create_directory", "move_path", "delete_path", "run_command",
  "delegate_task", "orchestrate", "set_model", "list_models",
  "propose_harness_change", "rewrite_self", "create_ability", "test_ability",
  "venice_api", "venice_reference",
  "runtime_status", "runtime_explain", "set_plan", "update_step", "checkpoint",
].map((name) => ({ name }));

export async function GET(request: Request) {
  const rejected = rejectUntrustedLocalRequest(request);
  if (rejected) return rejected;

  const url = new URL(request.url);
  const conversationId = url.searchParams.get("conversationId") ?? "default";
  const agentId = url.searchParams.get("agentId") ?? DEFAULT_AGENT_ID;
  const format = url.searchParams.get("format");
  const section = (url.searchParams.get("section") ?? undefined) as RuntimeSection | undefined;

  let agentName = "Entity";
  try {
    agentName = (await getAgentRuntime(agentId)).agent.name;
  } catch {
    // fall back to the default entity name
  }

  const snapshot = await buildRuntimeSnapshot({
    entityName: agentName,
    sessionId: conversationId,
    conversationId,
    agentId,
    perOperationCapUsd: DEFAULT_SETTINGS.maxMediaUsd,
    chatModel: DEFAULT_SETTINGS.chatModel,
    tools: BASE_CAPABILITIES,
    memoryAgentId: agentId === DEFAULT_AGENT_ID ? undefined : agentId,
    includeModels: url.searchParams.get("models") === "1" || section === "models",
  });

  if (format === "explain") {
    return new Response(renderRuntimeExplain(snapshot), {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  if (format === "summary") {
    return new Response(renderRuntimeSummary(snapshot), {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  return Response.json(selectRuntimeSection(snapshot, section), { headers: { "Cache-Control": "no-store" } });
}
