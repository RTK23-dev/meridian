/**
 * The environment contract. Every environment variable the app and its scripts read is listed once in .env.example, with a
 * comment that says what kind it is. The reverse holds too: a listed variable is read by something, so an obsolete name fails.
 *
 * The reads come from a scan of the non-test files under src/ and scripts/. The scan covers process.env.NAME, process.env["NAME"],
 * env.NAME and env?.NAME on an injected environment object, the env("NAME") and key("NAME") helpers, and import.meta.env.NAME.
 * A name that is chosen at run time (the *_SHARED_DEFAULT switches, the source connector keys, the deployment-only keys) is read
 * from the contract, so it is checked too.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DEPLOYMENT_ONLY_KEY_ENV, SHARED_DEFAULT_ENV, SOURCE_KEY_ENV } from "../credentials/contract.ts";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const ENV_EXAMPLE = join(ROOT, ".env.example");

/**
 * Names that are read only by a test helper or by code nothing calls. Each one says why, so the list stays short and honest.
 * A name here is not required in .env.example.
 */
const ALLOWED_UNLISTED: Record<string, string> = {
  MERIDIAN_PG_TEST_URL: "read only by credentials/test-databases.ts, a test helper. It is set on the command line for npm test.",
  MERIDIAN_DECISION_SHADOW_ENABLED:
    "read only by decisionShadowEnabled() in decisions/jev-engine.ts, which no code calls. It has no effect. Remove it with that helper.",
};

/** Vite's own build-time values. They are set by Vite, not by a deployment, so they are not listed. */
const VITE_BUILTINS = new Set(["DEV", "PROD", "MODE", "SSR", "BASE_URL"]);

/**
 * Names chosen at run time that a static scan cannot see. They are taken from the contract: the source connector keys, the
 * switches, and the deployment-only keys. DECISION_ENGINE and PERCEPTION_PROVIDER are read through the constants
 * DECISION_ENGINE_ENV (decisions/selection.ts) and PERCEPTION_PROVIDER_ENV (perception/run.ts).
 */
function runtimeChosenNames(): string[] {
  const names = new Set<string>(["DECISION_ENGINE", "PERCEPTION_PROVIDER"]);
  for (const list of Object.values(SOURCE_KEY_ENV)) for (const name of list) names.add(name);
  for (const rule of Object.values(SHARED_DEFAULT_ENV)) names.add(rule.variable);
  for (const rule of Object.values(DEPLOYMENT_ONLY_KEY_ENV)) {
    names.add(rule.keyVariable);
    names.add(rule.variable);
  }
  return [...names];
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".output", ".nitro", ".tanstack", ".vinxi", ".vercel", "coverage"]);
const SOURCE_EXT = /\.(ts|tsx|mts|mjs|js|cjs)$/;
const TEST_FILE = /\.(test|spec)\.(ts|tsx|mts|mjs|js|cjs)$/;

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      yield* sourceFiles(path);
    } else if (SOURCE_EXT.test(entry) && !TEST_FILE.test(entry) && !entry.endsWith(".d.ts")) {
      yield path;
    }
  }
}

/** Every pattern that reads a named environment variable. Group 1 is the name. */
const READ_PATTERNS: RegExp[] = [
  /\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /\bprocess\.env\[\s*["'`]([A-Z_][A-Z0-9_]*)["'`]\s*\]/g,
  /\bimport\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /\benv\??\.([A-Z][A-Z0-9_]+)\b/g,
  /\benv\(\s*["']([A-Z][A-Z0-9_]+)["']\s*\)/g,
  /\bkey\(\s*["']([A-Z][A-Z0-9_]+)["']\s*\)/g,
];

/** Each variable the non-test source and scripts read, and the first file that reads it (for a readable failure). */
function readNames(): Map<string, string> {
  const reads = new Map<string, string>();
  for (const base of ["src", "scripts"]) {
    for (const file of sourceFiles(join(ROOT, base))) {
      const text = readFileSync(file, "utf8");
      for (const pattern of READ_PATTERNS) {
        for (const match of text.matchAll(pattern)) {
          const name = match[1];
          if (name && !reads.has(name)) reads.set(name, relative(ROOT, file).split(sep).join("/"));
        }
      }
    }
  }
  for (const name of runtimeChosenNames()) if (!reads.has(name)) reads.set(name, "contract.ts (chosen at run time)");
  return reads;
}

/** Each listed variable, the line it is on, and the comment line above it. Commented examples count as listed. */
function listings(text: string): Array<{ name: string; line: number; comment: string }> {
  const lines = text.split("\n");
  const out: Array<{ name: string; line: number; comment: string }> = [];
  lines.forEach((raw, index) => {
    const match = /^(#\s*)?([A-Z][A-Z0-9_]*)=/.exec(raw);
    if (!match) return;
    const above = index > 0 ? lines[index - 1]!.trim() : "";
    out.push({ name: match[2]!, line: index, comment: above.startsWith("#") ? above : "" });
  });
  return out;
}

const example = readFileSync(ENV_EXAMPLE, "utf8");
const reads = readNames();
const listed = listings(example);
const listedNames = listed.map((item) => item.name);
const KINDS = /\b(infrastructure|deployment configuration|per-workspace key|developer tooling)\b/;

test("the scan finds the reads it must find, including the helper calls and the run-time names", () => {
  for (const name of ["DATABASE_URL", "TOKEN_ENCRYPTION_KEY", "GROK_PROJECT_ID", "VITE_AUTH_ENABLED", "OPENROUTER_MODEL", "META_AD_LIBRARY_TOKEN", "X_API_KEY", "PERCEPTION_SHARED_DEFAULT"]) {
    assert.ok(reads.has(name), `${name} is found`);
  }
  assert.ok(reads.size > 100, `the scan covers the whole source (${reads.size} names)`);
});

test("every variable the non-test src and scripts read is listed in .env.example", () => {
  const missing = [...reads.keys()]
    .filter((name) => !(name in ALLOWED_UNLISTED) && !VITE_BUILTINS.has(name))
    .filter((name) => !listedNames.includes(name))
    .map((name) => `${name} (read in ${reads.get(name)})`);
  assert.deepEqual(missing, [], "add these to .env.example, each with its kind on the line above");
});

test("each variable is listed once", () => {
  const seen = new Map<string, number>();
  for (const name of listedNames) seen.set(name, (seen.get(name) ?? 0) + 1);
  const repeated = [...seen].filter(([, count]) => count > 1).map(([name]) => name);
  assert.deepEqual(repeated, [], "no variable is listed twice");
});

test("every listed variable is read by something, so no obsolete name is kept", () => {
  const obsolete = listedNames.filter((name) => !reads.has(name));
  assert.deepEqual(obsolete, [], "remove these from .env.example, or add the read they belong to");
});

test("the names removed by the routing and Veo changes are gone from .env.example", () => {
  for (const name of [
    "MERIDIAN_VEO_MODEL",
    "MERIDIAN_JEV_PROVIDER_MODE",
    "MERIDIAN_JEV_PREFERRED_PROVIDER",
    "MERIDIAN_JEV_FALLBACK_ENABLED",
    "MERIDIAN_JEV_COMPARE_SAMPLE_RATE",
    "OPENROUTER_JEV_API_KEY",
    "OPENROUTER_JEV_BASE_URL",
    "OPENROUTER_JEV_MODEL",
    "JEV_PROVIDER_MODE",
    "JEV_BASE_URL",
    "JEV_MODEL",
    "CYCLONE_SESSION_ID",
  ]) {
    assert.equal(listedNames.includes(name), false, `${name} is not listed`);
  }
  assert.doesNotMatch(example, /veo/i, "no Veo variable remains");
});

test("every listed variable has a comment on the line above that names its kind", () => {
  const unclassified = listed.filter((item) => !KINDS.test(item.comment)).map((item) => item.name);
  assert.deepEqual(unclassified, [], "each variable says whether it is infrastructure, deployment configuration, a per-workspace key or developer tooling");
});

test("each *_SHARED_DEFAULT switch names the value that opts in, as the contract accepts it", () => {
  for (const [category, rule] of Object.entries(SHARED_DEFAULT_ENV)) {
    const item = listed.find((entry) => entry.name === rule.variable);
    assert.ok(item, `${rule.variable} (${category}) is listed`);
    assert.ok(item.comment.includes(`"${rule.accepts}"`), `${rule.variable} names its accepted value "${rule.accepts}"`);
  }
});

test("the test helper and dead-code allow-list names are not required, and each says why", () => {
  for (const [name, reason] of Object.entries(ALLOWED_UNLISTED)) {
    assert.ok(reason.length > 20, `${name} has a reason`);
  }
});
