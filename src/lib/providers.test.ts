import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { SMART_FAST_CHAT_MODEL } from "./app-types";
import {
  DEFAULT_PROVIDER_ID,
  assertAllowedCapabilityRoute,
  deriveCapabilityRoutes,
  detectAvailableCapabilities,
} from "./providers/registry";
import { ALL_CAPABILITIES, type Capability, type ProviderModel } from "./providers/types";
import { veniceAdapter } from "./providers/venice-adapter";

const CATALOG: ProviderModel[] = [
  { id: SMART_FAST_CHAT_MODEL, type: "text", name: "GLM", capabilities: ["chat", "reasoning", "vision"] },
  { id: "z-image-turbo", type: "image", name: "Image", capabilities: ["image"] },
  { id: "tts-xai-v1", type: "tts", name: "TTS", capabilities: ["speech"] },
  { id: "stt-xai-v1", type: "stt", name: "STT", capabilities: ["transcription"] },
  { id: "wan-2-7-text-to-video", type: "video", name: "Video", capabilities: ["video"] },
  { id: "ace-step-15", type: "music", name: "Music", capabilities: ["music"] },
  { id: "text-embed-1", type: "embedding", name: "Embed", capabilities: ["embedding"] },
];

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("every V1 capability is available and routes to Venice", () => {
  const available = detectAvailableCapabilities(CATALOG);
  for (const capability of ALL_CAPABILITIES) {
    assert.equal(available[capability], true, `expected ${capability} to be available`);
  }
  const routes = deriveCapabilityRoutes(CATALOG, DEFAULT_PROVIDER_ID);
  for (const capability of ALL_CAPABILITIES) {
    assert.ok(routes[capability], `expected a route for ${capability}`);
    assert.equal(routes[capability]?.providerId, "venice");
  }
});

test("the registry rejects unsupported capability routes", () => {
  assert.doesNotThrow(() => assertAllowedCapabilityRoute({ capability: "chat", providerId: "venice", modelId: SMART_FAST_CHAT_MODEL }));
  assert.throws(() => assertAllowedCapabilityRoute({ capability: "chat", providerId: "openai", modelId: "gpt-x" }), /Unknown provider/);
  assert.throws(() => assertAllowedCapabilityRoute({ capability: "telepathy" as unknown as Capability, providerId: "venice", modelId: "x" }), /Unknown capability/);
  assert.throws(() => assertAllowedCapabilityRoute({ capability: "chat", providerId: "venice", modelId: "" }), /missing a model/);
});

test("the Venice adapter derives capabilities and a default chat model from a live catalog", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({
    data: [
      { id: SMART_FAST_CHAT_MODEL, type: "text", model_spec: { name: "GLM", capabilities: { supportsReasoning: true, supportsVision: true } } },
      { id: "z-image-turbo", type: "image", model_spec: { name: "Image" } },
      { id: "tts-xai-v1", type: "tts", model_spec: { name: "TTS" } },
    ],
  }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;

  const models = await veniceAdapter.listModels({ providerId: "venice", apiKey: "k", source: "file" });
  const chat = models.find((model) => model.id === SMART_FAST_CHAT_MODEL);
  assert.ok(chat?.capabilities.includes("chat"));
  assert.ok(chat?.capabilities.includes("reasoning"));
  assert.ok(chat?.capabilities.includes("vision"));
  assert.ok(models.find((model) => model.id === "tts-xai-v1")?.capabilities.includes("speech"));
  assert.equal(veniceAdapter.selectDefaultChatModel(models), SMART_FAST_CHAT_MODEL);
});
