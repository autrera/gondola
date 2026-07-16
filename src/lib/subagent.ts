import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { createVeniceStreamFn, makeModel } from "./venice-model";

// Hermes-style scoped sub-agent delegation, now multi-level.
//
// A parent agent can spin off workers to run focused sub-tasks against a
// restricted toolset and their own bounded iteration budget, then fold only the
// workers' final results back into the parent conversation. Workers may
// themselves coordinate more workers, but only while there is nesting headroom
// (MAX_SUBAGENT_DEPTH) and within a per-turn worker budget enforced by the
// caller. Workers can never delete, run commands, overwrite whole files, spend
// on media, or rewrite the entity's identity, no matter how they are composed.

export const MAX_SUBAGENT_DEPTH = 3;

// The safe worker capability set: research, read-only recall, and constructive
// file work. Deliberately excludes destructive coding tools (delete_path,
// run_command), whole-file overwrite (blocked separately in pi-agent.ts), media
// generation, avatar/presence, memory writes, identity rewrites, and the
// self-extension tools. Coordination tools (delegate_task, orchestrate) and
// self-authored abilities are granted separately, only below the depth cap.
const WORKER_BASE_TOOLS = new Set([
  "search_web",
  "session_search",
  "search_memory",
  "inspect_camera",
  "use_skill",
  "venice_reference",
  "route_model",
  "analyze_media",
  "asset_list",
  "asset_get",
  "media_task_status",
  "media_task_list",
  "read_file",
  "list_directory",
  "create_directory",
  "write_file",
  "edit_file",
  "move_path",
]);

// Tools that spawn their own workers. Allowed only while depth < the cap so a
// chain of sub-agents cannot recurse without bound.
const WORKER_SPAWNING_TOOLS = new Set(["delegate_task", "orchestrate"]);

// Self-authored abilities carry this label prefix (see custom-tools.ts). They
// also spawn a scoped worker, so they follow the same depth rule.
const ABILITY_LABEL_PREFIX = "Ability:";

/**
 * Restrict a candidate toolset to what a worker running at `depth` may use.
 * Base capabilities are always allowed; coordination tools and abilities are
 * allowed only while there is nesting headroom.
 */
export function scopeToolsForWorker(tools: AgentTool[], depth: number): AgentTool[] {
  const canSpawn = depth < MAX_SUBAGENT_DEPTH;
  return tools.filter((tool) => {
    if (WORKER_BASE_TOOLS.has(tool.name)) return true;
    if (canSpawn && WORKER_SPAWNING_TOOLS.has(tool.name)) return true;
    if (canSpawn && typeof tool.label === "string" && tool.label.startsWith(ABILITY_LABEL_PREFIX)) return true;
    return false;
  });
}

const WORKER_SYSTEM_PROMPT = `You are a focused worker sub-agent spawned by a primary AI companion to complete one specific task.

- Work autonomously and efficiently. Use the tools available to you to gather what you need.
- Do not chat, greet, role-play, or add persona. You are an internal worker.
- For coding or file tasks: explore with list_directory and read_file before changing anything, then create files with write_file and modify existing ones with edit_file (use a unique old_string). You cannot overwrite existing files wholesale, delete anything, or run terminal commands; leave those to the primary agent. Never write secrets or credentials.
- If you can coordinate more workers (delegate_task or orchestrate), break a large task into independent parts and combine their results.
- When done, reply with a single concise, self-contained result that the primary agent can use directly. Prefer tight prose. List the files you created or changed with their paths, include concrete findings, and add source URLs when you researched the web.
- If you cannot complete the task, say briefly what you did, what you found, and what is blocking you.`;

export interface SubAgentResult {
  text: string;
  turns: number;
  toolCalls: number;
  hitBudget: boolean;
}

// Structured progress a worker reports as it runs, so the primary turn can show
// a live task card (which tool the worker is using, and how many steps it took).
export type SubAgentStatus =
  | { phase: "tool"; tool: string }
  | { phase: "turn"; turn: number };

export interface SubAgentInput {
  task: string;
  model: string;
  tools: AgentTool[];
  /** Depth this worker runs at (primary = 0). Used to scope its toolset. */
  depth?: number;
  /** Optional role/system prompt override (abilities pass their playbook). */
  systemPrompt?: string;
  maxTurns?: number;
  signal?: AbortSignal;
  onStatus?: (status: SubAgentStatus) => void;
}

export async function runSubAgent(input: SubAgentInput): Promise<SubAgentResult> {
  const maxTurns = input.maxTurns ?? 8;
  const scopedTools = scopeToolsForWorker(input.tools, input.depth ?? MAX_SUBAGENT_DEPTH - 1);

  const agent = new Agent({
    initialState: {
      systemPrompt: input.systemPrompt?.trim() ? input.systemPrompt : WORKER_SYSTEM_PROMPT,
      model: makeModel(input.model),
      thinkingLevel: "off",
      tools: scopedTools,
      messages: [],
    },
    // Sub-agents do real, sometimes slow work (research, analysis); give them the
    // same generous per-model budget as the main turn instead of a tight 20s.
    streamFn: createVeniceStreamFn(),
    toolExecution: "parallel",
    maxRetryDelayMs: 2_500,
    onPayload: (payload) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
      const record = payload as Record<string, unknown>;
      const existing = record.venice_parameters;
      return {
        ...record,
        venice_parameters: {
          ...(existing && typeof existing === "object" ? existing : {}),
          enable_web_search: "off",
          enable_web_scraping: false,
          disable_thinking: true,
          strip_thinking_response: true,
        },
      };
    },
  });

  let turns = 0;
  let toolCalls = 0;
  let hitBudget = false;
  let latestText = "";

  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      toolCalls += 1;
      input.onStatus?.({ phase: "tool", tool: event.toolName });
    } else if (event.type === "turn_end") {
      turns += 1;
      input.onStatus?.({ phase: "turn", turn: turns });
      if (turns >= maxTurns && agent.state.isStreaming) {
        hitBudget = true;
        agent.abort();
      }
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      const text = event.message.content.map((part) => (part.type === "text" ? part.text : "")).join("").trim();
      if (text && event.message.stopReason !== "error") latestText = text;
    }
  });

  const onAbort = () => {
    if (agent.state.isStreaming) agent.abort();
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await agent.prompt(input.task);
  } finally {
    unsubscribe();
    input.signal?.removeEventListener("abort", onAbort);
  }

  const text = latestText
    || (hitBudget
      ? "The worker reached its step budget before finishing. Partial progress may be available."
      : "The worker did not produce a result.");
  return { text, turns, toolCalls, hitBudget };
}

// A single job for the parallel runner. Lifecycle callbacks let the caller
// correlate live UI events (start/step/end) with each worker.
export interface SubAgentJob extends Omit<SubAgentInput, "onStatus"> {
  onStart?: () => void;
  onStatus?: (status: SubAgentStatus) => void;
  onEnd?: (result: SubAgentResult, error?: unknown) => void;
}

/**
 * Run several workers with a bounded concurrency. One worker failing produces a
 * fallback result rather than aborting the whole batch, so the primary agent
 * still gets partial coordination output.
 */
export async function runSubAgents(
  jobs: SubAgentJob[],
  options: { concurrency: number; signal?: AbortSignal },
): Promise<SubAgentResult[]> {
  const results: SubAgentResult[] = new Array(jobs.length);
  let cursor = 0;
  const runNext = async (): Promise<void> => {
    const index = cursor;
    cursor += 1;
    if (index >= jobs.length) return;
    const { onStart, onStatus, onEnd, ...runInput } = jobs[index];
    onStart?.();
    try {
      const result = await runSubAgent({ ...runInput, signal: options.signal, onStatus });
      results[index] = result;
      onEnd?.(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The worker failed to run.";
      const fallback: SubAgentResult = { text: `This worker could not complete: ${message}`, turns: 0, toolCalls: 0, hitBudget: false };
      results[index] = fallback;
      onEnd?.(fallback, error);
    }
    return runNext();
  };
  const lanes = Math.max(1, Math.min(options.concurrency, jobs.length));
  await Promise.all(Array.from({ length: lanes }, () => runNext()));
  return results;
}
