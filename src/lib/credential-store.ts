import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getProvider } from "./providers/registry";

// SERVER-ONLY. Never import this from client code. Credentials live outside the
// repository (default ~/.gondola) with owner-only permissions and are never
// returned to the browser — only a masked status view is exposed.
//
// Precedence: an explicit local OVERRIDE wins; otherwise the environment
// variable wins; otherwise the local file. This keeps `.env.local` and CI
// deployments authoritative by default while allowing a deliberate local
// override for the future multi-credential story.

export type CredentialSource = "environment" | "file" | "none";

export interface CredentialStatus {
  providerId: string;
  configured: boolean;
  source: CredentialSource;
  maskedSuffix: string | null;
  hasEnv: boolean;
  hasFile: boolean;
  /** True when an env credential is in use and no local override exists. */
  envReadOnly: boolean;
}

export interface ResolvedCredential {
  providerId: string;
  apiKey: string;
  source: "environment" | "file";
}

interface StoredEntry {
  apiKey: string;
  createdAt: string;
  /** When true this local entry overrides an env credential for the provider. */
  override?: boolean;
}

interface CredentialFile {
  version: 1;
  credentials: Record<string, StoredEntry>;
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function gondolaHomeDir(): string {
  const override = process.env.GONDOLA_HOME?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), ".gondola");
}

function credentialsPath(): string {
  return path.join(gondolaHomeDir(), "credentials.json");
}

function envVarFor(providerId: string): string | undefined {
  return getProvider(providerId)?.envVar;
}

function readEnvCredential(providerId: string): string | undefined {
  const envVar = envVarFor(providerId);
  if (!envVar) return undefined;
  const value = process.env[envVar]?.trim();
  return value ? value : undefined;
}

// mtime-guarded cache so the hot runtime path (getVeniceKey) does not re-read
// and re-parse the file on every request, while still picking up out-of-process
// writes (e.g. the CLI saving a key while the web app runs).
let fileCache: { path: string; mtimeMs: number; data: CredentialFile } | undefined;

function emptyFile(): CredentialFile {
  return { version: 1, credentials: {} };
}

function readCredentialFile(): CredentialFile {
  const filePath = credentialsPath();
  let mtimeMs: number;
  try {
    mtimeMs = statSync(filePath).mtimeMs;
  } catch {
    fileCache = undefined;
    return emptyFile();
  }
  if (fileCache && fileCache.path === filePath && fileCache.mtimeMs === mtimeMs) return fileCache.data;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<CredentialFile>;
    const data: CredentialFile = {
      version: 1,
      credentials: parsed && typeof parsed.credentials === "object" && parsed.credentials ? parsed.credentials : {},
    };
    fileCache = { path: filePath, mtimeMs, data };
    return data;
  } catch {
    return emptyFile();
  }
}

function writeCredentialFile(file: CredentialFile): void {
  const dir = gondolaHomeDir();
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try {
    chmodSync(dir, DIR_MODE);
  } catch {
    // Best effort on platforms without POSIX permissions.
  }
  const filePath = credentialsPath();
  writeFileSync(filePath, `${JSON.stringify(file, null, 2)}\n`, { mode: FILE_MODE });
  try {
    chmodSync(filePath, FILE_MODE);
  } catch {
    // Best effort.
  }
  try {
    fileCache = { path: filePath, mtimeMs: statSync(filePath).mtimeMs, data: file };
  } catch {
    fileCache = undefined;
  }
}

export function maskSuffix(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 4) return "••••";
  return `••••${trimmed.slice(-4)}`;
}

/**
 * Resolve the credential to use for a provider, or null if none is configured.
 * SERVER-ONLY. The returned key must never be sent to the browser.
 */
export function resolveCredential(providerId: string): ResolvedCredential | null {
  const fileEntry = readCredentialFile().credentials[providerId];
  if (fileEntry?.override && fileEntry.apiKey.trim()) {
    return { providerId, apiKey: fileEntry.apiKey.trim(), source: "file" };
  }
  const envKey = readEnvCredential(providerId);
  if (envKey) return { providerId, apiKey: envKey, source: "environment" };
  if (fileEntry?.apiKey.trim()) {
    return { providerId, apiKey: fileEntry.apiKey.trim(), source: "file" };
  }
  return null;
}

export function getCredentialStatus(providerId: string): CredentialStatus {
  const fileEntry = readCredentialFile().credentials[providerId];
  const hasFile = Boolean(fileEntry?.apiKey.trim());
  const hasEnv = Boolean(readEnvCredential(providerId));
  const resolved = resolveCredential(providerId);
  return {
    providerId,
    configured: Boolean(resolved),
    source: resolved?.source ?? "none",
    maskedSuffix: resolved ? maskSuffix(resolved.apiKey) : null,
    hasEnv,
    hasFile,
    envReadOnly: hasEnv && !(fileEntry?.override),
  };
}

/**
 * Save a local credential for a provider. `override` makes it win over an env
 * credential (an explicit user choice); otherwise env precedence is preserved.
 */
export function writeStoredCredential(
  providerId: string,
  apiKey: string,
  options: { override?: boolean } = {},
): void {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new Error("Cannot store an empty credential");
  const file = readCredentialFile();
  file.credentials[providerId] = {
    apiKey: trimmed,
    createdAt: new Date().toISOString(),
    ...(options.override ? { override: true } : {}),
  };
  writeCredentialFile(file);
}

/** Remove a local credential (falls back to the env credential if present). */
export function deleteStoredCredential(providerId: string): void {
  const file = readCredentialFile();
  if (!(providerId in file.credentials)) return;
  delete file.credentials[providerId];
  if (Object.keys(file.credentials).length === 0) {
    try {
      rmSync(credentialsPath());
    } catch {
      writeCredentialFile(file);
    }
    fileCache = undefined;
    return;
  }
  writeCredentialFile(file);
}
