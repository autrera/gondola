import { DEFAULT_SETTINGS } from "../app-types";
import { resolveCredential } from "../credential-store";
import { surplusAdapter } from "./surplus-adapter";
import { veniceAdapter } from "./venice-adapter";
import {
  ALL_CAPABILITIES,
  type Capability,
  type CapabilityRoute,
  type ProviderAdapter,
  type ProviderConfiguration,
  type ProviderModel,
} from "./types";

// The single source of provider adapters.
const ADAPTERS: Record<string, ProviderAdapter> = {
  [veniceAdapter.id]: veniceAdapter,
  [surplusAdapter.id]: surplusAdapter,
};

export const DEFAULT_PROVIDER_ID = "venice" as const;

export function resolveDefaultProviderId(
  hasCredential?: (providerId: string) => boolean,
  preferredId: string = DEFAULT_PROVIDER_ID,
): string {
  const checkCredential = hasCredential ?? ((id: string) => Boolean(resolveCredential(id)));
  if (checkCredential(preferredId)) return preferredId;
  for (const provider of listProviders()) {
    if (checkCredential(provider.id)) {
      return provider.id;
    }
  }
  return preferredId;
}

export function listProviders(): ProviderAdapter[] {
  return Object.values(ADAPTERS);
}

export function getProvider(id: string): ProviderAdapter | undefined {
  return ADAPTERS[id];
}

export function requireProvider(id: string): ProviderAdapter {
  const provider = ADAPTERS[id];
  if (!provider) throw new Error(`Unknown provider: ${id}`);
  return provider;
}

/**
 * Reject a capability route the registry cannot honor: an unknown provider, or a
 * capability the provider does not support. Guards config writes so an invalid
 * route can never be persisted or resolved. (Phase 9 test: registry rejects
 * unsupported capability routes.)
 */
export function assertAllowedCapabilityRoute(route: CapabilityRoute): void {
  if (!ALL_CAPABILITIES.includes(route.capability)) {
    throw new Error(`Unknown capability: ${route.capability}`);
  }
  const provider = ADAPTERS[route.providerId];
  if (!provider) {
    throw new Error(`Unknown provider for capability route: ${route.providerId}`);
  }
  if (!provider.capabilities.includes(route.capability)) {
    throw new Error(`Provider ${route.providerId} does not support capability ${route.capability}`);
  }
  if (!route.modelId) {
    throw new Error(`Capability route for ${route.capability} is missing a model`);
  }
  for (const fallback of route.fallbackRoutes ?? []) {
    const fallbackProvider = ADAPTERS[fallback.providerId];
    if (!fallbackProvider?.capabilities.includes(route.capability)) {
      throw new Error(`Fallback provider ${fallback.providerId} does not support capability ${route.capability}`);
    }
  }
}

function modelsForCapability(models: ProviderModel[], capability: Capability): ProviderModel[] {
  // Search is not a distinct model type on Venice — it rides on text/chat models
  // (via Venice web search), so it resolves against chat-capable models.
  const target: Capability = capability === "search" ? "chat" : capability;
  return models.filter((model) => model.capabilities.includes(target));
}

/** Which of the 10 capabilities the live catalog can currently serve. */
export function detectAvailableCapabilities(models: ProviderModel[]): Record<Capability, boolean> {
  const available = {} as Record<Capability, boolean>;
  for (const capability of ALL_CAPABILITIES) {
    available[capability] = modelsForCapability(models, capability).length > 0;
  }
  return available;
}

// Preferred default model per capability, from the hardcoded fallbacks. Used
// only when the id is actually present in the live catalog; otherwise the first
// catalog model of the right capability wins.
const PREFERRED_DEFAULTS: Partial<Record<Capability, string>> = {
  chat: DEFAULT_SETTINGS.chatModel,
  vision: DEFAULT_SETTINGS.visionModel,
  speech: DEFAULT_SETTINGS.ttsModel,
  transcription: DEFAULT_SETTINGS.sttModel,
  image: DEFAULT_SETTINGS.imageModel,
  video: DEFAULT_SETTINGS.videoModel,
  music: DEFAULT_SETTINGS.musicModel,
};

const SURPLUS_PREFERRED_DEFAULTS: Partial<Record<Capability, string>> = {
  chat: "glm-5.2",
  vision: "grok-4.5",
  reasoning: "glm-5.2",
  speech: "venice-kokoro-tts",
  transcription: "venice-whisper-large-v3",
  image: "gpt-5.4-image-2",
  video: "venice-runway-gen4-5-text",
  music: "venice-ace-step-15",
};

function pickModel(
  models: ProviderModel[],
  capability: Capability,
  providerId?: string,
  selectedModels?: Partial<Record<Capability, string>>,
): ProviderModel | undefined {
  const candidates = modelsForCapability(models, capability);
  if (!candidates.length) return undefined;

  const userSelectedId = selectedModels?.[capability];
  if (userSelectedId) {
    const userSelected = candidates.find((model) => model.id === userSelectedId);
    if (userSelected) return userSelected;
  }

  const preferredId = providerId === "surplus"
    ? SURPLUS_PREFERRED_DEFAULTS[capability]
    : (capability === "search" ? (selectedModels?.chat ?? DEFAULT_SETTINGS.chatModel) : PREFERRED_DEFAULTS[capability]);
  if (preferredId) {
    const preferred = candidates.find((model) => model.id === preferredId);
    if (preferred) return preferred;
  }
  if (capability === "reasoning") {
    const reasoning = candidates.find((model) => model.capabilities.includes("reasoning"));
    if (reasoning) return reasoning;
  }
  return candidates.find((model) => !model.beta) ?? candidates[0];
}

/**
 * Derive one capability route per available capability from the live catalog,
 * all pointed at the given provider. Skips capabilities with no model.
 */
export function deriveCapabilityRoutes(
  models: ProviderModel[],
  providerId: string = DEFAULT_PROVIDER_ID,
  selectedModels?: Partial<Record<Capability, string>>,
): Partial<Record<Capability, CapabilityRoute>> {
  const provider = requireProvider(providerId);
  const routes: Partial<Record<Capability, CapabilityRoute>> = {};
  for (const capability of provider.capabilities) {
    const primary = pickModel(models, capability, providerId, selectedModels);
    if (!primary) continue;
    const fallbacks = modelsForCapability(models, capability)
      .filter((model) => model.id !== primary.id)
      .slice(0, 2)
      .map((model) => ({ providerId, modelId: model.id }));
    const route: CapabilityRoute = {
      capability,
      providerId,
      modelId: primary.id,
      ...(fallbacks.length ? { fallbackRoutes: fallbacks } : {}),
    };
    assertAllowedCapabilityRoute(route);
    routes[capability] = route;
  }
  return routes;
}

/** A fresh default provider configuration with Venice as default (no routes until discovery runs). */
export function defaultProviderConfiguration(): ProviderConfiguration {
  return {
    defaultProviderId: DEFAULT_PROVIDER_ID,
    providers: {
      [DEFAULT_PROVIDER_ID]: { enabled: true, credentialRef: DEFAULT_PROVIDER_ID },
    },
    routes: {},
  };
}

export interface ResolvedRoute {
  capability: Capability;
  providerId: string;
  adapter: ProviderAdapter;
  baseUrl: string;
  modelId?: string;
}

/**
 * Resolve the runtime provider + base URL for a capability. The runtime reads
 * its base URL and model/provider from here so a capability-specific override
 * is a real code path, not just settings metadata.
 * Falls back to the default provider when unrouted.
 */
export function resolveCapabilityRoute(
  capability: Capability,
  config?: ProviderConfiguration,
  hasCredential?: (providerId: string) => boolean,
): ResolvedRoute {
  const route = config?.routes?.[capability];
  const preferredDefault = config?.defaultProviderId ?? DEFAULT_PROVIDER_ID;
  const providerId = route?.providerId ?? resolveDefaultProviderId(hasCredential, preferredDefault);
  const adapter = requireProvider(providerId);
  return { capability, providerId, adapter, baseUrl: adapter.baseUrl, modelId: route?.modelId };
}
