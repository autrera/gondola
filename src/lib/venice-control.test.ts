import assert from "node:assert/strict";
import test from "node:test";
import { extractDocSection, isGuardedVeniceCall, normalizeVenicePath } from "./venice-control";

test("normalizeVenicePath adds a leading slash and strips the base prefix", () => {
  assert.equal(normalizeVenicePath("models"), "/models");
  assert.equal(normalizeVenicePath("/image/generate"), "/image/generate");
  assert.equal(normalizeVenicePath("/api/v1/models"), "/models");
  assert.equal(normalizeVenicePath("api/v1/chat/completions"), "/chat/completions");
});

test("normalizeVenicePath reduces a full URL to its path and query", () => {
  assert.equal(normalizeVenicePath("https://api.venice.ai/api/v1/models?type=image"), "/models?type=image");
});

test("isGuardedVeniceCall protects credential, payment, and delete operations", () => {
  assert.equal(isGuardedVeniceCall("DELETE", "/api_keys/abc"), true);
  assert.equal(isGuardedVeniceCall("POST", "/api_keys"), true);
  assert.equal(isGuardedVeniceCall("PUT", "/api_keys/abc"), true);
  assert.equal(isGuardedVeniceCall("POST", "/x402/top-up"), true);
  assert.equal(isGuardedVeniceCall("DELETE", "/anything"), true);

  assert.equal(isGuardedVeniceCall("GET", "/api_keys"), false);
  assert.equal(isGuardedVeniceCall("GET", "/billing/balance"), false);
  assert.equal(isGuardedVeniceCall("POST", "/image/generate"), false);
  assert.equal(isGuardedVeniceCall("POST", "/chat/completions"), false);
});

test("extractDocSection returns the section matching an endpoint topic", () => {
  const docs = [
    "# Generate Image",
    "Source: https://docs.venice.ai/api-reference/endpoint/image/generate",
    "POST /image/generate",
    "width, height, aspect_ratio, resolution, format, style_preset",
    "",
    "# Speech API",
    "Source: https://docs.venice.ai/api-reference/endpoint/audio/speech",
    "POST /audio/speech",
    "model, voice, input, response_format, speed",
  ].join("\n");

  const image = extractDocSection(docs, "image/generate");
  assert.ok(image.includes("POST /image/generate"));
  assert.ok(!image.includes("POST /audio/speech"));

  const speech = extractDocSection(docs, "audio/speech");
  assert.ok(speech.includes("POST /audio/speech"));

  assert.equal(extractDocSection(docs, "nonexistent-endpoint-xyz"), "");
});
