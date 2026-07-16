import { SMART_FAST_CHAT_MODEL } from "../app-types";
import type {
  Capability,
  CredentialValidation,
  InferenceProbeResult,
  ProviderAdapter,
  ProviderCredential,
  ProviderModel,
} from "./types";

const VENICE_BASE_URL = "https://api.venice.ai/api/v1";

interface RawVeniceModel {
  id: string;
  type: string;
  model_spec?: {
    name?: string;
    beta?: boolean;
    offline?: boolean;
    privacy?: string;
    description?: string;
    capabilities?: Record<string, boolean | number | string | string[]>;
    voices?: string[];
    default_voice?: string;
  };
}

/**
 * Direct Venice request with an EXPLICIT key. Used only by the adapter's
 * verification methods, which must be able to test a not-yet-saved credential.
 * Runtime inference continues to go through `venice.ts` (which resolves the
 * saved credential). The key is never logged and never included in traces.
 */
async function veniceRequestWithKey(
  path: string,
  init: RequestInit,
  key: string,
  signal?: AbortSignal,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${key}`);
  return fetch(`${VENICE_BASE_URL}${path}`, {
    ...init,
    headers,
    cache: "no-store",
    signal,
  });
}

function reasonFromStatus(status: number): CredentialValidation["reason"] {
  if (status === 401 || status === 403) return "invalid_credential";
  if (status === 402) return "no_credits";
  if (status >= 500) return "unreachable";
  return "unknown";
}

/** Extract a short, safe upstream message. Never contains the credential. */
async function safeUpstreamMessage(response: Response): Promise<string | undefined> {
  try {
    const raw = await response.clone().text();
    if (!raw) return undefined;
    let parsed: unknown = raw;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return raw.slice(0, 200);
    }
    const candidate = parsed as { error?: string | { message?: string }; message?: string };
    const message = typeof candidate?.error === "string"
      ? candidate.error
      : candidate?.error?.message ?? candidate?.message;
    return typeof message === "string" ? message.slice(0, 200) : undefined;
  } catch {
    return undefined;
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

const CAPABILITY_MESSAGES: Record<NonNullable<CredentialValidation["reason"]>, string> = {
  invalid_credential: "Venice rejected this key. Check that you copied the full inference key.",
  no_credits: "This Venice key has no available credits. Add credits, then verify again.",
  unreachable: "Gondola could not reach Venice. Check your connection and try again.",
  unknown: "Venice could not verify this key right now. Try again in a moment.",
};

function deriveModelCapabilities(model: RawVeniceModel): Capability[] {
  const type = model.type.toLowerCase();
  const spec = model.model_spec ?? {};
  const caps = spec.capabilities ?? {};
  const label = `${model.id} ${spec.name ?? ""}`.toLowerCase();
  const has = (key: string) => caps[key] === true;
  const result = new Set<Capability>();

  if (type === "text" || type === "chat" || type === "llm") {
    result.add("chat");
    if (has("supportsReasoning") || has("optimizedForCode")) result.add("reasoning");
    if (has("supportsVision")) result.add("vision");
  } else if (type === "image" || type === "upscale") {
    if (type === "image") result.add("image");
  } else if (type === "embedding") {
    result.add("embedding");
  } else if (type === "tts" || /(?:^|[-_])tts(?:$|[-_])|speech|voice/.test(label)) {
    result.add("speech");
  } else if (type === "stt" || type === "asr" || /(?:^|[-_])stt(?:$|[-_])|transcri|whisper/.test(label)) {
    result.add("transcription");
  } else if (type === "video" || /video/.test(label)) {
    result.add("video");
  } else if (type === "music" || /music|song|ace-step/.test(label)) {
    result.add("music");
  }
  return [...result];
}

function toProviderModel(model: RawVeniceModel): ProviderModel {
  const spec = model.model_spec ?? {};
  return {
    id: model.id,
    type: model.type,
    name: spec.name ?? model.id,
    capabilities: deriveModelCapabilities(model),
    beta: spec.beta,
    privacy: spec.privacy,
    voices: spec.voices,
    defaultVoice: spec.default_voice,
  };
}

async function fetchCatalog(credential: ProviderCredential, signal?: AbortSignal): Promise<ProviderModel[]> {
  const response = await veniceRequestWithKey("/models?type=all", { method: "GET" }, credential.apiKey, signal);
  if (!response.ok) {
    const message = await safeUpstreamMessage(response);
    const error = new Error(message ?? `Venice models request failed (${response.status})`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  const body = await response.json() as { data?: RawVeniceModel[] };
  return (body.data ?? [])
    .filter((model) => !model.model_spec?.offline)
    .map(toProviderModel);
}

export const veniceAdapter: ProviderAdapter = {
  id: "venice",
  name: "Venice",
  capabilities: [
    "chat", "reasoning", "vision", "search", "transcription",
    "speech", "image", "video", "music", "embedding",
  ],
  envVar: "VENICE_API_KEY",
  keyManagementUrl: "https://venice.ai/settings/api",

  async validateCredential(credential, signal): Promise<CredentialValidation> {
    try {
      const response = await veniceRequestWithKey("/models?type=all", { method: "GET" }, credential.apiKey, signal);
      if (response.ok) return { ok: true, status: 200 };
      const reason = reasonFromStatus(response.status);
      const upstream = await safeUpstreamMessage(response);
      return {
        ok: false,
        reason,
        status: response.status,
        message: upstream ?? CAPABILITY_MESSAGES[reason ?? "unknown"],
      };
    } catch (error) {
      if (isAbort(error)) throw error;
      return { ok: false, reason: "unreachable", message: CAPABILITY_MESSAGES.unreachable };
    }
  },

  async listModels(credential, signal): Promise<ProviderModel[]> {
    return fetchCatalog(credential, signal);
  },

  async runInferenceProbe(credential, model, signal): Promise<InferenceProbeResult> {
    const start = Date.now();
    try {
      const response = await veniceRequestWithKey(
        "/chat/completions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "ping" }],
            max_completion_tokens: 1,
            temperature: 0,
            venice_parameters: {
              disable_thinking: true,
              strip_thinking_response: true,
              include_venice_system_prompt: false,
            },
          }),
        },
        credential.apiKey,
        signal,
      );
      if (response.ok) {
        const body = await response.json() as { choices?: unknown[] };
        if (Array.isArray(body.choices) && body.choices.length > 0) {
          return { ok: true, model, latencyMs: Date.now() - start };
        }
        return { ok: false, model, reason: "unknown", message: "Venice returned an empty completion." };
      }
      const reason = response.status === 400 || response.status === 404
        ? "unsupported_model"
        : reasonFromStatus(response.status) ?? "unknown";
      const upstream = await safeUpstreamMessage(response);
      return {
        ok: false,
        model,
        status: response.status,
        reason,
        message: upstream ?? "Venice could not complete a test message with this model.",
      };
    } catch (error) {
      if (isAbort(error)) throw error;
      return { ok: false, model, reason: "unreachable", message: CAPABILITY_MESSAGES.unreachable };
    }
  },

  selectDefaultChatModel(models): string | undefined {
    const chatModels = models.filter((model) => model.capabilities.includes("chat"));
    if (!chatModels.length) return undefined;
    const preferred = chatModels.find((model) => model.id === SMART_FAST_CHAT_MODEL);
    if (preferred) return preferred.id;
    // Prefer a non-beta general chat model; fall back to the first available.
    return (chatModels.find((model) => !model.beta) ?? chatModels[0]).id;
  },
};
