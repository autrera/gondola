import assert from "node:assert/strict";
import test from "node:test";
import { chooseRetrievalMode, taskViewToArtifactPatch, type TaskStatusView } from "./media-ui";

test("chooseRetrievalMode routes durable tasks to Gondola and legacy jobs to the legacy route", () => {
  assert.equal(chooseRetrievalMode({ kind: "video", taskId: "t1", queueId: "q1" }), "gondola");
  assert.equal(chooseRetrievalMode({ kind: "music", taskId: "t2" }), "gondola");
  assert.equal(chooseRetrievalMode({ kind: "video", queueId: "q1" }), "legacy");
  assert.equal(chooseRetrievalMode({ kind: "music", queueId: "q2" }), "legacy");
  assert.equal(chooseRetrievalMode({ kind: "image" }), "none");
  assert.equal(chooseRetrievalMode({ kind: "video" }), "none");
});

test("a task id always wins, so the UI never independently retrieves from Venice", () => {
  // With a taskId present, the mode is Gondola even if a legacy queueId exists.
  assert.equal(chooseRetrievalMode({ kind: "video", taskId: "t", queueId: "q" }), "gondola");
});

test("legacy retrieval remains available for jobs without a task id", () => {
  assert.equal(chooseRetrievalMode({ kind: "video", queueId: "legacy-q" }), "legacy");
});

test("taskViewToArtifactPatch maps terminal and in-progress states", () => {
  const succeeded: TaskStatusView = { taskId: "t", status: "succeeded", assetId: "a1", assetUrl: "/api/media/asset?id=a1" };
  const ok = taskViewToArtifactPatch(succeeded, 3);
  assert.equal(ok.status, "ready");
  assert.equal(ok.url, "/api/media/asset?id=a1");
  assert.equal(ok.assetId, "a1");
  assert.equal(ok.terminal, true);

  const failed = taskViewToArtifactPatch({ taskId: "t", status: "failed", error: "boom" }, 1);
  assert.equal(failed.status, "error");
  assert.equal(failed.message, "boom");
  assert.equal(failed.terminal, true);

  const running = taskViewToArtifactPatch({ taskId: "t", status: "running" }, 2);
  assert.equal(running.status, "processing");
  assert.equal(running.terminal, false);
});