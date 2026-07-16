import readline from "node:readline";
import { deleteStoredCredential, resolveCredential } from "../lib/credential-store";
import { ALL_CAPABILITIES } from "../lib/providers/types";
import { clearSetupRecord, getSetupStatus, isSetupReady, verifySetup, type SetupStatus } from "../lib/setup-state";
import { theme } from "./theme";

const CAPABILITY_LABELS: Record<string, string> = {
  chat: "Conversation",
  reasoning: "Reasoning",
  vision: "Vision",
  search: "Search",
  transcription: "Transcription",
  speech: "Speech",
  image: "Images",
  video: "Video",
  music: "Music",
  embedding: "Embeddings",
};

function promptLine(query: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(query, (answer) => { rl.close(); resolve(answer.trim()); }));
}

// Reads a secret without echoing it to the terminal.
function promptHidden(query: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write(query);
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

function printCredential(status: SetupStatus): void {
  const cred = status.credential;
  if (!cred.configured) {
    console.log(`  Credential: ${theme.yellow("none configured")}`);
    return;
  }
  const source = cred.source === "environment" ? "environment (VENICE_API_KEY)" : "local (~/.gondola/credentials.json)";
  console.log(`  Credential: ${theme.green(cred.maskedSuffix ?? "configured")} ${theme.dim(`from ${source}`)}`);
}

function printCapabilities(status: SetupStatus): void {
  if (!status.capabilities) return;
  console.log(theme.bold("  Capabilities"));
  for (const capability of ALL_CAPABILITIES) {
    const ready = status.capabilities[capability];
    const mark = ready ? theme.green("●") : theme.dim("○");
    const model = status.routes?.[capability]?.modelId;
    const suffix = ready && model ? theme.dim(` → ${model}`) : ready ? "" : theme.dim(" (unavailable)");
    console.log(`    ${mark} ${CAPABILITY_LABELS[capability] ?? capability}${suffix}`);
  }
}

function printStatusSummary(status: SetupStatus): void {
  console.log(theme.bold(`Provider: ${status.provider.name} ${theme.dim(`(${status.provider.id}) · default capability layer`)}`));
  printCredential(status);
  console.log(`  State: ${status.state === "ready" ? theme.green(status.state) : theme.yellow(status.state)}`);
  if (status.verifiedAt) console.log(theme.dim(`  Verified: ${status.verifiedAt}`));
}

function printVerifyResult(status: SetupStatus): void {
  if (status.state === "ready") {
    console.log(theme.green("✓ Venice verified — a live model check and a test message both succeeded."));
    printCapabilities(status);
  } else {
    console.error(theme.red(`✗ ${status.message ?? "Setup is not ready."}`));
  }
}

function explainVenice(): void {
  console.log(theme.bold("\nConnect Venice to unlock the complete Gondola experience."));
  console.log(theme.dim("One Venice API key gives Gondola models for reasoning, vision, search, speech,"));
  console.log(theme.dim("transcription, images, video, music, and embeddings. Your key stays on this"));
  console.log(theme.dim("machine (~/.gondola/credentials.json, owner-only). You can override roles later."));
  console.log(theme.dim("Create or manage a key: https://venice.ai/settings/api\n"));
}

/**
 * Interactive guided setup. Detects and verifies an existing credential, or
 * prompts for one, and saves only after verification passes. Returns true when
 * setup is ready.
 */
async function guidedSetup(options: { reset?: boolean } = {}): Promise<boolean> {
  if (options.reset) {
    const confirm = (await promptLine(theme.yellow("Reset removes the local Venice credential and verification. Continue? (y/N) "))).toLowerCase();
    if (confirm === "y" || confirm === "yes") {
      deleteStoredCredential("venice");
      clearSetupRecord();
      console.log(theme.dim("Local credential and verification cleared."));
    }
  }

  const resolved = resolveCredential("venice");
  if (resolved) {
    const status = getSetupStatus();
    console.log(theme.dim(`Found a Venice key (${status.credential.source}${status.credential.maskedSuffix ? `, ${status.credential.maskedSuffix}` : ""}). Verifying…`));
    const verified = await verifySetup();
    if (verified.state === "ready") { printVerifyResult(verified); return true; }
    console.error(theme.red(`✗ ${verified.message ?? "The configured key did not verify."}`));
    console.log(theme.dim("You can enter a different key below.\n"));
  } else {
    explainVenice();
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const key = await promptHidden(theme.cyan("Paste your Venice API key (hidden): "));
    if (!key) { console.error(theme.dim("No key entered.")); continue; }
    console.log(theme.dim("Verifying with Venice…"));
    const verified = await verifySetup({ apiKey: key });
    if (verified.state === "ready") { printVerifyResult(verified); return true; }
    console.error(theme.red(`✗ ${verified.message ?? "That key did not verify."}`));
  }
  console.error(theme.red("Setup did not complete. Run `gondola setup` again when ready."));
  return false;
}

async function runDoctor(): Promise<number> {
  console.log(theme.bold("Gondola doctor\n"));
  printStatusSummary(getSetupStatus());
  const resolved = resolveCredential("venice");
  if (!resolved) {
    console.error(theme.yellow("\nNo credential configured. Run `gondola setup`."));
    return 1;
  }
  console.log(theme.dim("\nRunning live checks (catalog + test completion)…"));
  const verified = await verifySetup();
  printVerifyResult(verified);
  return verified.state === "ready" ? 0 : 1;
}

function runProvider(): number {
  const status = getSetupStatus();
  printStatusSummary(status);
  if (status.state === "ready") printCapabilities(status);
  else console.log(theme.yellow("\nRun `gondola setup` to verify and enable capabilities."));
  return 0;
}

/** Entry point for `gondola setup|provider|doctor`. */
export async function runSetupCommand(sub: string, flags: string[]): Promise<number> {
  if (sub === "doctor") return runDoctor();
  if (sub === "provider") return runProvider();

  // setup
  const reset = flags.includes("--reset");
  if (process.stdin.isTTY) {
    return (await guidedSetup({ reset })) ? 0 : 1;
  }
  // Non-interactive setup: never prompt. Verify an existing credential or fail.
  const resolved = resolveCredential("venice");
  if (!resolved) {
    console.error(theme.red("No Venice credential configured."));
    console.error(theme.dim("Set VENICE_API_KEY or run `gondola setup` in an interactive terminal."));
    return 1;
  }
  const verified = await verifySetup();
  printVerifyResult(verified);
  return verified.state === "ready" ? 0 : 1;
}

/**
 * Ensure setup is ready before starting the harness. Interactive sessions get
 * the guided flow; non-interactive runs never prompt and fail with a clear,
 * actionable message.
 */
export async function ensureSetupForRun(options: { interactive: boolean }): Promise<boolean> {
  if (isSetupReady()) return true;

  if (!options.interactive) {
    const resolved = resolveCredential("venice");
    console.error(theme.red("Gondola is not set up yet."));
    if (!resolved) {
      console.error(theme.dim("Set VENICE_API_KEY (see .env.example) or run `gondola setup` in an interactive terminal."));
    } else {
      console.error(theme.dim("The configured Venice key is not verified. Run `gondola setup` or `gondola doctor`."));
    }
    return false;
  }

  return guidedSetup({ reset: false });
}
