import { REALTIME_MULTIMODAL_MODEL } from "./app-types";
import { veniceJson } from "./venice";

// The supervisor is the outer loop's safety net for a live turn. It wakes only
// after the inner loop (the model candidate list) has failed, tries exactly one
// safe, stripped-down recovery (a fast model, no reasoning, no web, no tools),
// and if that still cannot answer it replies with a plain-language explanation
// of what broke plus a suggested next step. It never runs on the happy path, and
// it never uses tools, spends money, replays a tool turn, or edits anything.

export type FailureCategory =
  | "timeout"
  | "rate_limit"
  | "auth"
  | "bad_request"
  | "server"
  | "empty"
  | "network"
  | "generic";

export interface FailureDiagnosis {
  category: FailureCategory;
  /** A human-readable reason, lowercase and without trailing punctuation. */
  reason: string;
  suggestion: string;
}

/**
 * Classify a failure into a category with a human reason and a suggested next
 * step. Order matters: more specific signatures are checked before generic ones.
 */
export function diagnoseFailure(error: unknown): FailureDiagnosis {
  const text = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  const has = (pattern: RegExp) => pattern.test(text);
  if (has(/timed?\s*out|timeout|etimedout|deadline|\baborted\b/)) {
    return { category: "timeout", reason: "the model took too long to respond", suggestion: "Try again, or switch to a faster, lighter model." };
  }
  if (has(/\b429\b|rate.?limit|too many requests/)) {
    return { category: "rate_limit", reason: "Venice is rate-limiting requests right now", suggestion: "Wait a few seconds, then try again." };
  }
  if (has(/\b401\b|\b403\b|unauthor|forbidden|invalid.*(key|token)|api key/)) {
    return { category: "auth", reason: "there is an authentication problem with the Venice API key", suggestion: "Check that VENICE_API_KEY is set and valid." };
  }
  if (has(/\b400\b|invalid request|context length|context window|too long|maximum context|max.*tokens/)) {
    return { category: "bad_request", reason: "the request was rejected, often because the conversation got too long", suggestion: "Try a shorter message, or start a new chat." };
  }
  if (has(/\b(500|502|503|504)\b|bad gateway|service unavailable|internal server/)) {
    return { category: "server", reason: "Venice hit a server error", suggestion: "Give it a moment, then try again." };
  }
  if (has(/empty reply|returned an empty|no content|no completion|could not complete the turn/)) {
    return { category: "empty", reason: "the model returned an empty response", suggestion: "Try again, or switch to a different model." };
  }
  if (has(/network|fetch failed|enotfound|econnreset|econnrefused|socket hang|\bdns\b/)) {
    return { category: "network", reason: "I could not reach Venice", suggestion: "Check your connection, then try again." };
  }
  return { category: "generic", reason: "something went wrong completing that turn", suggestion: "Try again in a moment." };
}

/** The plain-language message shown when recovery could not produce an answer. */
export function explanationFor(diagnosis: FailureDiagnosis, triedRecovery: boolean): string {
  const capitalized = diagnosis.reason.charAt(0).toUpperCase() + diagnosis.reason.slice(1);
  const tried = triedRecovery ? " I tried a lighter fallback too, but it did not come through." : "";
  return `${capitalized}.${tried} ${diagnosis.suggestion}`;
}

type Emit = (event: Record<string, unknown>) => void;

export interface SupervisorRecoveryInput {
  /** The latest user message (used when no richer context is supplied). */
  message: string;
  /** The inner loop's final error message. */
  lastError: string;
  /** False when a tool already ran this turn (must not replay); recovery is skipped. */
  canRetry: boolean;
  /** Streams the recovery/explanation to the live turn via text_delta events. */
  emit: Emit;
  signal?: AbortSignal;
  /** Recent conversation turns (text only), most recent last. */
  context?: Array<{ role: "user" | "assistant"; text: string }>;
}

export interface SupervisorRecoveryResult {
  text: string;
  recovered: boolean;
}

// A quick, non-reasoning model for the recovery attempt. Deliberately a
// different family than the default chat model so a stripped retry has a fresh
// chance even when the primary path was struggling.
const RECOVERY_MODEL = REALTIME_MULTIMODAL_MODEL;
const RECOVERY_TIMEOUT_MS = 30_000;
const RECOVERY_LEAD_IN = "My full setup hit a snag, so here is a quick, best-effort answer:\n\n";

const RECOVERY_SYSTEM = "You are the user's AI companion. A previous, fuller attempt to answer just failed. Give a direct, concise, best-effort answer to the user's latest message using only what you already know. Do not use tools, do not mention this failure, your tools, or which model you are, and do not apologize at length. If the request genuinely needs a tool or live data you cannot reach, say briefly what you can and what you would need.";

async function attemptStrippedRecovery(input: SupervisorRecoveryInput): Promise<string> {
  const convo = input.context?.length
    ? input.context.map((entry) => ({ role: entry.role, content: entry.text }))
    : [{ role: "user" as const, content: input.message }];
  const timeout = AbortSignal.timeout(RECOVERY_TIMEOUT_MS);
  const combined = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  const response = await veniceJson<{ choices?: Array<{ message?: { content?: string } }> }>(
    "/chat/completions",
    {
      model: RECOVERY_MODEL,
      messages: [{ role: "system", content: RECOVERY_SYSTEM }, ...convo],
      max_completion_tokens: 800,
      temperature: 0.4,
      reasoning_effort: "none",
      venice_parameters: { disable_thinking: true },
    },
    combined,
  );
  return response.choices?.[0]?.message?.content?.trim() ?? "";
}

/**
 * Recover a failed turn: try one stripped fast completion, and if that cannot
 * answer, stream a plain-language explanation of what broke. Always emits
 * something so the chat never dead-ends, and never throws.
 */
export async function runSupervisorRecovery(input: SupervisorRecoveryInput): Promise<SupervisorRecoveryResult> {
  const diagnosis = diagnoseFailure(input.lastError);
  if (input.canRetry && !input.signal?.aborted) {
    try {
      const answer = await attemptStrippedRecovery(input);
      if (answer && !input.signal?.aborted) {
        input.emit({ type: "text_delta", delta: RECOVERY_LEAD_IN });
        input.emit({ type: "text_delta", delta: answer });
        input.emit({ type: "recovery", recovered: true, category: diagnosis.category });
        return { text: `${RECOVERY_LEAD_IN}${answer}`, recovered: true };
      }
    } catch {
      // Recovery itself failed; fall through to the plain-language explanation.
    }
  }
  if (input.signal?.aborted) return { text: "", recovered: false };
  const explanation = explanationFor(diagnosis, input.canRetry);
  input.emit({ type: "text_delta", delta: explanation });
  input.emit({ type: "recovery", recovered: false, category: diagnosis.category });
  return { text: explanation, recovered: false };
}
