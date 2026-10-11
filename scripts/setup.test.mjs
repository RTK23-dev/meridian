import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_BASE_URL,
  envFileFor,
  fillBlankEnvValue,
  generateTokenEncryptionKey,
  nodeVersionProblem,
  setupSummary,
} from "./setup.mjs";

// Importing setup.mjs runs nothing: the file's main() runs only as the entry point. This test process is not that entry point,
// so reaching this line already proves the import has no side effects.

const EXAMPLE = readFileSync(fileURLToPath(new URL("../.env.example", import.meta.url)), "utf8");

function summaryFacts(overrides = {}) {
  return {
    nodeVersion: "22.22.0",
    nodeOk: true,
    dependencies: "already present",
    envFile: "kept as it was",
    tokenKey: "already set",
    database: "notSet",
    baseUrl: DEFAULT_BASE_URL,
    ...overrides,
  };
}

test("the Node.js check accepts 22 and newer, and names the problem for an older version", () => {
  assert.equal(nodeVersionProblem("22.22.0"), null);
  assert.equal(nodeVersionProblem("24.1.0"), null);
  assert.match(nodeVersionProblem("20.11.0"), /Node\.js 22 or newer is required\. This is Node\.js 20\.11\.0/);
  assert.match(nodeVersionProblem("not-a-version"), /Could not read the Node\.js version/);
});

test("an existing .env is never overwritten, and a new one is made from the example", () => {
  const kept = envFileFor("TOKEN_ENCRYPTION_KEY=mine\nDATABASE_URL=postgres://db\n", EXAMPLE);
  assert.equal(kept.created, false);
  assert.equal(kept.text, "TOKEN_ENCRYPTION_KEY=mine\nDATABASE_URL=postgres://db\n");

  const created = envFileFor(null, EXAMPLE);
  assert.equal(created.created, true);
  assert.equal(created.text, EXAMPLE);
});

test("TOKEN_ENCRYPTION_KEY is generated only when the line is empty, and a set value is kept without calling the generator", () => {
  let calls = 0;
  const make = () => {
    calls += 1;
    return "generated-value-0123456789";
  };

  const blank = fillBlankEnvValue("BETTER_AUTH_URL=http://x\nTOKEN_ENCRYPTION_KEY=\nWEBHOOK_SECRET=\n", "TOKEN_ENCRYPTION_KEY", make);
  assert.equal(blank.filled, true);
  assert.equal(blank.text, "BETTER_AUTH_URL=http://x\nTOKEN_ENCRYPTION_KEY=generated-value-0123456789\nWEBHOOK_SECRET=\n");
  assert.equal(calls, 1);

  const set = "TOKEN_ENCRYPTION_KEY=already-set-value-42\n";
  const kept = fillBlankEnvValue(set, "TOKEN_ENCRYPTION_KEY", make);
  assert.equal(kept.filled, false);
  assert.equal(kept.text, set);
  assert.equal(calls, 1, "the generator is not called for a set key");
});

test("a missing TOKEN_ENCRYPTION_KEY line is appended, and a commented example line is not treated as a value", () => {
  const appended = fillBlankEnvValue("# TOKEN_ENCRYPTION_KEY=\nDATABASE_URL=", "TOKEN_ENCRYPTION_KEY", () => "abc123");
  assert.equal(appended.filled, true);
  assert.match(appended.text, /^# TOKEN_ENCRYPTION_KEY=\nDATABASE_URL=\nTOKEN_ENCRYPTION_KEY=abc123\n$/);

  const emptyFile = fillBlankEnvValue("", "TOKEN_ENCRYPTION_KEY", () => "xyz");
  assert.equal(emptyFile.text, "TOKEN_ENCRYPTION_KEY=xyz\n");
});

test("the generated key is 32 random bytes, hex encoded, and differs between calls", () => {
  const first = generateTokenEncryptionKey();
  const second = generateTokenEncryptionKey();
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, second);
  assert.equal(generateTokenEncryptionKey((size) => Buffer.alloc(size, 0xab)), "ab".repeat(32));
});

test("the example leaves TOKEN_ENCRYPTION_KEY and DATABASE_URL blank, so setup fills the first and leaves the second to PGlite", () => {
  assert.equal(fillBlankEnvValue(EXAMPLE, "TOKEN_ENCRYPTION_KEY", () => "filled").filled, true);
  assert.match(EXAMPLE, /^DATABASE_URL=$/m, "DATABASE_URL is blank in the example");
});

test("the summary names the sign-in page, the Setup view and the start command, and never prints a value", () => {
  const lines = setupSummary(summaryFacts({ baseUrl: "http://127.0.0.1:9000" })).join("\n");
  assert.match(lines, /npm run dev/);
  assert.match(lines, /open http:\/\/127\.0\.0\.1:9000\/login/);
  assert.match(lines, /Settings, General, Setup/);
  assert.match(lines, /Only a workspace admin can save a key/);
  assert.match(lines, /TOKEN_ENCRYPTION_KEY: generated \(the value is never printed\)|TOKEN_ENCRYPTION_KEY: already set \(the value is never printed\)/);
});

test("without DATABASE_URL the summary says plainly that PGlite applies, and with it the summary says the migrations ran", () => {
  const plain = setupSummary(summaryFacts({ database: "notSet" })).join("\n");
  assert.match(plain, /DATABASE_URL is not set\. Meridian will use the embedded PGlite database/);

  const migrated = setupSummary(summaryFacts({ database: "migrated" })).join("\n");
  assert.match(migrated, /DATABASE_URL is set, and the migrations are applied/);
  assert.doesNotMatch(migrated, /PGlite/);

  const failed = setupSummary(summaryFacts({ database: "failed" })).join("\n");
  assert.match(failed, /the migrations failed/);
});

test("the summary reads only the named facts, so a database URL or a key in the environment cannot reach it", () => {
  const secretUrl = "postgres://admin:hunter2-password@db.internal:5432/meridian";
  const generated = "f".repeat(64);
  const lines = setupSummary({ ...summaryFacts(), databaseUrl: secretUrl, TOKEN_ENCRYPTION_KEY: generated, apiKey: "sk-live-123" }).join("\n");
  assert.equal(lines.includes("hunter2-password"), false);
  assert.equal(lines.includes(generated), false);
  assert.equal(lines.includes("sk-live-123"), false);
});

test("the summary uses the default origin when none is given, and says a state that was not reported", () => {
  assert.match(setupSummary(summaryFacts({ baseUrl: "" })).join("\n"), /open http:\/\/127\.0\.0\.1:8080\/login/);
  assert.match(setupSummary(summaryFacts({ database: "unknown" })).join("\n"), /The database state was not reported/);
});
