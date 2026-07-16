import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSeatbeltProfile,
  sanitizedEnv,
  secretReadDenyPaths,
  wrapCommandForSandbox,
} from "./sandbox";

test("buildSeatbeltProfile denies by default and confines writes", () => {
  const profile = buildSeatbeltProfile({ writableRoots: ["/Users/x/work"], allowNetwork: false, home: "/Users/x" });
  assert.match(profile, /\(deny default\)/);
  assert.match(profile, /\(allow file-write\*/);
  assert.match(profile, /"\/Users\/x\/work"/);
  assert.match(profile, /\(deny network\*\)/);
  assert.match(profile, /\(deny file-read\* \(subpath "\/Users\/x\/\.ssh"\)\)/);
});

test("buildSeatbeltProfile allows network only when requested", () => {
  const profile = buildSeatbeltProfile({ writableRoots: ["/w"], allowNetwork: true });
  assert.match(profile, /\(allow network\*\)/);
  assert.doesNotMatch(profile, /\(deny network\*\)/);
});

test("sanitizedEnv strips secrets but keeps essentials", () => {
  const env = sanitizedEnv({
    PATH: "/bin",
    HOME: "/Users/x",
    VENICE_API_KEY: "sk-secret",
    MY_TOKEN: "t",
    AWS_SECRET_ACCESS_KEY: "s",
    GITHUB_PASSWORD: "p",
    HARMLESS: "ok",
  });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/Users/x");
  assert.equal(env.HARMLESS, "ok");
  assert.equal(env.VENICE_API_KEY, undefined);
  assert.equal(env.MY_TOKEN, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.GITHUB_PASSWORD, undefined);
});

test("secretReadDenyPaths includes credential stores", () => {
  const paths = secretReadDenyPaths("/Users/x");
  assert.ok(paths.some((entry) => entry.endsWith("/.ssh")));
  assert.ok(paths.some((entry) => entry.includes("credentials.json")));
});

test("wrapCommandForSandbox mode=off runs unsandboxed via the shell", async () => {
  const wrapped = await wrapCommandForSandbox("echo hi", { workspaceRoot: "/w", mode: "off" });
  assert.equal(wrapped.sandboxed, false);
  assert.equal(wrapped.useShell, true);
  assert.equal(wrapped.file, "echo hi");
});
