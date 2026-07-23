import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple as streamOpenAICompatible } from "@earendil-works/pi-ai/api/openai-completions";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { completeApiTrace, describeApiTraceError, startApiTrace, traceRequestFromPayload, updateApiTrace, type ApiTraceUsage } from "./api-trace";
import { observeBillingBalance } from "./billing-balance-state";
import { resolveCredential } from "./credential-store";
import { resolveCapabilityRoute } from "./providers/registry";
import { getVeniceKey } from "./venice";

// Shared description of a Venice model over the OpenAI-completions API shape and
// the streaming function that talks to Venice. Used by both the primary agent
// and delegated sub-agents so there is a single source of truth.

export function makeModel(id: string, opts?: { reasoning?: boolean; supportsReasoningEffort?: boolean; maxTokens?: number }): Model<"openai-completions"> {
  // Resolve the provider + base URL through the capability registry instead of
  // hardcoding Venice, so a future per-capability override is a real code path.
  const route = resolveCapabilityRoute("chat");
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: route.providerId,
    baseUrl: route.baseUrl,
    // Reasoning is opt-in per turn: interactive typed chats surface a visible
    // thinking trace, while voice/vision/sub-agent/memory turns stay fast and
    // thinking-free. When true, pi-ai parses the model's reasoning deltas so we
    // can stream them to the UI.
    reasoning: opts?.reasoning === true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 198_000,
    // Output-token ceiling per completion. Kept generous so long structured
    // answers are not truncated mid-sentence, and so reasoning models (whose
    // thinking tokens count against this budget) still have room to answer.
    // Callers pass a smaller value for voice turns, where short spoken replies
    // keep latency low. Auxiliary short-output calls set their own limits.
    maxTokens: opts?.maxTokens ?? 8_192,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: true,
      supportsReasoningEffort: opts?.supportsReasoningEffort === true,
      supportsUsageInStreaming: true,
      supportsStrictMode: true,
      maxTokensField: "max_completion_tokens",
      thinkingFormat: "openai",
    },
  };
}

// Per-model stream timeout. Sized for real work (reasoning, tool calls, long
// context) rather than snappy replies: a model gets up to two minutes before the
// turn abandons it and falls back to the next candidate. Genuine failures (errors
// or empty replies) still fail fast; only a true hang waits out the full budget.
export function createVeniceStreamFn(timeoutMs = 120_000): StreamFn {
  return (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
    const hasVisualContext = context.messages.some((message) => (
      message.role === "user"
      && Array.isArray(message.content)
      && message.content.some((part) => part.type === "image")
    ));
    const traceId = startApiTrace({
      capability: hasVisualContext ? "vision" : "chat",
      label: hasVisualContext ? "Understand vision" : "Reason with a model",
      method: "POST",
      endpoint: "/chat/completions",
      model: model.id,
      request: traceRequestFromPayload("/chat/completions", { model: model.id, stream: true }),
    });
    const callerOnPayload = options?.onPayload;
    const callerOnResponse = options?.onResponse;
    let statusCode: number | undefined;
    const defaultRoute = resolveCapabilityRoute("chat");
    const providerId = (model.provider as string) || defaultRoute.providerId;
    const apiKey = getVeniceKey(providerId);
    const stream = streamOpenAICompatible(model as Model<"openai-completions">, context, {
      ...options,
      apiKey,
      maxRetries: 0,
      timeoutMs,
      onPayload: async (payload, responseModel) => {
        const transformed = await callerOnPayload?.(payload, responseModel);
        const callerPayload = transformed === undefined ? payload : transformed;
        const payloadRecord = callerPayload && typeof callerPayload === "object" ? callerPayload as Record<string, unknown> : undefined;
        const actualPayload = payloadRecord?.stream === true
          ? {
              ...payloadRecord,
              stream_options: {
                ...(payloadRecord.stream_options && typeof payloadRecord.stream_options === "object" ? payloadRecord.stream_options : {}),
                include_usage: true,
              },
            }
          : callerPayload;
        const payloadText = JSON.stringify(actualPayload);
        const hasVisualInput = payloadText.includes('"image_url"') || payloadText.includes('"video_url"');
        const usesWeb = /"enable_web_search":"(?:on|auto)"/.test(payloadText);
        updateApiTrace(traceId, {
          capability: usesWeb ? "web" : hasVisualInput ? "vision" : "chat",
          label: usesWeb ? "Research the web" : hasVisualInput ? "Understand vision" : "Reason with a model",
          model: responseModel.id,
          request: traceRequestFromPayload("/chat/completions", actualPayload),
        });
        return actualPayload;
      },
      onResponse: async (response, responseModel) => {
        statusCode = response.status;
        observeBillingBalance(response.headers);
        updateApiTrace(traceId, {
          statusCode: response.status,
          model: responseModel.id,
          responseId: response.headers["x-request-id"] ?? response.headers["cf-ray"],
        });
        await callerOnResponse?.(response, responseModel);
      },
    });
    void stream.result().then((message) => {
      const costUsd = message.usage.cost.total > 0 ? message.usage.cost.total : undefined;
      const usage: ApiTraceUsage | undefined = message.usage.totalTokens > 0 ? {
        inputTokens: message.usage.input,
        outputTokens: message.usage.output,
        cachedTokens: message.usage.cacheRead,
        totalTokens: message.usage.totalTokens,
        costUsd,
      } : undefined;
      completeApiTrace(
        traceId,
        message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "error" : "success",
        statusCode,
        {
          usage,
          responseId: message.responseId,
          ...(message.stopReason === "aborted" ? {
            error: describeApiTraceError(new DOMException(
              message.errorMessage ?? "Request was cancelled before completion.",
              "AbortError",
            )),
          } : message.stopReason === "error" ? {
            error: describeApiTraceError(message.errorMessage ?? "The Venice streaming request failed."),
          } : {}),
        },
      );
    }).catch((error) => {
      completeApiTrace(traceId, "error", statusCode, { error: describeApiTraceError(error) });
    });
    return stream;
  };
}
