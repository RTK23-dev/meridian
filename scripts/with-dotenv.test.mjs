import assert from "node:assert/strict";
import test from "node:test";
import { applyEnv, parseEnv } from "./with-dotenv.mjs";

test("parseEnv keeps assignments and skips comments", () => {
  const parsed = parseEnv(`
# comment
DATABASE_URL=postgres://localhost/meridian
EMPTY=
QUOTED="keep me"
bad key=no
`);
  assert.equal(parsed.DATABASE_URL, "postgres://localhost/meridian");
  assert.equal(parsed.QUOTED, "keep me");
  assert.equal(parsed.EMPTY, undefined);
  assert.equal(parsed["bad key"], undefined);
});

test("applyEnv does not override a variable that is already set", () => {
  const env = { DATABASE_URL: "already" };
  applyEnv("DATABASE_URL=from-file\nXAI_API_KEY=key\n", env);
  assert.equal(env.DATABASE_URL, "already");
  assert.equal(env.XAI_API_KEY, "key");
});
