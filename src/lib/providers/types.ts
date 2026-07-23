// Provider foundation (Phase 1).
//
// Gondola V1 ships Venice as the only bundled full-capability provider, but all
// provider-aware code resolves through this registry + capability routes so that
// future providers can override individual capabilities WITHOUT scattering
// provider conditionals across the app. Do not branch on `providerId` outside
// the registry — add an adapter and a route instead.

export type Capability =
  | "chat"
  | "reasoning"
  | "vision"
  | "search"
  | "transcription"
  | "speech"
  | "image"
  | "video"
  | "music"
  | "embedding";

export const ALL_CAPABILITIES: Capability[] = [
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

/**
 * A resolved credential handed to an adapter. The raw `apiKey` never leaves the
 * server and is only read from the credential store at the moment of use.
 */
export interface ProviderCredential {
  providerId: string;
  apiKey: string;
  /** Where the key was resolved from, for status reporting only. */
  source: "environment" | "file";
}

/** Coarse, sanitized failure reason shared by validation, probes, and errors. */
export type ProviderErrorReason = "invalid_credential" | "no_credits" | "unreachable" | "unknown";

/**
 * A typed error thrown by adapters so callers can distinguish an outage / DNS
 * failure ("unreachable") from a rejected key ("invalid_credential"), instead of
 * defaulting every connection failure to "Venice rejected this key".
 */
export class ProviderError extends Error {
  reason: ProviderErrorReason;
  status?: number;
  constructor(message: string, reason: ProviderErrorReason, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.reason = reason;
    this.status = status;
  }
}

export interface CredentialValidation {
  ok: boolean;
  /** Coarse reason so callers can map to a SetupState without leaking upstream detail. */
  reason?: ProviderErrorReason;
  /** Human-readable, already sanitized (safe to show a local user). */
  message?: string;
  /** HTTP status from the upstream catalog request, when available. */
  status?: number;
}

export interface ProviderModel {
  id: string;
  type: string;
  name: string;
  capabilities: Capability[];
  beta?: boolean;
  privacy?: string;
  voices?: string[];
  defaultVoice?: string;
  raw?: Record<string, unknown>;
}

export interface InferenceProbeResult {
  ok: boolean;
  model: string;
  /** Round-trip latency of the probe request in milliseconds. */
  latencyMs?: number;
  reason?: "invalid_credential" | "no_credits" | "unreachable" | "unsupported_model" | "unknown";
  message?: string;
  status?: number;
}

export interface ProviderAdapter {
  id: string;
  name: string;
  capabilities: Capability[];
  /** Env var that carries this provider's key (for env precedence + docs). */
  envVar: string;
  /** URL where a user creates/manages an API key (shown in onboarding). */
  keyManagementUrl: string;
  /** Base URL for this provider's OpenAI-compatible API. The runtime resolves
   *  the URL from here (via resolveCapabilityRoute) instead of hardcoding it. */
  baseUrl: string;
  validateCredential(credential: ProviderCredential, signal?: AbortSignal): Promise<CredentialValidation>;
  listModels(credential: ProviderCredential, signal?: AbortSignal): Promise<ProviderModel[]>;
  runInferenceProbe(
    credential: ProviderCredential,
    model: string,
    signal?: AbortSignal,
  ): Promise<InferenceProbeResult>;
  /** Pick a sane default conversation model from the live catalog. */
  selectDefaultChatModel(models: ProviderModel[]): string | undefined;
}

export interface CapabilityRoute {
  capability: Capability;
  providerId: string;
  modelId: string;
  fallbackRoutes?: Array<{
    providerId: string;
    modelId: string;
  }>;
}

/**
 * The persisted, versioned shape of provider configuration. V1 only writes
 * Venice routes, but the shape is future-proof for capability-specific
 * overrides. `credentialRef` points at a credential-store entry rather than
 * embedding a secret.
 */
export interface ProviderConfiguration {
  defaultProviderId: string;
  providers: Record<string, {
    enabled: boolean;
    credentialRef?: string;
  }>;
  routes: Partial<Record<Capability, CapabilityRoute>>;
}
