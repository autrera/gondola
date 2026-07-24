import { ProviderError } from "./types";
import type {
  Capability,
  CredentialValidation,
  InferenceProbeResult,
  ProviderAdapter,
  ProviderCredential,
  ProviderModel,
} from "./types";

const SURPLUS_BASE_URL = "https://api.surplusintelligence.ai/v1";

export interface RawSurplusModel {
  id: string;
  type: string;
  model_spec?: {
    name?: string;
    beta?: boolean;
    offline?: boolean;
    privacy?: string;
    description?: string;
    capabilities?: Record<string, boolean | number | string | string[]>;
    constraints?: Record<string, unknown>;
    pricing?: Record<string, unknown>;
    traits?: string[];
    voices?: string[];
    default_voice?: string;
  };
}

async function surplusRequestWithKey(
  path: string,
  init: RequestInit,
  key: string,
  signal?: AbortSignal,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${key}`);
  const url = `${SURPLUS_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
  return fetch(url, {
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
  invalid_credential: "Surplus Intelligence rejected this key. Check that you copied the correct API key.",
  no_credits: "This Surplus Intelligence key has no available credits. Add credits, then verify again.",
  unreachable: "Gondola could not reach Surplus Intelligence. Check your connection and try again.",
  unknown: "Surplus Intelligence could not verify this key right now. Try again in a moment.",
};

const SURPLUS_CAPABILITIES: Capability[] = [
  "chat",
  "reasoning",
  "vision",
  "search",
  "transcription",
  "speech",
  "image",
  "video",
  "music",
  "embedding",
];

function deriveSurplusModelType(raw: Record<string, unknown>): string {
  if (typeof raw.type === "string" && raw.type) return raw.type.toLowerCase();
  const idLower = String(raw.id || "").toLowerCase();
  const nameLower = typeof raw.name === "string" ? raw.name.toLowerCase() : "";
  const label = `${idLower} ${nameLower}`;
  const architecture = (raw.architecture ?? {}) as {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
  };
  const modality = (architecture.modality || "").toLowerCase();
  const inputModalities = (architecture.input_modalities || []).map((m) => String(m).toLowerCase());
  const outputModalities = (architecture.output_modalities || []).map((m) => String(m).toLowerCase());

  const rawFeatures = Array.isArray(raw.supported_features) ? raw.supported_features : [];
  const rawTraits = Array.isArray(raw.traits) ? raw.traits : [];
  const traits = [...new Set([...rawTraits, ...rawFeatures])].map((t) => String(t).toLowerCase());
  const traitSet = new Set(traits);

  if (modality === "embedding" || idLower.includes("embed") || traitSet.has("embedding")) {
    return "embedding";
  }
  if (modality === "video" || outputModalities.includes("video") || traitSet.has("video") || /(?:^|[-_])video(?:$|[-_])|t2v|i2v/.test(label)) {
    return "video";
  }
  if (/(?:^|[-_])tts(?:$|[-_])|speech|voice/.test(label)) {
    return "tts";
  }
  if (/(?:^|[-_])stt(?:$|[-_])|asr|transcri|whisper|scribe/.test(label) || modality === "audio->text") {
    return "stt";
  }
  if (modality === "music" || outputModalities.includes("music") || /(?:^|[-_])music(?:$|[-_])|song|ace-step/.test(label)) {
    return "music";
  }
  if (modality === "text->audio" || outputModalities.includes("audio")) {
    return "tts";
  }
  if (modality === "text->image" || outputModalities.includes("image") || (/(?:^|[-_])image(?:$|[-_])|upscale/.test(label) && !inputModalities.includes("image"))) {
    return "image";
  }
  return "text";
}

export function normalizeSurplusModel(rawInput: unknown): RawSurplusModel {
  const raw = (rawInput ?? {}) as Record<string, unknown>;

  if (typeof raw.type === "string" && raw.type && raw.model_spec && typeof raw.model_spec === "object") {
    return raw as unknown as RawSurplusModel;
  }

  const id = String(raw.id || "");
  const idLower = id.toLowerCase();
  const name = typeof raw.name === "string" && raw.name ? raw.name : id;
  const nameLower = name.toLowerCase();

  const architecture = (raw.architecture ?? {}) as {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
  };
  const modality = (architecture.modality || "").toLowerCase();
  const inputModalities = (architecture.input_modalities || []).map((m) => String(m).toLowerCase());
  const outputModalities = (architecture.output_modalities || []).map((m) => String(m).toLowerCase());

  const rawFeatures = Array.isArray(raw.supported_features) ? raw.supported_features : [];
  const rawTraits = Array.isArray(raw.traits) ? raw.traits : [];
  const traits = [...new Set([...rawTraits, ...rawFeatures])].map((t) => String(t).toLowerCase());
  const traitSet = new Set(traits);

  const rawParams = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : [];
  const params = rawParams.map((p) => String(p).toLowerCase());
  const paramSet = new Set(params);

  const type = deriveSurplusModelType(raw);
  const isText = type === "text" || type === "chat" || type === "llm";
  const capsInput = (raw.capabilities ?? {}) as Record<string, unknown>;

  const supportsFunctionCalling = typeof capsInput.supportsFunctionCalling === "boolean"
    ? capsInput.supportsFunctionCalling
    : isText || traitSet.has("tools") || paramSet.has("tools") || paramSet.has("tool_choice");

  const supportsVision = typeof capsInput.supportsVision === "boolean"
    ? capsInput.supportsVision
    : traitSet.has("vision") || inputModalities.includes("image") || modality.includes("image->");

  const supportsReasoning = typeof capsInput.supportsReasoning === "boolean"
    ? capsInput.supportsReasoning
    : traitSet.has("reasoning") || traitSet.has("thinking") || paramSet.has("reasoning") || paramSet.has("include_reasoning");

  const supportsReasoningEffort = typeof capsInput.supportsReasoningEffort === "boolean"
    ? capsInput.supportsReasoningEffort
    : supportsReasoning || traitSet.has("reasoning_effort") || paramSet.has("reasoning_effort");

  const supportsVideo = typeof capsInput.supportsVideo === "boolean"
    ? capsInput.supportsVideo
    : type === "video" || traitSet.has("video") || outputModalities.includes("video");

  const supportsVideoInput = typeof capsInput.supportsVideoInput === "boolean"
    ? capsInput.supportsVideoInput
    : inputModalities.includes("video");

  const supportsResponseSchema = typeof capsInput.supportsResponseSchema === "boolean"
    ? capsInput.supportsResponseSchema
    : traitSet.has("structured_outputs") || traitSet.has("json_mode") || paramSet.has("response_format") || paramSet.has("structured_outputs");

  const capsObj: Record<string, boolean | number | string | string[]> = {
    supportsFunctionCalling,
    supportsVision,
    supportsReasoning,
    supportsReasoningEffort,
    supportsVideo,
    supportsVideoInput,
    supportsResponseSchema,
  };

  const constraintsInput = (raw.constraints ?? {}) as Record<string, unknown>;
  const contextTokens = (typeof constraintsInput.contextTokens === "number" ? constraintsInput.contextTokens : undefined)
    ?? (typeof capsInput.availableContextTokens === "number" ? capsInput.availableContextTokens : undefined)
    ?? (typeof raw.context_length === "number" ? raw.context_length : undefined);

  if (typeof contextTokens === "number" && contextTokens > 0) {
    capsObj.availableContextTokens = contextTokens;
  }

  const spec: RawSurplusModel["model_spec"] = {
    name,
    beta: typeof raw.beta === "boolean" ? raw.beta : idLower.includes("beta") || nameLower.includes("beta"),
    privacy: typeof raw.privacy === "string" ? raw.privacy : "private",
    description: typeof raw.description === "string" ? raw.description : undefined,
    capabilities: capsObj,
    constraints: contextTokens ? { contextTokens } : undefined,
    pricing: typeof raw.pricing === "object" && raw.pricing !== null ? raw.pricing as Record<string, unknown> : undefined,
    traits: traits.length > 0 ? traits : undefined,
  };

  return {
    id,
    type,
    model_spec: spec,
  };
}

function deriveModelCapabilities(model: RawSurplusModel): Capability[] {
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
  } else if (type === "tts" || type === "speech" || /(?:^|[-_])tts(?:$|[-_])|speech|voice/.test(label)) {
    result.add("speech");
  } else if (type === "stt" || type === "asr" || /(?:^|[-_])stt(?:$|[-_])|transcri|whisper|scribe/.test(label)) {
    result.add("transcription");
  } else if (type === "video" || /video/.test(label)) {
    result.add("video");
  } else if (type === "music" || /music|song|ace-step/.test(label)) {
    result.add("music");
  }
  return [...result];
}

function toProviderModel(model: RawSurplusModel, rawInput?: unknown): ProviderModel {
  const spec = model.model_spec ?? {};
  const rawCaps = (spec.capabilities ?? {}) as Record<string, unknown>;
  const isText = model.type === "text" || model.type === "chat" || model.type === "llm";
  const capsObj: Record<string, boolean | number | string | string[]> = {
    ...rawCaps,
    supportsFunctionCalling: typeof rawCaps.supportsFunctionCalling === "boolean"
      ? rawCaps.supportsFunctionCalling
      : isText,
    supportsVision: typeof rawCaps.supportsVision === "boolean"
      ? rawCaps.supportsVision
      : deriveModelCapabilities(model).includes("vision"),
    supportsReasoning: typeof rawCaps.supportsReasoning === "boolean"
      ? rawCaps.supportsReasoning
      : deriveModelCapabilities(model).includes("reasoning"),
  };
  return {
    id: model.id,
    type: model.type,
    name: spec.name ?? model.id,
    capabilities: deriveModelCapabilities(model),
    capabilitiesObject: capsObj,
    constraints: spec.constraints,
    pricing: spec.pricing,
    traits: spec.traits,
    beta: spec.beta,
    privacy: spec.privacy,
    voices: spec.voices,
    defaultVoice: spec.default_voice,
    raw: (rawInput ?? model) as Record<string, unknown>,
  };
}

async function fetchCatalog(credential: ProviderCredential, signal?: AbortSignal): Promise<ProviderModel[]> {
  let response: Response;
  try {
    response = await surplusRequestWithKey("/models", { method: "GET" }, credential.apiKey, signal);
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new ProviderError(CAPABILITY_MESSAGES.unreachable, "unreachable");
  }
  if (!response.ok) {
    const reason = reasonFromStatus(response.status) ?? "unknown";
    const upstream = await safeUpstreamMessage(response);
    throw new ProviderError(upstream ?? CAPABILITY_MESSAGES[reason], reason, response.status);
  }
  const body = await response.json() as { data?: unknown[]; models?: unknown[] };
  const rawItems = Array.isArray(body.models) ? body.models : Array.isArray(body.data) ? body.data : [];

  // Safety net: hardcoded fallbacks for empty-catalog edge cases
  // (e.g. network error that didn't throw, or an API that returned valid JSON with no models).
  if (rawItems.length === 0) {
    const fallbacks: RawSurplusModel[] = [
      { id: "glm-5.2", type: "text", model_spec: { name: "GLM 5.2", capabilities: { supportsFunctionCalling: true, supportsReasoning: true, supportsReasoningEffort: true }, privacy: "private" } },
      { id: "deepseek-v4-flash", type: "text", model_spec: { name: "DeepSeek V4 Flash", capabilities: { supportsFunctionCalling: true, supportsReasoning: true, supportsReasoningEffort: true }, privacy: "private" } },
      { id: "grok-4.5", type: "text", model_spec: { name: "Grok 4.5", capabilities: { supportsFunctionCalling: true, supportsVision: true, supportsReasoning: true, supportsReasoningEffort: true }, privacy: "private" } },
      { id: "venice-kokoro-tts", type: "tts", model_spec: { name: "Kokoro TTS", capabilities: {}, privacy: "private" } },
      { id: "venice-whisper-large-v3", type: "stt", model_spec: { name: "Whisper Large v3", capabilities: {}, privacy: "private" } },
      { id: "gpt-5.4-image-2", type: "image", model_spec: { name: "GPT 5.4 Image 2", capabilities: {}, privacy: "private" } },
      { id: "venice-runway-gen4-5-text", type: "video", model_spec: { name: "Runway Gen 4.5", capabilities: {}, privacy: "private" } },
      { id: "venice-ace-step-15", type: "music", model_spec: { name: "ACE Step 1.5", capabilities: {}, privacy: "private" } },
    ];
    return fallbacks.map((f) => toProviderModel(f));
  }

  return rawItems
    .map((item) => ({ rawItem: item, model: normalizeSurplusModel(item) }))
    .filter(({ model }) => !model.model_spec?.offline)
    .map(({ model, rawItem }) => toProviderModel(model, rawItem));
}

export const surplusAdapter: ProviderAdapter = {
  id: "surplus",
  name: "Surplus Intelligence",
  capabilities: SURPLUS_CAPABILITIES,
  envVar: "SURPLUS_API_KEY",
  keyManagementUrl: "https://surplusintelligence.ai/keys",
  baseUrl: SURPLUS_BASE_URL,

  async validateCredential(credential, signal): Promise<CredentialValidation> {
    try {
      const response = await surplusRequestWithKey("/models", { method: "GET" }, credential.apiKey, signal);
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
      const response = await surplusRequestWithKey(
        "/chat/completions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 1,
            temperature: 0,
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
        return { ok: false, model, reason: "unknown", message: "Surplus Intelligence returned an empty completion." };
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
        message: upstream ?? "Surplus Intelligence could not complete a test message with this model.",
      };
    } catch (error) {
      if (isAbort(error)) throw error;
      return { ok: false, model, reason: "unreachable", message: CAPABILITY_MESSAGES.unreachable };
    }
  },

  selectDefaultChatModel(models): string | undefined {
    const chatModels = models.filter((model) => model.capabilities.includes("chat"));
    if (!chatModels.length) return undefined;
    const preferredPrimary = chatModels.find((model) => model.id === "glm-5.2");
    if (preferredPrimary) return preferredPrimary.id;
    const preferredFast = chatModels.find((model) => model.id === "deepseek-v4-flash");
    if (preferredFast) return preferredFast.id;
    return (chatModels.find((model) => !model.beta) ?? chatModels[0]).id;
  },
};
