import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  fingerprintKey,
  getCredentialStatus,
  gondolaHomeDir,
  maskSuffix,
  resolveCredential,
  writeStoredCredential,
  type CredentialStatus,
} from "./credential-store";
import {
  DEFAULT_PROVIDER_ID,
  deriveCapabilityRoutes,
  detectAvailableCapabilities,
  getProvider,
  requireProvider,
  resolveDefaultProviderId,
} from "./providers/registry";
import { ProviderError } from "./providers/types";
import type { Capability, CapabilityRoute, ProviderErrorReason, ProviderModel } from "./providers/types";

// ...

const CATALOG_FAILURE_MESSAGES: Record<ProviderErrorReason, string> = {
  invalid_credential: "The provider rejected this key. Check that you copied the correct API key.",
  no_credits: "This key has no available credits. Add credits, then verify again.",
  unreachable: "Gondola could not reach the provider. Check your connection and try again.",
  unknown: "The provider could not verify this key right now. Try again in a moment.",
};

interface SetupRecord {
  version: 1;
  providerId: string;
  verifiedAt: string;
  verifiedSuffix: string;
  verifiedFingerprint: string;
  defaultChatModel: string;
  capabilities: Record<Capability, boolean>;
  routes: Partial<Record<Capability, CapabilityRoute>>;
}

export type SetupState =
  | "not_configured"
  | "credential_detected"
  | "verifying"
  | "invalid_credential"
  | "inference_failed"
  | "unreachable"
  | "ready"
  | "repair_required";

export interface SetupStatus {
  state: SetupState;
  providerId: string;
  provider: { id: string; name: string; keyManagementUrl: string };
  credential: CredentialStatus;
  verifiedAt?: string;
  defaultChatModel?: string;
  capabilities?: Record<Capability, boolean>;
  routes?: Partial<Record<Capability, CapabilityRoute>>;
  /** Sanitized, user-facing guidance. Never contains a credential. */
  message?: string;
  reason?: string;
  latencyMs?: number;
}

function setupPath(): string {
  return path.join(gondolaHomeDir(), "setup.json");
}

function readSetupRecord(): SetupRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(setupPath(), "utf8")) as Partial<SetupRecord>;
    if (!parsed || typeof parsed.verifiedAt !== "string" || typeof parsed.verifiedSuffix !== "string") {
      return undefined;
    }
    return parsed as SetupRecord;
  } catch {
    return undefined;
  }
}

function writeSetupRecord(record: SetupRecord): void {
  mkdirSync(gondolaHomeDir(), { recursive: true, mode: 0o700 });
  writeFileSync(setupPath(), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

export function clearSetupRecord(): void {
  try {
    rmSync(setupPath());
  } catch {
    // Nothing persisted yet.
  }
}

function providerInfo(providerId: string) {
  const provider = requireProvider(providerId);
  return { id: provider.id, name: provider.name, keyManagementUrl: provider.keyManagementUrl };
}

/**
 * Resolve the active provider ID using this precedence:
 * 1. Explicitly passed providerId, if given.
 * 2. The provider recorded in setup.json, when the provider is registered and has a resolvable credential.
 * 3. Dynamic credential check via resolveDefaultProviderId (prefers Venice, then any provider with a credential).
 *
 * This ensures that once a user verifies a non-default provider (e.g. Surplus),
 * subsequent unparameterized calls to getSetupStatus / isSetupReady / verifySetup
 * resolve to that provider rather than always defaulting to Venice.
 */
export function resolveActiveProviderId(providerId?: string): string {
  if (providerId) return providerId;
  const record = readSetupRecord();
  if (record?.providerId && getProvider(record.providerId) && resolveCredential(record.providerId)) {
    return record.providerId;
  }
  return resolveDefaultProviderId();
}

/**
 * Steady-state setup status derived from the persisted verification + the
 * currently resolved credential. Does not perform network calls.
 */
export function getSetupStatus(providerId?: string): SetupStatus {
  const activeProviderId = resolveActiveProviderId(providerId);
  const credential = getCredentialStatus(activeProviderId);
  const provider = providerInfo(activeProviderId);
  const base: SetupStatus = { state: "not_configured", providerId: activeProviderId, provider, credential };

  const resolved = resolveCredential(activeProviderId);
  if (!resolved) return base;

  const record = readSetupRecord();
  if (!record || record.providerId !== activeProviderId) {
    return { ...base, state: "credential_detected" };
  }
  // Compare a non-reversible fingerprint of the full key, not the display suffix:
  // two different keys can share the same last four characters.
  if (!record.verifiedFingerprint || record.verifiedFingerprint !== fingerprintKey(resolved.apiKey)) {
    return {
      ...base,
      state: "repair_required",
      message: "The active credential changed since it was last verified. Re-verify to continue.",
    };
  }

  const capabilities = { ...record.capabilities };
  const adapterCapabilities = requireProvider(activeProviderId).capabilities;
  if (record.routes) {
    for (const [cap, route] of Object.entries(record.routes)) {
      if (route?.modelId && adapterCapabilities.includes(cap as Capability)) {
        capabilities[cap as Capability] = true;
      }
    }
  }

  return {
    ...base,
    state: "ready",
    verifiedAt: record.verifiedAt,
    defaultChatModel: record.defaultChatModel,
    capabilities,
    routes: record.routes,
  };
}

export function saveCapabilityRoutes(
  newRoutes: Partial<Record<Capability, CapabilityRoute>>,
  providerId?: string,
): SetupStatus {
  const activeProviderId = resolveActiveProviderId(providerId);
  const record = readSetupRecord();
  if (record && record.providerId === activeProviderId) {
    const mergedRoutes = { ...record.routes, ...newRoutes };
    const mergedCapabilities = { ...record.capabilities };
    for (const [cap, route] of Object.entries(mergedRoutes)) {
      if (route?.modelId) {
        mergedCapabilities[cap as Capability] = true;
      }
    }
    const defaultChatModel = mergedRoutes.chat?.modelId ?? record.defaultChatModel;
    writeSetupRecord({
      ...record,
      defaultChatModel,
      routes: mergedRoutes,
      capabilities: mergedCapabilities,
    });
  }
  return getSetupStatus(activeProviderId);
}

export function isSetupReady(providerId?: string): boolean {
  return getSetupStatus(providerId).state === "ready";
}

export interface VerifyOptions {
  providerId?: string;
  /** A candidate key to verify and (on full success) persist. */
  apiKey?: string;
  /** When persisting a candidate key, make it override an env credential. */
  override?: boolean;
  selectedModels?: Partial<Record<Capability, string>>;
  signal?: AbortSignal;
}

/**
 * Verify a credential end-to-end and, on full success, persist the verification
 * (and the candidate key when one was supplied). This is the ONLY path that can
 * move setup to "ready". Nothing is persisted unless every check passes.
 */
export async function verifySetup(options: VerifyOptions = {}): Promise<SetupStatus> {
  const providerId = options.providerId ?? resolveActiveProviderId();
  const provider = requireProvider(providerId);
  const info = providerInfo(providerId);

  const candidateKey = options.apiKey?.trim();
  const resolved = candidateKey
    ? { providerId, apiKey: candidateKey, source: "file" as const }
    : resolveCredential(providerId);

  if (!resolved) {
    return {
      state: "not_configured",
      providerId,
      provider: info,
      credential: getCredentialStatus(providerId),
      message: "No credential is configured yet.",
    };
  }

  // 1. Live catalog must accept the credential.
  let models: ProviderModel[];
  try {
    models = await provider.listModels(resolved, options.signal);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    // Preserve the adapter's typed reason so an outage isn't reported as a bad key.
    const reason: ProviderErrorReason = error instanceof ProviderError ? error.reason : "unknown";
    return {
      state: reason === "unreachable" ? "unreachable" : "invalid_credential",
      providerId,
      provider: info,
      credential: getCredentialStatus(providerId),
      reason,
      message: (error instanceof ProviderError ? error.message : undefined) ?? CATALOG_FAILURE_MESSAGES[reason],
    };
  }

  // 2. A valid default conversation model must exist.
  const defaultChatModel = provider.selectDefaultChatModel(models);
  if (!defaultChatModel) {
    return {
      state: "inference_failed",
      providerId,
      provider: info,
      credential: getCredentialStatus(providerId),
      reason: "no_chat_model",
      message: "No conversation model is available on this account.",
    };
  }

  // 3. A minimal real completion must succeed.
  const probe = await provider.runInferenceProbe(resolved, defaultChatModel, options.signal);
  if (!probe.ok) {
    return {
      state: "inference_failed",
      providerId,
      provider: info,
      credential: getCredentialStatus(providerId),
      reason: probe.reason,
      message: probe.message ?? `A test message to ${info.name} did not succeed.`,
    };
  }

  // 4. Derive capability defaults from the live catalog. Only now persist.
  const capabilities = detectAvailableCapabilities(models);
  const routes = deriveCapabilityRoutes(models, providerId, options.selectedModels);

  if (candidateKey) {
    writeStoredCredential(providerId, candidateKey, { override: options.override });
  }
  writeSetupRecord({
    version: 1,
    providerId,
    verifiedAt: new Date().toISOString(),
    verifiedSuffix: maskSuffix(resolved.apiKey),
    verifiedFingerprint: fingerprintKey(resolved.apiKey),
    defaultChatModel,
    capabilities,
    routes,
  });

  return {
    state: "ready",
    providerId,
    provider: info,
    credential: getCredentialStatus(providerId),
    verifiedAt: new Date().toISOString(),
    defaultChatModel,
    capabilities,
    routes,
    latencyMs: probe.latencyMs,
  };
}
