import { toPublicError, veniceJson } from "@/lib/venice";
import { rejectUntrustedLocalRequest } from "@/lib/request-security";
import { SMART_FAST_CHAT_MODEL } from "@/lib/app-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// The inner-loop goal evaluator. A small, fast, tool-free model reads the
// completion condition and the recent conversation and decides whether the goal
// is met, judging only from what is visible. This is deliberately a *different*
// model from the one doing the work (the separation the video argues for): the
// worker should not grade its own homework.

interface EvaluateBody {
  condition?: string;
  transcript?: string;
  model?: string;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

const SYSTEM_PROMPT = `You are a strict goal-completion evaluator for an autonomous agent. You are given a COMPLETION CONDITION and the recent CONVERSATION between a user and the agent. Decide whether the condition is now fully satisfied, judging ONLY from evidence visible in the conversation (concrete results, confirmations, rendered media, tool outcomes). Do not assume work happened that is not shown; if the agent only claims success without evidence, treat the condition as NOT met. Respond with STRICT JSON on a single line and nothing else: {"met": boolean, "reason": string}. "reason" is one short sentence (max 200 chars): why it is met, or the single most important next step if it is not.`;

function parseVerdict(raw: string): { met: boolean; reason: string } {
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const obj = JSON.parse(match[0]) as { met?: unknown; reason?: unknown };
      const reason = typeof obj.reason === "string" ? obj.reason.trim().slice(0, 240) : "";
      return {
        met: obj.met === true,
        reason: reason || (obj.met === true ? "Condition met." : "Condition not yet met."),
      };
    } catch {
      // fall through to heuristic
    }
  }
  const met = /\b(met|complete|satisfied|done|yes)\b/i.test(raw) && !/\b(not|isn't|incomplete|no)\b/i.test(raw);
  return { met, reason: raw.trim().slice(0, 240) || "The evaluator returned no verdict." };
}

export async function POST(request: Request) {
  const rejected = rejectUntrustedLocalRequest(request, "json");
  if (rejected) return rejected;
  try {
    let body: EvaluateBody;
    try {
      body = (await request.json()) as EvaluateBody;
    } catch {
      return Response.json({ error: "The request body must be valid JSON" }, { status: 400 });
    }
    const condition = body.condition?.trim();
    if (!condition) return Response.json({ error: "A goal condition is required" }, { status: 400 });
    const transcript = (body.transcript ?? "").trim().slice(0, 12_000) || "(no conversation yet)";

    const response = await veniceJson<ChatResponse>(
      "/chat/completions",
      {
        model: body.model?.trim() || SMART_FAST_CHAT_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `COMPLETION CONDITION:\n${condition}\n\nRECENT CONVERSATION:\n${transcript}` },
        ],
        max_completion_tokens: 200,
        temperature: 0,
        venice_parameters: { disable_thinking: true, strip_thinking_response: true, include_venice_system_prompt: false },
      },
    );
    const raw = response.choices?.[0]?.message?.content?.trim() ?? "";
    return Response.json(parseVerdict(raw), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const pub = toPublicError(error);
    return Response.json({ error: pub.message, status: pub.status }, { status: pub.status });
  }
}
