import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveServerConfig } from "./env";

test("resolveServerConfig returns defaults when environment variables are unset", () => {
  const config = resolveServerConfig({});
  assert.equal(config.host, "localhost");
  assert.equal(config.port, "3000");
});

test("resolveServerConfig respects PORT when provided", () => {
  const config = resolveServerConfig({ PORT: "8080" });
  assert.equal(config.host, "localhost");
  assert.equal(config.port, "8080");
});

test("resolveServerConfig respects HOST when provided", () => {
  const config = resolveServerConfig({ HOST: "127.0.0.1" });
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, "3000");
});

test("resolveServerConfig respects HOSTNAME when HOST is not set", () => {
  const config = resolveServerConfig({ HOSTNAME: "0.0.0.0", PORT: "4000" });
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, "4000");
});

test("resolveServerConfig prefers HOST over HOSTNAME when both are present", () => {
  const config = resolveServerConfig({ HOST: "127.0.0.1", HOSTNAME: "0.0.0.0" });
  assert.equal(config.host, "127.0.0.1");
});
