import { resolveCredential } from "@/lib/credential-store";
import { resolveCapabilityRoute } from "@/lib/providers/registry";
import { rejectUntrustedLocalRequest } from "@/lib/request-security";
import { getVeniceKey, toPublicError } from "@/lib/venice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PROMPT_CHARS = 8_000;
const MAX_SYSTEM_CHARS = 2_000;
const MAX_COMPLETION_TOKENS = 1_200;

// Side-by-side model comparison. Each request runs ONE model as a plain,
// stateless chat completion (no tools, memory, persistence, or system prompt),
// so comparisons are a fair apples-to-apples answer and never touch the user's
// real conversations. The client fires one request per column in parallel.
export async function POST(request: Request) {
  const rejected = rejectUntrustedLocalRequest(request);
  if (rejected) return rejected;

  let body: { prompt?: unknown; model?: unknown; system?: unknown; providerId?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const system = typeof body.system === "string" ? body.system.trim().slice(0, MAX_SYSTEM_CHARS) : "";
  const requestedProviderId = typeof body.providerId === "string" ? body.providerId.trim() : undefined;
  if (!prompt || !model) {
    return Response.json({ error: "A prompt and a model are required." }, { status: 400 });
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return Response.json({ error: `Prompt is too long (max ${MAX_PROMPT_CHARS} characters).` }, { status: 400 });
  }

  const route = resolveCapabilityRoute("chat");
  const providerId = requestedProviderId ?? route.providerId;
  const baseUrl = route.adapter.baseUrl;
  const key = resolveCredential(providerId)?.apiKey ?? getVeniceKey(providerId);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // The client went away; the outer abort handler tears everything down.
        }
      };

      const upstream = new AbortController();
      const onAbort = () => upstream.abort();
      request.signal.addEventListener("abort", onAbort, { once: true });

      const startedAt = Date.now();
      let firstTokenAt = 0;
      try {
        const messages = system
          ? [{ role: "system", content: system }, { role: "user", content: prompt }]
          : [{ role: "user", content: prompt }];
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            model,
            stream: true,
            messages,
            max_completion_tokens: MAX_COMPLETION_TOKENS,
            stream_options: { include_usage: true },
            venice_parameters: {
              enable_web_search: "off",
              enable_web_scraping: false,
              include_venice_system_prompt: false,
              disable_thinking: true,
              strip_thinking_response: true,
            },
          }),
          signal: upstream.signal,
          cache: "no-store",
        });

        if (!response.ok || !response.body) {
          const detail = await response.text().catch(() => "");
          emit({ type: "error", message: `Model rejected the request (${response.status}).`, detail: detail.slice(0, 300) });
          controller.close();
          return;
        }

        emit({ type: "start", model });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let usage: { input?: number; output?: number; total?: number } | undefined;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data) as {
                choices?: Array<{ delta?: { content?: string } }>;
                usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
              };
              const delta = parsed.choices?.[0]?.delta?.content;
              if (typeof delta === "string" && delta) {
                if (!firstTokenAt) firstTokenAt = Date.now();
                emit({ type: "delta", delta });
              }
              if (parsed.usage) {
                usage = {
                  input: parsed.usage.prompt_tokens,
                  output: parsed.usage.completion_tokens,
                  total: parsed.usage.total_tokens,
                };
              }
            } catch {
              // Ignore a malformed SSE line; the stream continues.
            }
          }
        }

        emit({
          type: "done",
          ms: Date.now() - startedAt,
          firstTokenMs: firstTokenAt ? firstTokenAt - startedAt : undefined,
          usage,
        });
      } catch (error) {
        const aborted = error instanceof Error && error.name === "AbortError";
        if (!aborted) {
          const publicError = toPublicError(error);
          emit({ type: "error", message: publicError.message });
        }
      } finally {
        request.signal.removeEventListener("abort", onAbort);
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
