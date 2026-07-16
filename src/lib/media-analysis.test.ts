import assert from "node:assert/strict";
import test from "node:test";
import { imageDimensions } from "./media-analysis";

test("imageDimensions reads PNG width and height from IHDR", () => {
  const png = Buffer.alloc(32);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(1280, 16);
  png.writeUInt32BE(720, 20);
  assert.deepEqual(imageDimensions(png), { width: 1280, height: 720, format: "png" });
});

test("imageDimensions reads GIF logical screen size", () => {
  const gif = Buffer.alloc(32);
  gif.write("GIF89a", 0, "ascii");
  gif.writeUInt16LE(800, 6);
  gif.writeUInt16LE(600, 8);
  assert.deepEqual(imageDimensions(gif), { width: 800, height: 600, format: "gif" });
});

test("imageDimensions returns undefined for unrecognized or tiny buffers", () => {
  assert.equal(imageDimensions(Buffer.from("not an image at all, really")), undefined);
  assert.equal(imageDimensions(Buffer.alloc(4)), undefined);
});
