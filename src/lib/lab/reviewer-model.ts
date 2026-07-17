import { SMART_FAST_CHAT_MODEL } from "../app-types";
import { veniceJson } from "../venice";
import {
  effectivePatch,
  proposalSignature,
  sanitizeWorkflowPatch,
  WRITABLE_POLICY_FIELDS,
  type ProposalDraft,
  type ProposerFeedback,
} from "./reviewer";
import type { LabConfig, RunTrace } from "./types";

// A model-based reviewer. Instead of matching the agent's flag against a fixed
// keyword list, a fast model reads the flag, the recent traces, and the current
// workflow policy, then proposes ONE bounded change. Its output is never trusted
// directly: it is coerced through sanitizeWorkflowPatch (whitelisted fields only)
// and effectivePatch (drop no-ops), so the model can only ever move a known,
// allowed lever - never code, credentials, budgets, or graders.

export type ReviewerCompletion = (system: string, user: string) => Promise<string>;

const REVIEWER_SYSTEM = `You are Gondola Lab's reviewer, a control-plane role separate from the acting agent. You read the agent's flagged problem, recent run evidence, and the current workflow policy, and you propose exactly ONE small, testable change to the workflow policy that would address the problem. You never change code, credentials, budgets, graders, thresholds, permissions, or tools - only the workflow-policy fields listed. If no bounded policy change would help, say so.

You may only set these workflow-policy fields:
- conceptCount (integer 1-8): how many concepts to explore before choosing.
- useSeparateCritic (boolean): run a distinct critique pass.
- requireAnalyzeBeforeAnimate (boolean): inspect an image before animating it.
- reviseBelowQuality (number 0-10 or null): revise while quality is under this.
- maxRevisions (integer 0-5): revision cap.
- latencyMode ("fast" | "balanced"): favor speed after repeated slowness/timeouts.
- confirmMediaFormat (boolean): set and confirm the target aspect ratio/format (e.g. 9:16 for Reels) before generating media.

Respond with ONLY a JSON object, no prose, in one of these shapes:
{"noChange": true, "why": "<short reason nothing bounded applies>"}
or
{"configPatch": { <one or more of the fields above> }, "observedProblem": "<one sentence>", "hypothesis": "<one sentence, falsifiable>", "targetMetric": "semantic_quality | completion_rate | latency | cost | human_intervention", "expectedTradeoffs": "<short>", "riskLevel": "low | medium | high"}`;

function summarizeTraces(traces: RunTrace[]): string {
  if (!traces.length) return "No recent traces are available.";
  return traces.slice(0, 8).map((trace) => {
    const tools = trace.toolCalls.map((call) => call.tool + (call.ok ? "" : "!")).join(", ") || "none";
    const bits = [
      trace.completed ? "completed" : "incomplete",
      trace.failureCategory ? `failure:${trace.failureCategory}` : "",
      `interventions:${trace.humanInterventions}`,
      `tools:[${tools}]`,
    ].filter(Boolean);
    return `- ${trace.goal.slice(0, 80)} (${bits.join(" ")})`;
  }).join("\n");
}

function buildUserPrompt(reason: string, traces: RunTrace[], champion: LabConfig): string {
  return [
    `The acting agent flagged this problem:\n"${reason.slice(0, 400)}"`,
    `Current workflow policy:\n${JSON.stringify(champion.workflowPolicy)}`,
    `Recent run evidence:\n${summarizeTraces(traces)}`,
    "Propose one bounded workflow-policy change that would address the flag, or noChange.",
  ].join("\n\n");
}

// Tolerant JSON extraction: the model may wrap JSON in stray prose or fences.
function extractJson(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const KNOWN_METRICS = new Set(["semantic_quality", "completion_rate", "latency", "cost", "human_intervention"]);

const defaultCompletion: ReviewerCompletion = async (system, user) => {
  const response = await veniceJson<{ choices?: Array<{ message?: { content?: string } }> }>(
    "/chat/completions",
    {
      model: SMART_FAST_CHAT_MODEL,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      max_completion_tokens: 400,
      temperature: 0.2,
      reasoning_effort: "none",
      venice_parameters: { disable_thinking: true },
    },
  );
  return response.choices?.[0]?.message?.content ?? "";
};

export interface ModelReviewInput {
  reason: string;
  traces: RunTrace[];
  champion: LabConfig;
  feedback?: ProposerFeedback;
  /** Injectable for tests; defaults to a fast Venice completion. */
  complete?: ReviewerCompletion;
}

/**
 * Turn an agent-flagged problem into a bounded workflow-policy proposal by model
 * reasoning (not keyword matching). Returns null when the model declines, the
 * patch is out of scope, a no-op, or a duplicate. Never throws.
 */
export async function reviewFlaggedWithModel(input: ModelReviewInput): Promise<ProposalDraft | null> {
  const reason = input.reason.trim();
  if (!reason) return null;
  const complete = input.complete ?? defaultCompletion;

  let raw: string;
  try {
    raw = await complete(REVIEWER_SYSTEM, buildUserPrompt(reason, input.traces, input.champion));
  } catch {
    return null;
  }
  const parsed = extractJson(raw);
  if (!parsed || parsed.noChange === true) return null;

  const patch = effectivePatch(sanitizeWorkflowPatch(parsed.configPatch), input.champion);
  if (!Object.keys(patch).length) return null;
  if (input.feedback?.avoidSignatures.includes(proposalSignature("workflow_policy", patch))) return null;

  const targetMetric = typeof parsed.targetMetric === "string" && KNOWN_METRICS.has(parsed.targetMetric)
    ? parsed.targetMetric
    : "human_intervention";
  const riskLevel = parsed.riskLevel === "medium" || parsed.riskLevel === "high" ? parsed.riskLevel : "low";
  const evidence = input.traces.slice(0, 5).map((trace) => trace.runId);
  const changed = Object.keys(patch).join(", ");

  return {
    sourceRunIds: evidence,
    observedProblem: typeof parsed.observedProblem === "string" && parsed.observedProblem.trim()
      ? parsed.observedProblem.slice(0, 200)
      : `Agent-flagged: ${reason.slice(0, 160)}`,
    traceEvidence: evidence,
    hypothesis: typeof parsed.hypothesis === "string" && parsed.hypothesis.trim()
      ? parsed.hypothesis.slice(0, 300)
      : `Adjusting ${changed} will address the flagged problem.`,
    category: "workflow_policy",
    configPatch: patch,
    targetMetric,
    expectedTradeoffs: typeof parsed.expectedTradeoffs === "string" && parsed.expectedTradeoffs.trim()
      ? parsed.expectedTradeoffs.slice(0, 200)
      : "A small added step in the workflow.",
    riskLevel,
    evaluationPlan: "Champion vs challenger across the standard cases; require the target metric to improve with no regression beyond tolerance.",
  };
}

// Re-export so the writable set can be referenced without importing two modules.
export { WRITABLE_POLICY_FIELDS };
