import readline from "node:readline";
import { deleteStoredCredential, resolveCredential } from "../lib/credential-store";
import { listProviders, requireProvider } from "../lib/providers/registry";
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
  const envVar = status.provider.id === "surplus" ? "SURPLUS_API_KEY" : "VENICE_API_KEY";
  const source = cred.source === "environment" ? `environment (${envVar})` : "local (~/.gondola/credentials.json)";
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
  console.log(theme.bold(`Provider: ${status.provider.name} ${theme.dim(`(${status.provider.id}) · capability layer`)}`));
  printCredential(status);
  console.log(`  State: ${status.state === "ready" ? theme.green(status.state) : theme.yellow(status.state)}`);
  if (status.verifiedAt) console.log(theme.dim(`  Verified: ${status.verifiedAt}`));
}

function printVerifyResult(status: SetupStatus): void {
  if (status.state === "ready") {
    console.log(theme.green(`✓ ${status.provider.name} verified — a live model check and a test message both succeeded.`));
    printCapabilities(status);
  } else {
    console.error(theme.red(`✗ ${status.message ?? "Setup is not ready."}`));
  }
}

function explainProvider(providerId: string): void {
  const provider = requireProvider(providerId);
  console.log(theme.bold(`\nConnect ${provider.name} to unlock Gondola capabilities.`));
  console.log(theme.dim(`One ${provider.name} API key gives Gondola access to its model catalog.`));
  console.log(theme.dim("Your key stays on this machine (~/.gondola/credentials.json, owner-only)."));
  console.log(theme.dim(`Create or manage a key: ${provider.keyManagementUrl}\n`));
}

/**
 * Interactive guided setup supporting Venice AI and Surplus Intelligence.
 */
async function guidedSetup(options: { reset?: boolean; providerId?: string } = {}): Promise<boolean> {
  let providerId = options.providerId ?? "venice";

  if (options.reset) {
    const confirm = (await promptLine(theme.yellow("Reset removes local credentials and verification. Continue? (y/N) "))).toLowerCase();
    if (confirm === "y" || confirm === "yes") {
      deleteStoredCredential("venice");
      deleteStoredCredential("surplus");
      clearSetupRecord();
      console.log(theme.dim("Local credentials and verification cleared."));
    }
  }

  if (!options.providerId) {
    console.log(theme.bold("\nSelect Inference Provider:"));
    console.log("  1) Venice AI (Privacy-first capability layer)");
    console.log("  2) Surplus Intelligence (GLM 5.2, DeepSeek v4, Grok 4.5)");
    const choice = await promptLine("Select [1]: ");
    if (choice === "2" || choice.toLowerCase() === "surplus") {
      providerId = "surplus";
    }
  }

  const resolved = resolveCredential(providerId);
  if (resolved) {
    const status = getSetupStatus(providerId);
    console.log(theme.dim(`Found a ${status.provider.name} key (${status.credential.source}${status.credential.maskedSuffix ? `, ${status.credential.maskedSuffix}` : ""}). Verifying…`));
    const verified = await verifySetup({ providerId });
    if (verified.state === "ready") { printVerifyResult(verified); return true; }
    console.error(theme.red(`✗ ${verified.message ?? "The configured key did not verify."}`));
    console.log(theme.dim("You can enter a different key below.\n"));
  } else {
    explainProvider(providerId);
  }

  const provider = requireProvider(providerId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const key = await promptHidden(theme.cyan(`Paste your ${provider.name} API key (hidden): `));
    if (!key) { console.error(theme.dim("No key entered.")); continue; }
    console.log(theme.dim(`Verifying with ${provider.name}…`));
    const verified = await verifySetup({ providerId, apiKey: key });
    if (verified.state === "ready") { printVerifyResult(verified); return true; }
    console.error(theme.red(`✗ ${verified.message ?? "That key did not verify."}`));
  }
  console.error(theme.red("Setup did not complete. Run `gondola setup` again when ready."));
  return false;
}

async function runDoctor(): Promise<number> {
  console.log(theme.bold("Gondola doctor\n"));
  let overallSuccess = true;
  for (const p of listProviders()) {
    const status = getSetupStatus(p.id);
    printStatusSummary(status);
    const resolved = resolveCredential(p.id);
    if (resolved) {
      console.log(theme.dim(`Running live checks for ${p.name} (catalog + test completion)…`));
      const verified = await verifySetup({ providerId: p.id });
      printVerifyResult(verified);
      if (verified.state !== "ready") overallSuccess = false;
    } else {
      console.log(theme.dim(`No credential configured for ${p.name}.\n`));
    }
  }
  return overallSuccess ? 0 : 1;
}

function runProvider(): number {
  for (const p of listProviders()) {
    const status = getSetupStatus(p.id);
    printStatusSummary(status);
    if (status.state === "ready") printCapabilities(status);
    console.log("");
  }
  return 0;
}

/** Entry point for `gondola setup|provider|doctor`. */
export async function runSetupCommand(sub: string, flags: string[]): Promise<number> {
  if (sub === "doctor") return runDoctor();
  if (sub === "provider") return runProvider();

  // setup
  const reset = flags.includes("--reset");
  const surplusFlag = flags.includes("--surplus");
  const providerId = surplusFlag ? "surplus" : undefined;

  if (process.stdin.isTTY) {
    return (await guidedSetup({ reset, providerId })) ? 0 : 1;
  }
  // Non-interactive setup: never prompt. Verify an existing credential or fail.
  const resolved = surplusFlag
    ? resolveCredential("surplus") ?? resolveCredential("venice")
    : resolveCredential("venice") ?? resolveCredential("surplus");
  if (!resolved) {
    console.error(theme.red("No provider credential configured."));
    console.error(theme.dim("Set SURPLUS_API_KEY or VENICE_API_KEY (see .env.example) or run `gondola setup` in an interactive terminal."));
    return 1;
  }
  const verified = await verifySetup({ providerId: resolved.providerId });
  printVerifyResult(verified);
  return verified.state === "ready" ? 0 : 1;
}

/**
 * Ensure setup is ready before starting the harness.
 */
export async function ensureSetupForRun(options: { interactive: boolean }): Promise<boolean> {
  if (isSetupReady()) return true;

  if (!options.interactive) {
    const resolved = resolveCredential("surplus") ?? resolveCredential("venice");
    console.error(theme.red("Gondola is not set up yet."));
    if (!resolved) {
      console.error(theme.dim("Set SURPLUS_API_KEY or VENICE_API_KEY (see .env.example) or run `gondola setup` in an interactive terminal."));
    } else {
      console.error(theme.dim("The configured provider key is not verified. Run `gondola setup` or `gondola doctor`."));
    }
    return false;
  }

  return guidedSetup({ reset: false });
}
