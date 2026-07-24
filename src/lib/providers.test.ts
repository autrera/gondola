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
import { surplusAdapter } from "./providers/surplus-adapter";
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

const SURPLUS_CATALOG: ProviderModel[] = [
  { id: "glm-5.2", type: "chat", name: "glm-5.2", capabilities: ["chat", "reasoning"] },
  { id: "deepseek-v4-flash", type: "chat", name: "deepseek-v4-flash", capabilities: ["chat", "reasoning"] },
  { id: "grok-4.5", type: "chat", name: "grok-4.5", capabilities: ["chat", "vision", "reasoning"] },
  { id: "surplus-embed-v1", type: "embedding", name: "surplus-embed-v1", capabilities: ["embedding"] },
];

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("every V1 capability is available and routes to Venice or Surplus", () => {
  const available = detectAvailableCapabilities(CATALOG);
  for (const capability of ALL_CAPABILITIES) {
    assert.equal(available[capability], true, `expected ${capability} to be available`);
  }
  const routes = deriveCapabilityRoutes(CATALOG, DEFAULT_PROVIDER_ID);
  for (const capability of ALL_CAPABILITIES) {
    assert.ok(routes[capability], `expected a route for ${capability}`);
    assert.equal(routes[capability]?.providerId, "venice");
  }

  const surplusRoutes = deriveCapabilityRoutes(SURPLUS_CATALOG, "surplus");
  assert.equal(surplusRoutes.chat?.providerId, "surplus");
  assert.equal(surplusRoutes.chat?.modelId, "glm-5.2");
  assert.equal(surplusRoutes.vision?.modelId, "grok-4.5");
});

test("the registry rejects unsupported capability routes", () => {
  assert.doesNotThrow(() => assertAllowedCapabilityRoute({ capability: "chat", providerId: "venice", modelId: SMART_FAST_CHAT_MODEL }));
  assert.doesNotThrow(() => assertAllowedCapabilityRoute({ capability: "chat", providerId: "surplus", modelId: "glm-5.2" }));
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

test("the Surplus adapter exposes required properties and selects correct default models", async () => {
  assert.equal(surplusAdapter.id, "surplus");
  assert.equal(surplusAdapter.name, "Surplus Intelligence");
  assert.equal(surplusAdapter.envVar, "SURPLUS_API_KEY");
  assert.equal(surplusAdapter.baseUrl, "https://api.surplusintelligence.ai/v1");

  globalThis.fetch = (async () => new Response(JSON.stringify({
    data: [
      { id: "glm-5.2" },
      { id: "deepseek-v4-flash" },
      { id: "grok-4.5" },
    ],
  }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;

  const models = await surplusAdapter.listModels({ providerId: "surplus", apiKey: "sk-surplus-key", source: "file" });
  assert.equal(models.length, 3);

  const glm = models.find((m) => m.id === "glm-5.2");
  assert.ok(glm?.capabilities.includes("chat"));
  assert.ok(glm?.capabilities.includes("reasoning"));

  const grok = models.find((m) => m.id === "grok-4.5");
  assert.ok(grok?.capabilities.includes("vision"));

  assert.equal(surplusAdapter.selectDefaultChatModel(models), "glm-5.2");
});
