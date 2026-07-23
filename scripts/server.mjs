#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Minimal .env loader. Populates process.env from .env.local and .env
 * without overwriting values already present in the environment.
 */
function loadEnv(cwd = process.cwd()) {
  for (const file of [".env.local", ".env"]) {
    let raw;
    try {
      raw = readFileSync(path.join(cwd, file), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!key || key in process.env) continue;
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}

loadEnv();

const action = process.argv[2] ?? "dev";
const extraArgs = process.argv.slice(3);

const host = process.env.HOST?.trim() || process.env.HOSTNAME?.trim() || "localhost";
const port = process.env.PORT?.trim() || "3000";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const nextCliPath = path.join(root, "node_modules", "next", "dist", "bin", "next");

const args = [nextCliPath, action, "--hostname", host, "--port", port, ...extraArgs];

const child = spawn(process.execPath, args, {
  stdio: "inherit",
  cwd: process.cwd(),
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});

child.on("error", (error) => {
  console.error(`Failed to launch Next.js ${action} server:`, error.message);
  process.exit(1);
});
