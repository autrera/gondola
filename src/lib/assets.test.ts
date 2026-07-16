import assert from "node:assert/strict";
import test from "node:test";
import { deleteAsset, getAsset, listAssets, registerAsset, updateAsset } from "./assets";

test("asset manifest supports register, lookup, filter, update, and delete", async () => {
  const projectId = `test-project-${crypto.randomUUID()}`;
  let assetId = "";
  try {
    const asset = await registerAsset({
      kind: "image",
      projectId,
      path: "/tmp/example.webp",
      prompt: "a serene canal",
      model: "z-image-turbo",
      metadata: { contentType: "image/webp", bytes: 1234 },
    });
    assetId = asset.id;
    assert.equal(asset.kind, "image");
    assert.equal(asset.status, "draft");
    assert.equal(asset.version, 1);

    const fetched = await getAsset(assetId);
    assert.equal(fetched?.id, assetId);

    const listed = await listAssets({ kind: "image", projectId, limit: 10 });
    assert.ok(listed.some((item) => item.id === assetId));

    const audioOnly = await listAssets({ kind: "audio", projectId });
    assert.equal(audioOnly.some((item) => item.id === assetId), false);

    const approved = await updateAsset(assetId, { status: "approved" });
    assert.equal(approved?.status, "approved");
  } finally {
    if (assetId) await deleteAsset(assetId).catch(() => undefined);
  }
  assert.equal(await getAsset(assetId), undefined);
});
