import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { SMART_FAST_CHAT_MODEL } from "./app-types";
import {
  DEFAULT_PROVIDER_ID,
  assertAllowedCapabilityRoute,
  deriveCapabilityRoutes,
  detectAvailableCapabilities,
  resolveDefaultProviderId,
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
  { id: "glm-5.2", type: "text", name: "GLM 5.2", capabilities: ["chat", "reasoning"] },
  { id: "deepseek-v4-flash", type: "text", name: "DeepSeek V4 Flash", capabilities: ["chat", "reasoning"] },
  { id: "grok-4.5", type: "text", name: "Grok 4.5", capabilities: ["chat", "vision", "reasoning"] },
  { id: "surplus-embed-v1", type: "embedding", name: "Surplus Embeddings 1", capabilities: ["embedding"] },
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
      { id: "glm-5.2", name: "GLM 5.2", supported_features: ["streaming", "reasoning"] },
      { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", supported_features: ["streaming", "reasoning"] },
      { id: "grok-4.5", name: "Grok 4.5", supported_features: ["streaming", "tools", "vision", "reasoning"] },
    ],
  }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;

  const models = await surplusAdapter.listModels({ providerId: "surplus", apiKey: "sk-surplus-key", source: "file" });
  assert.equal(models.length, 3);

  const glm = models.find((m) => m.id === "glm-5.2");
  assert.equal(glm?.name, "GLM 5.2");
  assert.equal(glm?.type, "text");
  assert.ok(glm?.capabilities.includes("chat"));
  assert.ok(glm?.capabilities.includes("reasoning"));

  const grok = models.find((m) => m.id === "grok-4.5");
  assert.equal(grok?.name, "Grok 4.5");
  assert.ok(grok?.capabilities.includes("vision"));

  // Verify the raw response is stored
  assert.ok(glm?.raw);
  assert.equal((glm?.raw as Record<string, unknown>)?.name, "GLM 5.2");

  assert.equal(surplusAdapter.selectDefaultChatModel(models), "glm-5.2");
});

test("surplus adapter maps embedding models and edge cases correctly", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({
    data: [
      // Embedding by id pattern (id contains "embed")
      { id: "text-embed-3", name: "Text Embedding 3", supported_features: ["embedding"] },
      // Embedding via feature name (no "embed" in id)
      { id: "some-other-model", name: "Vector Model", supported_features: ["embedding"] },
      // Text model with zero features (no supported_features at all)
      { id: "minimal-model", name: "Minimal Model" },
      // Text model with empty features array
      { id: "empty-features", name: "Empty Features", supported_features: [] },
      // Model with "grok" in id but no vision/reasoning features - old heuristic must NOT apply
      { id: "grok-classic", name: "Grok Classic", supported_features: ["streaming"] },
      // Model with "glm" in id but no reasoning feature - old heuristic must NOT apply
      { id: "glm-base", name: "GLM Base", supported_features: ["streaming"] },
      // Model with streaming/tools only - those should NOT become capabilities
      { id: "tools-only", name: "Tools Only", supported_features: ["streaming", "tools"] },
    ],
  }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;

  const models = await surplusAdapter.listModels({ providerId: "surplus", apiKey: "sk-surplus-key", source: "file" });
  assert.equal(models.length, 7);

  // Embedding by id pattern
  const embed3 = models.find((m) => m.id === "text-embed-3");
  assert.ok(embed3, "text-embed-3 should exist");
  assert.equal(embed3?.type, "embedding");
  assert.equal(embed3?.name, "Text Embedding 3");
  assert.deepEqual(embed3?.capabilities, ["embedding"]);

  // Embedding via supported_features (id does NOT contain "embed")
  const vector = models.find((m) => m.id === "some-other-model");
  assert.ok(vector, "some-other-model should exist");
  assert.equal(vector?.type, "embedding");
  assert.equal(vector?.name, "Vector Model");
  assert.deepEqual(vector?.capabilities, ["embedding"]);

  // Minimal model with no supported_features at all
  const minimal = models.find((m) => m.id === "minimal-model");
  assert.ok(minimal, "minimal-model should exist");
  assert.equal(minimal?.type, "text");
  assert.equal(minimal?.name, "Minimal Model");
  assert.deepEqual(minimal?.capabilities, ["chat"]);

  // Model with empty features array
  const empty = models.find((m) => m.id === "empty-features");
  assert.ok(empty, "empty-features should exist");
  assert.equal(empty?.type, "text");
  assert.deepEqual(empty?.capabilities, ["chat"]);

  // "grok" in id but only streaming feature - must NOT get vision/reasoning from old heuristics
  const grokClassic = models.find((m) => m.id === "grok-classic");
  assert.ok(grokClassic, "grok-classic should exist");
  assert.equal(grokClassic?.type, "text");
  assert.deepEqual(grokClassic?.capabilities, ["chat"], "grok with only streaming should NOT get vision/reasoning");

  // "glm" in id but no reasoning feature - must NOT get reasoning from old heuristics
  const glmBase = models.find((m) => m.id === "glm-base");
  assert.ok(glmBase, "glm-base should exist");
  assert.equal(glmBase?.type, "text");
  assert.deepEqual(glmBase?.capabilities, ["chat"], "glm with only streaming should NOT get reasoning");

  // streaming, tools features should NOT become capabilities
  const toolsOnly = models.find((m) => m.id === "tools-only");
  assert.ok(toolsOnly, "tools-only should exist");
  assert.equal(toolsOnly?.type, "text");
  assert.deepEqual(toolsOnly?.capabilities, ["chat"], "streaming/tools features must NOT map to capabilities");

  // Verify raw is stored for all models
  for (const model of models) {
    assert.ok(model.raw, `raw should exist for ${model.id}`);
    assert.equal((model.raw as Record<string, unknown>)?.id, model.id);
    assert.equal((model.raw as Record<string, unknown>)?.name, model.name);
  }
});

test("resolveDefaultProviderId dynamically inspects configured credentials", () => {
  assert.equal(resolveDefaultProviderId((id) => id === "venice"), "venice");
  assert.equal(resolveDefaultProviderId((id) => id === "surplus"), "surplus");
  assert.equal(resolveDefaultProviderId((id) => id === "surplus", "venice"), "surplus");
  assert.equal(resolveDefaultProviderId(() => false, "venice"), "venice");
});
