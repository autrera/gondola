import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// OS-level sandbox for `run_command`. This is the real isolation boundary for
// shell execution (the reference study's one true [B] adoption): in-process
// allowlists are heuristics, but the OS sandbox actually confines what a spawned
// command can touch.
//
// Backends:
//   - macOS  -> `sandbox-exec` (Seatbelt) with a generated profile.
//   - Linux  -> `bwrap` (Bubblewrap) with read-only root + writable workspace.
//   - other  -> none (fail-open with a note in "auto", or throw in "enforce").
//
// The default boundary (usable, not airgapped): filesystem writes are confined
// to the workspace + temp dirs, reads of known credential stores are denied, and
// the subprocess environment is scrubbed of secrets. Network is allowed by
// default so ordinary dev commands (npm/git) still work; it can be turned off for
// a stricter, offline profile.

export type SandboxMode = "auto" | "enforce" | "off";
export type SandboxBackend = "seatbelt" | "bwrap" | "none";

export interface SandboxOptions {
  /** Primary writable root (the agent's workspace). Always writable. */
  workspaceRoot: string;
  mode?: SandboxMode;
  allowNetwork?: boolean;
  /** Extra directories the command may write to (e.g. the cwd if outside root). */
  writableRoots?: string[];
}

export interface SandboxedCommand {
  file: string;
  args: string[];
  /** When true the caller should spawn with { shell: true } (unsandboxed path). */
  useShell: boolean;
  sandboxed: boolean;
  backend: SandboxBackend;
  /** Human-readable note when not sandboxed (surfaced to the agent/user). */
  note?: string;
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

/** Which OS sandbox is available on this host, if any. */
export async function detectSandboxBackend(): Promise<SandboxBackend> {
  if (process.platform === "darwin") {
    return (await fileExists("/usr/bin/sandbox-exec")) ? "seatbelt" : "none";
  }
  if (process.platform === "linux") {
    for (const candidate of ["/usr/bin/bwrap", "/usr/local/bin/bwrap", "/bin/bwrap"]) {
      if (await fileExists(candidate)) return "bwrap";
    }
    return "none";
  }
  return "none";
}

/** Credential locations that stay unreadable even though reads are broadly allowed. */
export function secretReadDenyPaths(home = os.homedir()): string[] {
  return [
    path.join(home, ".ssh"),
    path.join(home, ".aws"),
    path.join(home, ".gnupg"),
    path.join(home, ".config", "gcloud"),
    path.join(home, ".gondola", "credentials.json"),
    path.join(home, ".nova", "credentials.json"),
    path.join(home, ".netrc"),
  ];
}

/** Generate a Seatbelt (macOS) profile: deny-by-default, workspace-confined writes. */
export function buildSeatbeltProfile(options: { writableRoots: string[]; allowNetwork: boolean; home?: string }): string {
  const writable = [...new Set(options.writableRoots.map((root) => path.resolve(root)))]
    .map((root) => `  (subpath ${JSON.stringify(root)})`)
    .join("\n");
  const secretDenies = secretReadDenyPaths(options.home)
    .map((secret) => `(deny file-read* (subpath ${JSON.stringify(secret)}))`)
    .join("\n");
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    "(allow process-exec)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow signal (target self))",
    // Reads are broadly allowed so tools can load libraries/config...
    "(allow file-read*)",
    // ...but writes are confined to the workspace + temp only.
    "(allow file-write*",
    writable,
    "  (subpath \"/private/tmp\")",
    "  (subpath \"/private/var/folders\")",
    "  (subpath \"/tmp\")",
    "  (literal \"/dev/null\") (literal \"/dev/stdout\") (literal \"/dev/stderr\")",
    "  (literal \"/dev/tty\") (literal \"/dev/urandom\") (literal \"/dev/random\") (subpath \"/dev/fd\"))",
    // ...and known credential stores are never readable (last-match-wins).
    secretDenies,
    options.allowNetwork ? "(allow network*)" : "(deny network*)",
  ].join("\n");
}

/** Build the argv that runs `command` under the available OS sandbox. */
export async function wrapCommandForSandbox(command: string, options: SandboxOptions): Promise<SandboxedCommand> {
  const mode = options.mode ?? "auto";
  if (mode === "off") {
    return { file: command, args: [], useShell: true, sandboxed: false, backend: "none", note: "Sandbox disabled by configuration." };
  }
  const backend = await detectSandboxBackend();
  if (backend === "none") {
    if (mode === "enforce") {
      throw new Error("No OS sandbox (sandbox-exec/bwrap) is available and sandbox mode is 'enforce'; refusing to run the command.");
    }
    return {
      file: command,
      args: [],
      useShell: true,
      sandboxed: false,
      backend: "none",
      note: "Ran WITHOUT an OS sandbox: no sandbox backend is available on this platform.",
    };
  }

  const writableRoots = [options.workspaceRoot, ...(options.writableRoots ?? [])];
  const allowNetwork = options.allowNetwork ?? true;

  if (backend === "seatbelt") {
    const profile = buildSeatbeltProfile({ writableRoots, allowNetwork });
    return { file: "/usr/bin/sandbox-exec", args: ["-p", profile, "/bin/sh", "-c", command], useShell: false, sandboxed: true, backend };
  }

  // bwrap: read-only root, writable workspace + tmp, optional network namespace.
  const bindWritable = [...new Set(writableRoots.map((root) => path.resolve(root)))]
    .flatMap((root) => ["--bind", root, root]);
  const args = [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    ...bindWritable,
    ...(allowNetwork ? [] : ["--unshare-net"]),
    "--die-with-parent",
    "/bin/sh", "-c", command,
  ];
  return { file: "bwrap", args, useShell: false, sandboxed: true, backend };
}

const SECRET_ENV_PATTERN = /(?:API[_-]?KEY|APIKEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE[_-]?KEY|CREDENTIALS?|SESSION[_-]?KEY|ACCESS[_-]?KEY)/i;
// Never strip these even if they somehow match (they are not secrets).
const ENV_KEEP = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TERM", "PWD"]);

/** A copy of the environment with secret-looking variables removed, so a spawned
 *  command can never read the agent's API keys or other credentials from env. */
export function sanitizedEnv(base: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (!ENV_KEEP.has(key) && SECRET_ENV_PATTERN.test(key)) continue;
    out[key] = value;
  }
  return out;
}
