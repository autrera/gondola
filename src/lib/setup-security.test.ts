import assert from "node:assert/strict";
import { test } from "node:test";
import { rejectUntrustedLocalRequest } from "./request-security";
import { rateLimit, readLimitedJson, resetRateLimit } from "./setup-api";

// The setup routes all call rejectUntrustedLocalRequest first, so exercising it
// with the same request shapes proves the routes reject untrusted origins.

test("setup routes reject cross-site requests", () => {
  const request = new Request("http://localhost:3000/api/setup/verify", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
  });
  const rejected = rejectUntrustedLocalRequest(request, "json");
  assert.ok(rejected);
  assert.equal(rejected?.status, 403);
});

test("setup routes reject a foreign origin", () => {
  const request = new Request("http://localhost:3000/api/setup/status", {
    headers: { origin: "https://evil.example.com" },
  });
  const rejected = rejectUntrustedLocalRequest(request);
  assert.ok(rejected);
  assert.equal(rejected?.status, 403);
});

test("setup routes allow a loopback request", () => {
  const request = new Request("http://localhost:3000/api/setup/verify", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
  });
  assert.equal(rejectUntrustedLocalRequest(request, "json"), undefined);
});

test("setup body reader enforces a strict size limit", async () => {
  const request = new Request("http://localhost:3000/api/setup/credentials", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "x".repeat(20 * 1024) }),
  });
  const result = await readLimitedJson(request);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.response.status, 413);
});

test("verification attempts are rate limited", () => {
  resetRateLimit("test:verify");
  let allowed = 0;
  for (let i = 0; i < 10; i += 1) {
    if (rateLimit("test:verify", 6, 60_000)) allowed += 1;
  }
  assert.equal(allowed, 6);
});
