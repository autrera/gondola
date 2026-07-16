import assert from "node:assert/strict";
import test from "node:test";
import { diagnoseFailure, explanationFor } from "./supervisor";

test("diagnoseFailure classifies each common failure signature", () => {
  assert.equal(diagnoseFailure("Request timed out after 120000ms").category, "timeout");
  assert.equal(diagnoseFailure(new Error("The stream was aborted")).category, "timeout");
  assert.equal(diagnoseFailure("429 Too Many Requests").category, "rate_limit");
  assert.equal(diagnoseFailure("401 Unauthorized: invalid api key").category, "auth");
  assert.equal(diagnoseFailure("400 Bad Request: maximum context length exceeded").category, "bad_request");
  assert.equal(diagnoseFailure("503 Service Unavailable").category, "server");
  assert.equal(diagnoseFailure("Venice model glm returned an empty reply.").category, "empty");
  assert.equal(diagnoseFailure("fetch failed: ECONNRESET").category, "network");
  assert.equal(diagnoseFailure("something inexplicable happened").category, "generic");
});

test("diagnoseFailure always returns a non-empty reason and suggestion", () => {
  for (const input of ["timed out", "429", "nonsense", "", null, undefined]) {
    const diagnosis = diagnoseFailure(input);
    assert.ok(diagnosis.reason.length > 0, `reason for ${JSON.stringify(input)}`);
    assert.ok(diagnosis.suggestion.length > 0, `suggestion for ${JSON.stringify(input)}`);
  }
});

test("explanationFor mentions the fallback attempt only when a retry happened", () => {
  const diagnosis = diagnoseFailure("timed out");
  assert.ok(explanationFor(diagnosis, true).includes("lighter fallback"));
  assert.ok(!explanationFor(diagnosis, false).includes("lighter fallback"));
  // Always ends with the actionable suggestion.
  assert.ok(explanationFor(diagnosis, false).includes(diagnosis.suggestion));
});
