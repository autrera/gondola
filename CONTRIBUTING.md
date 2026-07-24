# Contributing to Gondola

Thanks for your interest in improving Gondola, a voice and vision AI companion and self-editing terminal harness powered by inference providers (Venice AI or Surplus Intelligence) and orchestrated by Pi Agent Core.

This guide covers how to set up the project, the checks to run before opening a pull request, and the conventions we follow.

## Ground rules

- **Venice is Gondola's default bundled full-capability provider; Surplus Intelligence is also bundled as an alternative.** All provider-aware code must resolve through the provider registry and capability routes (`src/lib/providers/`), never ad-hoc provider conditionals. Provider adapters must preserve Gondola's privacy, safety, permissions, cancellation, observability, and evaluation guarantees.
- **Keep it local-first and private.** User data (conversations, memory, transcripts, vectors, keys) stays on the user's machine under `.gondola/` and `.env.local`. Never send it anywhere else, and never commit it.
- **No secrets in the repo.** `.env.local`, `.gondola/`, and personal exports are git-ignored. Double-check `git status` before committing.

## Prerequisites

- Node.js 20 or newer (the code relies on `AbortSignal.any`, `AbortSignal.timeout`, and `structuredClone`).
- An inference API key (Venice AI or Surplus Intelligence).

## Local setup

```bash
git clone https://github.com/sabrinaaquino/gondola.git
cd gondola
npm install --ignore-scripts
cp .env.example .env.local   # then add your VENICE_API_KEY or SURPLUS_API_KEY
```

First run launches a guided setup that verifies your provider key and enables capabilities, so no manual `.env.local` is required. See [Setup and credentials](#setup-and-credentials).

Run the web companion:

```bash
npm run dev
```

Or with Docker:

```bash
docker build -t gondola .
docker run -p 3000:3000 --env-file .env.local gondola
```

Run the terminal harness:

```bash
npm run harness
```

## Setup and credentials

Gondola supports **Venice AI** (default) and **Surplus Intelligence** as bundled full-capability providers. Every V1 capability (conversation, reasoning, vision, search, transcription, speech, images, video, music, and embeddings) runs through the configured provider.

- **Consumer setup (recommended).** On first run Gondola shows a guided onboarding wizard (web) or `gondola setup` (terminal). It lets you select a provider, verifies your key against the live model catalog, runs a minimal real completion, derives capability defaults from the catalog, and only then marks setup ready. The key is saved locally with owner-only permissions.
- **Developer setup.** Export `VENICE_API_KEY` or `SURPLUS_API_KEY` or put it in `.env.local` to skip the wizard. `VENICE_ADMIN_KEY` (optional) is used only for billing and usage endpoints.
- **Credential precedence.** A deliberate local override wins; otherwise the environment variable wins; otherwise the local credential file. Removing the local credential falls back to the environment key when present.
- **Where things are stored.** Secrets live in `~/.gondola/credentials.json` (file `0600`, directory `0700`) or the environment, never in the browser, chat history, traces, assets, Lab records, or logs. Non-secret verification state (timestamp, masked suffix, capability defaults) lives in `~/.gondola/setup.json`; web UI preferences stay in browser `localStorage`; runtime app state stays under the project `.gondola/`.
- **Repair or reset.** Re-run `gondola setup`, `gondola doctor`, or Settings, Providers, Test connection to re-verify and refresh discovery without erasing anything. `gondola setup --reset` clears the local credential and verification after confirmation.
- **Capabilities and providers.** Every V1 capability requires a configured provider. Providers are resolved through the provider registry (`src/lib/providers/`) and capability routes.

## Before you open a pull request

Please make sure all of these pass:

```bash
npm run typecheck   # tsc --noEmit, must be clean
npm test            # node --test over src/lib/*.test.ts
```

If you changed UI, do a quick manual pass in `npm run dev`. If you touched the harness, sanity-check it with `npm run harness`.

## Project layout

| Path | What lives there |
| --- | --- |
| `src/app/` | Next.js web companion (UI, API routes, streaming) |
| `src/cli/` | Terminal harness (`main.ts`, REPL, coding and provider tools) |
| `src/lib/` | Shared core: inference client, memory, model/stream setup, skills, MCP, sub-agents, search, compaction |
| `src/components/` | React components for the web UI |
| `bin/nova.mjs` | Entry point for the `nova` command |
| `public/` | Static assets |

Conversations, agents, memory, skills, connections, automations, and generated media persist locally under `.gondola/` (git-ignored).

## Coding conventions

- **TypeScript, strict.** No `any` unless truly unavoidable; prefer precise types. Keep `npm run typecheck` clean.
- **React:** function components and hooks. Keep client state minimal and colocated.
- **Style:** match the surrounding code. Favor small, focused functions and clear names over cleverness. Avoid em dashes and ampersands in user-facing copy (spell out "and"), matching the existing voice.
- **Comments** explain intent and trade-offs, not the obvious. Do not narrate the code.
- **Safety:** file and shell tools are confined and gated behind confirmation for destructive actions. Preserve those guardrails. Never weaken the sandbox or auto-confirm destructive operations.
- **No debug cruft.** Remove temporary logging and instrumentation before submitting.

## Commits and pull requests

- Keep PRs small and focused on one change. Large, mixed PRs are hard to review.
- Write commit messages that explain the "why," not just the "what."
- Fill out the pull request template: summary, related issue, how you tested it, and the checklist.
- Link the issue your PR addresses (`Closes #123`).

## Reporting bugs and requesting features

Open an issue using the templates under **Issues**. For bugs, include steps to reproduce, what you expected, what happened, and your OS and Node version. For features, describe the problem you are trying to solve, not just the solution you have in mind.

## Security

Do not open a public issue for security problems. Instead, report them privately to the maintainer via a GitHub security advisory or direct message. Never include API keys or personal data in issues, PRs, or logs.

## Code of conduct

By participating you agree to uphold our [Code of Conduct](./CODE_OF_CONDUCT.md).
