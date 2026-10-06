#!/usr/bin/env node
/**
 * Load `.env` into the environment, then run a command.
 * A variable already set in the process wins. Blank values are ignored.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function parseEnv(text) {
  const entries = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) entries[key] = value;
  }
  return entries;
}

export function applyEnv(text, env = process.env) {
  const entries = parseEnv(text);
  for (const [key, value] of Object.entries(entries)) {
    if (env[key]?.trim()) continue;
    env[key] = value;
  }
  return entries;
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const path = join(root, ".env");
  if (existsSync(path)) applyEnv(readFileSync(path, "utf8"));
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.error("usage: node scripts/with-dotenv.mjs <command> [args]");
    process.exit(1);
  }
  const child = spawn(command, args, { stdio: "inherit", env: process.env });
  child.on("error", (error) => {
    console.error(error.message);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}
