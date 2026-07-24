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

export interface RawSurplusCapabilities {
  supportsFunctionCalling?: boolean;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  supportsReasoningEffort?: boolean;
  supportsVideo?: boolean;
  supportsVideoInput?: boolean;
  supportsResponseSchema?: boolean;
  availableContextTokens?: number;
}

export interface RawSurplusConstraints {
  contextTokens?: number;
}

export interface RawSurplusModel {
  id: string;
  type?: string;
  name?: string;
  beta?: boolean;
  privacy?: string;
  capabilities?: RawSurplusCapabilities;
  constraints?: RawSurplusConstraints;
  pricing?: Record<string, string>;
  traits?: string[];
  created?: number;
  description?: string;
  context_length?: number;
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
    tokenizer?: string;
    instruct_type?: string | null;
  };
  top_provider?: Record<string, unknown>;
  supported_parameters?: string[];
  supported_features?: string[];
  provider?: string;
  per_request_limits?: unknown;
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

/**
 * Surplus reports many more features than gondola maps to capabilities.
 * Only a subset correspond to firstmate Capability values.
 */
const SURPLUS_CAPABILITIES: Capability[] = ["chat", "reasoning", "vision", "embedding"];

/**
 * Map a model's properties (capabilities, traits, supported_features, type) to gondola capabilities.
 * - Embedding models: type="embedding", id contains "embed", or traits/features include "embedding"
 * - All text models get chat capability
 * - "vision" capability/trait/feature → vision capability
 * - "reasoning" capability/trait/feature → reasoning capability
 */
function deriveModelCapabilities(model: RawSurplusModel): Capability[] {
  const type = model.type?.toLowerCase();
  const traits = (model.traits ?? []).map((t: string) => t.toLowerCase());
  const features = (model.supported_features ?? []).map((f: string) => f.toLowerCase());
  const traitSet = new Set(traits);
  const featureSet = new Set(features);
  const idLower = model.id.toLowerCase();
  const caps = new Set<Capability>();

  // Embedding models: type is "embedding", id contains "embed", or traits/features include "embedding"
  if (type === "embedding" || idLower.includes("embed") || traitSet.has("embedding") || featureSet.has("embedding")) {
    caps.add("embedding");
    return [...caps];
  }

  // All text models get chat by default
  caps.add("chat");

  // Map capabilities, traits, and features to Gondola capabilities
  if (model.capabilities?.supportsVision || traitSet.has("vision") || featureSet.has("vision")) {
    caps.add("vision");
  }

  if (model.capabilities?.supportsReasoning || traitSet.has("reasoning") || featureSet.has("reasoning")) {
    caps.add("reasoning");
  }

  return SURPLUS_CAPABILITIES.filter((c) => caps.has(c));
}

/**
 * Derive gondola type from the surplus model's type, traits, or features.
 * Embedding models → "embedding", everything else → "text".
 */
function deriveModelType(model: RawSurplusModel): string {
  if (model.type) return model.type;
  const idLower = model.id.toLowerCase();
  const features = model.supported_features ?? [];
  const traits = model.traits ?? [];
  if (idLower.includes("embed") || features.includes("embedding") || traits.includes("embedding")) return "embedding";
  return "text";
}

function deriveSurplusCapabilitiesObject(model: RawSurplusModel): Record<string, boolean | number | string | string[]> {
  const traits = (model.traits ?? []).map((t: string) => t.toLowerCase());
  const traitSet = new Set(traits);
  const features = (model.supported_features ?? []).map((f: string) => f.toLowerCase());
  const featureSet = new Set(features);
  const params = (model.supported_parameters ?? []).map((p: string) => p.toLowerCase());
  const paramSet = new Set(params);
  const inputModalities = (model.architecture?.input_modalities ?? []).map((m: string) => m.toLowerCase());
  const type = deriveModelType(model);
  const isText = type === "text";

  const supportsFunctionCalling = model.capabilities?.supportsFunctionCalling ?? (isText || traitSet.has("tools") || featureSet.has("tools"));
  const supportsVision = model.capabilities?.supportsVision ?? (traitSet.has("vision") || featureSet.has("vision") || inputModalities.includes("image"));
  const supportsReasoning = model.capabilities?.supportsReasoning ?? (traitSet.has("reasoning") || featureSet.has("reasoning") || featureSet.has("thinking"));
  const supportsReasoningEffort = model.capabilities?.supportsReasoningEffort ?? (supportsReasoning || traitSet.has("reasoning_effort") || featureSet.has("reasoning_effort") || featureSet.has("reasoning-effort"));
  const supportsVideo = model.capabilities?.supportsVideo ?? (traitSet.has("video") || featureSet.has("video") || inputModalities.includes("video"));
  const supportsVideoInput = model.capabilities?.supportsVideoInput ?? supportsVideo;
  const supportsResponseSchema = model.capabilities?.supportsResponseSchema ?? (traitSet.has("structured_outputs") || traitSet.has("json_mode") || featureSet.has("structured_outputs") || featureSet.has("response_format") || paramSet.has("response_format"));

  const capsObj: Record<string, boolean | number | string | string[]> = {
    supportsFunctionCalling,
    supportsVision,
    supportsReasoning,
    supportsReasoningEffort,
    supportsVideo,
    supportsVideoInput,
    supportsResponseSchema,
  };

  const contextTokens = model.capabilities?.availableContextTokens ?? model.constraints?.contextTokens ?? model.context_length;
  if (typeof contextTokens === "number" && contextTokens > 0) {
    capsObj.availableContextTokens = contextTokens;
  }

  return capsObj;
}

function toProviderModel(model: RawSurplusModel): ProviderModel {
  const name = model.name ?? model.id;
  const idLower = model.id.toLowerCase();
  const nameLower = name.toLowerCase();
  const contextTokens = model.constraints?.contextTokens ?? model.capabilities?.availableContextTokens ?? model.context_length;
  return {
    id: model.id,
    type: deriveModelType(model),
    name,
    capabilities: deriveModelCapabilities(model),
    capabilitiesObject: deriveSurplusCapabilitiesObject(model),
    constraints: contextTokens ? { contextTokens } : undefined,
    pricing: model.pricing,
    traits: model.traits ?? model.supported_features,
    beta: model.beta ?? (idLower.includes("beta") || nameLower.includes("beta")),
    privacy: model.privacy ?? "private",
    raw: model as unknown as Record<string, unknown>,
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
  const body = await response.json() as { data?: RawSurplusModel[]; models?: RawSurplusModel[] };
  const rawModels = Array.isArray(body.models) ? body.models : Array.isArray(body.data) ? body.data : [];

  // Safety net: hardcoded fallbacks for empty-catalog edge cases
  // (e.g. network error that didn't throw, or an API that returned valid JSON with no models).
  // The real API returns 346 models, so this should never be reached in normal operation.
  if (rawModels.length === 0) {
    return [
      { id: "glm-5.2", type: "text", name: "GLM 5.2", capabilities: ["chat", "reasoning"], capabilitiesObject: { supportsFunctionCalling: true, supportsReasoning: true, supportsReasoningEffort: true }, privacy: "private" },
      { id: "deepseek-v4-flash", type: "text", name: "DeepSeek V4 Flash", capabilities: ["chat", "reasoning"], capabilitiesObject: { supportsFunctionCalling: true, supportsReasoning: true, supportsReasoningEffort: true }, privacy: "private" },
      { id: "grok-4.5", type: "text", name: "Grok 4.5", capabilities: ["chat", "vision", "reasoning"], capabilitiesObject: { supportsFunctionCalling: true, supportsVision: true, supportsReasoning: true, supportsReasoningEffort: true }, privacy: "private" },
    ];
  }

  return rawModels.map(toProviderModel);
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
