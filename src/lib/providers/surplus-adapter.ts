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

interface RawSurplusModel {
  id: string;
  name: string;
  created: number;
  description?: string;
  context_length?: number;
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
    tokenizer?: string;
    instruct_type?: string | null;
  };
  pricing?: Record<string, string>;
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
 * Map a model's supported_features to gondola capabilities.
 * - All text/text->text models are chat-capable
 * - "vision" feature → vision capability
 * - "reasoning" feature → reasoning capability
 * - "embedding" feature → embedding capability
 */
function deriveModelCapabilities(model: RawSurplusModel): Capability[] {
  const features = model.supported_features ?? [];
  const featureSet = new Set(features.map((f: string) => f.toLowerCase()));
  const idLower = model.id.toLowerCase();
  const caps = new Set<Capability>();

  // Embedding models: id contains "embed" or features include "embedding"
  if (idLower.includes("embed") || featureSet.has("embedding")) {
    caps.add("embedding");
    return [...caps];
  }

  // All text models get chat by default
  caps.add("chat");

  // Map supported features to capabilities
  if (featureSet.has("vision")) caps.add("vision");
  if (featureSet.has("reasoning")) caps.add("reasoning");

  return SURPLUS_CAPABILITIES.filter((c) => caps.has(c));
}

/**
 * Derive gondola type from the surplus model's features.
 * Embedding models → "embedding", everything else → "text" (matching how
 * Venice types work — text models with vision features vs image models).
 */
function deriveModelType(model: RawSurplusModel): string {
  const idLower = model.id.toLowerCase();
  const features = model.supported_features ?? [];
  if (idLower.includes("embed") || features.includes("embedding")) return "embedding";
  return "text";
}

function toProviderModel(model: RawSurplusModel): ProviderModel {
  return {
    id: model.id,
    type: deriveModelType(model),
    name: model.name,
    capabilities: deriveModelCapabilities(model),
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
  const body = await response.json() as { data?: RawSurplusModel[] };
  const rawModels = Array.isArray(body.data) ? body.data : [];

  // Safety net: hardcoded fallbacks for empty-catalog edge cases
  // (e.g. network error that didn't throw, or an API that returned valid JSON with no models).
  // The real API returns 346 models, so this should never be reached in normal operation.
  if (rawModels.length === 0) {
    return [
      { id: "glm-5.2", type: "text", name: "GLM 5.2", capabilities: ["chat", "reasoning"] },
      { id: "deepseek-v4-flash", type: "text", name: "DeepSeek V4 Flash", capabilities: ["chat", "reasoning"] },
      { id: "grok-4.5", type: "text", name: "Grok 4.5", capabilities: ["chat", "vision", "reasoning"] },
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
