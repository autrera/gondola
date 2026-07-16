import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { clearApiTraces, listApiTraces } from "./api-trace";
import { SMART_FAST_CHAT_MODEL } from "./app-types";
import { resolveCredential } from "./credential-store";
import { getSetupStatus, isSetupReady, verifySetup } from "./setup-state";

const KEY = "sk-secret-abcd-1234";

function defaultCatalog() {
  return {
    data: [
      { id: SMART_FAST_CHAT_MODEL, type: "text", model_spec: { name: "GLM", capabilities: { supportsReasoning: true, supportsVision: true } } },
      { id: "z-image-turbo", type: "image", model_spec: { name: "Image" } },
      { id: "tts-xai-v1", type: "tts", model_spec: {} },
      { id: "stt-xai-v1", type: "stt", model_spec: {} },
      { id: "wan-2-7-text-to-video", type: "video", model_spec: {} },
      { id: "ace-step-15", type: "music", model_spec: {} },
      { id: "emb-1", type: "embedding", model_spec: {} },
    ],
  };
}

function mockVenice(opts: { catalog?: { status: number; body: unknown }; chat?: { status: number; body: unknown } } = {}) {
  const catalog = opts.catalog ?? { status: 200, body: defaultCatalog() };
  const chat = opts.chat ?? { status: 200, body: { choices: [{ message: { content: "" } }] } };
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.signal?.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
    const pick = String(url).includes("/chat/completions") ? chat : catalog;
    return new Response(JSON.stringify(pick.body), { status: pick.status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

function homeDir(): string {
  return process.env.GONDOLA_HOME as string;
}

let savedKey: string | undefined;
let originalFetch: typeof fetch;

beforeEach(() => {
  process.env.GONDOLA_HOME = mkdtempSync(path.join(os.tmpdir(), "gondola-setup-test-"));
  savedKey = process.env.VENICE_API_KEY;
  delete process.env.VENICE_API_KEY;
  originalFetch = globalThis.fetch;
  clearApiTraces();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (savedKey === undefined) delete process.env.VENICE_API_KEY;
  else process.env.VENICE_API_KEY = savedKey;
  delete process.env.GONDOLA_HOME;
});

test("missing credential yields not_configured", () => {
  assert.equal(getSetupStatus().state, "not_configured");
  assert.equal(isSetupReady(), false);
});

test("an invalid catalog does not save the credential and is not ready", async () => {
  mockVenice({ catalog: { status: 401, body: { error: "Unauthorized" } } });
  const result = await verifySetup({ apiKey: KEY });
  assert.equal(result.state, "invalid_credential");
  assert.equal(resolveCredential("venice"), null);
  assert.equal(existsSync(path.join(homeDir(), "credentials.json")), false);
  assert.equal(existsSync(path.join(homeDir(), "setup.json")), false);
});

test("a catalog success followed by a failed completion does not mark setup ready", async () => {
  mockVenice({ chat: { status: 500, body: { error: "boom" } } });
  const result = await verifySetup({ apiKey: KEY });
  assert.equal(result.state, "inference_failed");
  assert.equal(resolveCredential("venice"), null);
  assert.equal(getSetupStatus().state, "not_configured");
});

test("successful verification persists capability defaults and marks ready", async () => {
  mockVenice();
  const result = await verifySetup({ apiKey: KEY });
  assert.equal(result.state, "ready");
  assert.equal(result.defaultChatModel, SMART_FAST_CHAT_MODEL);
  assert.ok(result.capabilities?.chat && result.capabilities?.image && result.capabilities?.embedding);

  const record = JSON.parse(readFileSync(path.join(homeDir(), "setup.json"), "utf8"));
  assert.equal(record.defaultChatModel, SMART_FAST_CHAT_MODEL);
  assert.equal(record.capabilities.video, true);

  assert.equal(getSetupStatus().state, "ready");
  assert.equal(isSetupReady(), true);
  assert.equal(resolveCredential("venice")?.apiKey, KEY);
});

test("a configured installation reports ready (first-run onboarding is skipped)", async () => {
  mockVenice();
  await verifySetup({ apiKey: KEY });
  assert.equal(getSetupStatus().state, "ready");
});

test("re-running verification preserves the saved credential", async () => {
  mockVenice();
  await verifySetup({ apiKey: KEY });
  const before = readFileSync(path.join(homeDir(), "credentials.json"), "utf8");
  const again = await verifySetup({});
  assert.equal(again.state, "ready");
  const after = readFileSync(path.join(homeDir(), "credentials.json"), "utf8");
  assert.equal(before, after);
});

test("setup status and verify never return the raw credential", async () => {
  mockVenice();
  const verified = await verifySetup({ apiKey: KEY });
  const status = getSetupStatus();
  assert.ok(!JSON.stringify(verified).includes(KEY));
  assert.ok(!JSON.stringify(status).includes(KEY));
});

test("credentials never appear in API traces", async () => {
  clearApiTraces();
  mockVenice();
  await verifySetup({ apiKey: KEY });
  const traces = listApiTraces();
  assert.equal(traces.length, 0);
  assert.ok(!JSON.stringify(traces).includes(KEY));
});

test("verification cancellation aborts the upstream request", async () => {
  mockVenice();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    verifySetup({ apiKey: KEY, signal: controller.signal }),
    (error: Error) => error.name === "AbortError",
  );
});

test("non-interactive setup never prompts and reports not ready when unconfigured", async () => {
  const { ensureSetupForRun } = await import("../cli/setup");
  const ready = await ensureSetupForRun({ interactive: false });
  assert.equal(ready, false);
});
