import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { deleteAsset, listAssets } from "./assets";
import {
  MEDIA_DIR,
  awaitMediaTask,
  cancelMediaTask,
  createMediaTask,
  deleteMediaTask,
  getMediaTask,
  getMediaTaskByProviderId,
  isPathWithinMediaDir,
  listMediaTasks,
  toTaskStatusView,
  updateMediaTask,
} from "./media-tasks";

async function cleanupTask(taskId: string): Promise<void> {
  const task = await getMediaTask(taskId);
  if (task?.outputPath) await unlink(task.outputPath).catch(() => undefined);
  for (const asset of (await listAssets({})).filter((item) => item.sourceTaskId === taskId)) {
    await deleteAsset(asset.id).catch(() => undefined);
  }
  await deleteMediaTask(taskId).catch(() => undefined);
}

test("media task store supports create, lookup, update, cancel, and delete", async () => {
  const providerTaskId = `test-queue-${crypto.randomUUID()}`;
  let taskId = "";
  try {
    const created = await createMediaTask({
      providerTaskId,
      kind: "video",
      type: "video",
      prompt: "a canal at dawn",
      model: "seedance-2-0-text-to-video",
      estimatedCostUsd: 0.4,
    });
    taskId = created.id;
    assert.equal(created.status, "queued");
    assert.equal(created.providerTaskId, providerTaskId);

    const fetched = await getMediaTask(taskId);
    assert.equal(fetched?.id, taskId);

    const byProvider = await getMediaTaskByProviderId(providerTaskId);
    assert.equal(byProvider?.id, taskId);

    const listed = await listMediaTasks({ limit: 50 });
    assert.ok(listed.some((task) => task.id === taskId));

    const updated = await updateMediaTask(taskId, { status: "running" });
    assert.equal(updated?.status, "running");

    const cancelled = await cancelMediaTask(taskId);
    assert.equal(cancelled?.status, "cancelled");
  } finally {
    if (taskId) await deleteMediaTask(taskId).catch(() => undefined);
  }
  assert.equal(await getMediaTask(taskId), undefined);
});

test("cancel is a no-op message for a missing task", async () => {
  assert.equal(await cancelMediaTask(`missing-${crypto.randomUUID()}`), undefined);
});

test("concurrent awaits perform exactly one retrieval and register one asset", async () => {
  const created = await createMediaTask({ providerTaskId: `q-${crypto.randomUUID()}`, kind: "video", type: "video", model: "seedance-2-0-text-to-video", prompt: "a canal" });
  let calls = 0;
  const retrieve = async () => {
    calls += 1;
    return { state: "ready" as const, bytes: new Uint8Array([1, 2, 3, 4]).buffer, contentType: "video/mp4" };
  };
  try {
    const [first, second] = await Promise.all([
      awaitMediaTask(created.id, { retrieve }),
      awaitMediaTask(created.id, { retrieve }),
    ]);
    assert.equal(calls, 1);
    assert.equal(first.state, "succeeded");
    assert.equal(second.state, "succeeded");
    assert.equal(first.task.assetId, second.task.assetId);
    const assets = (await listAssets({})).filter((asset) => asset.sourceTaskId === created.id);
    assert.equal(assets.length, 1);
  } finally {
    await cleanupTask(created.id);
  }
});

test("awaiting a completed task returns immediately without retrieving", async () => {
  const created = await createMediaTask({ providerTaskId: `q-${crypto.randomUUID()}`, kind: "music", type: "music", model: "ace-step-15" });
  await updateMediaTask(created.id, { status: "succeeded", assetId: "asset-existing", outputPath: "/tmp/none" });
  let called = false;
  const retrieve = async () => {
    called = true;
    return { state: "ready" as const, bytes: new ArrayBuffer(1), contentType: "audio/mpeg" };
  };
  try {
    const result = await awaitMediaTask(created.id, { retrieve });
    assert.equal(result.state, "succeeded");
    assert.equal(result.task.assetId, "asset-existing");
    assert.equal(called, false);
  } finally {
    await deleteMediaTask(created.id).catch(() => undefined);
  }
});

test("a stale in-progress task recovers on the next await", async () => {
  const created = await createMediaTask({ providerTaskId: `q-${crypto.randomUUID()}`, kind: "video", type: "video", model: "seedance-2-0-text-to-video" });
  await updateMediaTask(created.id, { status: "running", retrievalLeaseUntil: Date.now() - 60_000 });
  const retrieve = async () => ({ state: "ready" as const, bytes: new ArrayBuffer(2), contentType: "video/mp4" });
  try {
    const result = await awaitMediaTask(created.id, { retrieve });
    assert.equal(result.state, "succeeded");
    assert.ok(result.task.assetId);
  } finally {
    await cleanupTask(created.id);
  }
});

test("toTaskStatusView exposes only safe fields with the asset reference", async () => {
  const created = await createMediaTask({ providerTaskId: `q-${crypto.randomUUID()}`, kind: "video", type: "video", model: "m", downloadUrl: "https://private-share.venice.ai/v1/share/read/secret" });
  try {
    const succeeded = await updateMediaTask(created.id, { status: "succeeded", assetId: "asset-xyz" });
    assert.ok(succeeded);
    const view = toTaskStatusView(succeeded);
    assert.equal(view.status, "succeeded");
    assert.equal(view.assetId, "asset-xyz");
    assert.equal(view.assetUrl, "/api/media/asset?id=asset-xyz");
    assert.equal("downloadUrl" in view, false);
    assert.equal("outputPath" in view, false);
    assert.equal("providerTaskId" in view, false);
  } finally {
    await deleteMediaTask(created.id).catch(() => undefined);
  }
});

test("isPathWithinMediaDir allows managed files and rejects traversal", () => {
  assert.equal(isPathWithinMediaDir(path.join(MEDIA_DIR, "video-1.mp4")), true);
  assert.equal(isPathWithinMediaDir(path.join(MEDIA_DIR, "..", "..", "etc", "passwd")), false);
  assert.equal(isPathWithinMediaDir("/etc/passwd"), false);
});
