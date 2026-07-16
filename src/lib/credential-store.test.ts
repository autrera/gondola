import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  deleteStoredCredential,
  getCredentialStatus,
  gondolaHomeDir,
  maskSuffix,
  resolveCredential,
  writeStoredCredential,
} from "./credential-store";

let savedKey: string | undefined;

beforeEach(() => {
  process.env.GONDOLA_HOME = mkdtempSync(path.join(os.tmpdir(), "gondola-cred-test-"));
  savedKey = process.env.VENICE_API_KEY;
  delete process.env.VENICE_API_KEY;
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.VENICE_API_KEY;
  else process.env.VENICE_API_KEY = savedKey;
  delete process.env.GONDOLA_HOME;
});

test("no credential resolves to null", () => {
  assert.equal(resolveCredential("venice"), null);
  const status = getCredentialStatus("venice");
  assert.equal(status.configured, false);
  assert.equal(status.source, "none");
});

test("environment credential takes precedence over a local file", () => {
  writeStoredCredential("venice", "file-key-aaaa");
  process.env.VENICE_API_KEY = "env-key-bbbb";
  const resolved = resolveCredential("venice");
  assert.equal(resolved?.source, "environment");
  assert.equal(resolved?.apiKey, "env-key-bbbb");
  const status = getCredentialStatus("venice");
  assert.equal(status.source, "environment");
  assert.equal(status.envReadOnly, true);
  assert.equal(status.hasFile, true);
});

test("an explicit local override beats the environment credential", () => {
  process.env.VENICE_API_KEY = "env-key-bbbb";
  writeStoredCredential("venice", "file-key-cccc", { override: true });
  const resolved = resolveCredential("venice");
  assert.equal(resolved?.source, "file");
  assert.equal(resolved?.apiKey, "file-key-cccc");
});

test("a saved credential file is created with owner-only permissions", () => {
  writeStoredCredential("venice", "secret-key-dddd");
  const filePath = path.join(gondolaHomeDir(), "credentials.json");
  assert.ok(existsSync(filePath));
  assert.equal(statSync(filePath).mode & 0o777, 0o600);
  assert.equal(statSync(gondolaHomeDir()).mode & 0o777, 0o700);
});

test("removing a local credential falls back to the environment credential", () => {
  writeStoredCredential("venice", "file-key-eeee");
  process.env.VENICE_API_KEY = "env-key-ffff";
  deleteStoredCredential("venice");
  const resolved = resolveCredential("venice");
  assert.equal(resolved?.source, "environment");
  assert.equal(resolved?.apiKey, "env-key-ffff");
});

test("status exposes only a masked suffix, never the raw key", () => {
  writeStoredCredential("venice", "sk-abcdefghijkl-WXYZ");
  const status = getCredentialStatus("venice");
  assert.ok(!JSON.stringify(status).includes("sk-abcdefghijkl-WXYZ"));
  assert.equal(status.maskedSuffix, maskSuffix("sk-abcdefghijkl-WXYZ"));
  assert.ok(status.maskedSuffix?.endsWith("WXYZ"));
});
