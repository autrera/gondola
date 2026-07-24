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
  object?: string;
  type?: string;
  owned_by?: string;
  capabilities?: string[];
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

const SURPLUS_CAPABILITIES: Capability[] = ["chat", "reasoning", "vision", "embedding"];

function deriveModelCapabilities(model: RawSurplusModel): Capability[] {
  const id = model.id.toLowerCase();
  const type = (model.type ?? "").toLowerCase();
  const caps = new Set<Capability>();

  if (id.includes("embed") || type === "embedding") {
    caps.add("embedding");
    return [...caps];
  }

  // Text/Chat models
  caps.add("chat");

  if (id === "glm-5.2" || id === "deepseek-v4-flash" || id.includes("glm") || id.includes("deepseek") || id.includes("reasoning")) {
    caps.add("reasoning");
  }

  if (id === "grok-4.5" || id.includes("grok") || id.includes("vision")) {
    caps.add("vision");
    caps.add("reasoning");
  }

  // Also respect raw capabilities if provided in catalog
  if (Array.isArray(model.capabilities)) {
    for (const c of model.capabilities) {
      if (SURPLUS_CAPABILITIES.includes(c as Capability)) {
        caps.add(c as Capability);
      }
    }
  }

  return SURPLUS_CAPABILITIES.filter((c) => caps.has(c));
}

function toProviderModel(model: RawSurplusModel): ProviderModel {
  return {
    id: model.id,
    type: model.type ?? (model.id.includes("embed") ? "embedding" : "chat"),
    name: model.id,
    capabilities: deriveModelCapabilities(model),
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

  // Fallback defaults if catalog is empty or missing expected models
  if (rawModels.length === 0) {
    return [
      { id: "glm-5.2", type: "chat", name: "glm-5.2", capabilities: ["chat", "reasoning"] },
      { id: "deepseek-v4-flash", type: "chat", name: "deepseek-v4-flash", capabilities: ["chat", "reasoning"] },
      { id: "grok-4.5", type: "chat", name: "grok-4.5", capabilities: ["chat", "vision", "reasoning"] },
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
