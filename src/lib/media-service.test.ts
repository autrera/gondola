import assert from "node:assert/strict";
import test from "node:test";
import { isCompletedStatus, isTerminalFailureStatus } from "./media-service";

test("isTerminalFailureStatus matches Venice failure statuses case-insensitively", () => {
  assert.equal(isTerminalFailureStatus("FAILED"), true);
  assert.equal(isTerminalFailureStatus("failed"), true);
  assert.equal(isTerminalFailureStatus("Cancelled"), true);
  assert.equal(isTerminalFailureStatus("EXPIRED"), true);
  assert.equal(isTerminalFailureStatus("PROCESSING"), false);
  assert.equal(isTerminalFailureStatus("COMPLETED"), false);
  assert.equal(isTerminalFailureStatus(undefined), false);
});

test("isCompletedStatus only matches completed", () => {
  assert.equal(isCompletedStatus("COMPLETED"), true);
  assert.equal(isCompletedStatus("completed"), true);
  assert.equal(isCompletedStatus("PENDING"), false);
  assert.equal(isCompletedStatus(42), false);
});
