import { loadEnv } from "./env";
import { createHarness } from "./harness";
import { HarnessRenderer } from "./render";
import { runOneShot, startInteractive } from "./repl";
import { ensureSetupForRun, runSetupCommand } from "./setup";
import { theme } from "./theme";

loadEnv();

const SETUP_COMMANDS = new Set(["setup", "provider", "doctor"]);

// Don't crash if the reader (e.g. `| head`) closes the pipe early.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
});

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Guided setup / diagnostics: `gondola setup|provider|doctor` (nova aliases work too).
  if (args.length > 0 && SETUP_COMMANDS.has(args[0])) {
    process.exit(await runSetupCommand(args[0], args.slice(1)));
  }

  const argvPrompt = args.join(" ").trim();
  // Interactive only when attached to a TTY with no one-shot prompt to run.
  const interactive = !argvPrompt && process.stdin.isTTY;

  // First-run gate. Interactive sessions get the guided flow; non-interactive
  // runs never prompt and fail with a clear, actionable message + nonzero exit.
  if (!(await ensureSetupForRun({ interactive }))) {
    process.exit(1);
  }

  const harness = await createHarness();
  const renderer = new HarnessRenderer(harness.agent);

  // Dispatch: `nova "prompt"` (argv) and piped stdin run one-shot and exit;
  // an attached TTY starts the interactive loop.
  if (argvPrompt) {
    process.exit(await runOneShot(harness, renderer, argvPrompt));
  }

  if (!process.stdin.isTTY) {
    const piped = await readStdin();
    if (piped) {
      process.exit(await runOneShot(harness, renderer, piped));
    }
    console.error(theme.dim("No input. Pass a prompt as an argument, pipe one in, or run in an interactive terminal."));
    process.exit(1);
  }

  await startInteractive(harness, renderer);
}

main().catch((error) => {
  console.error(theme.red(error instanceof Error ? error.stack ?? error.message : String(error)));
  process.exit(1);
});
