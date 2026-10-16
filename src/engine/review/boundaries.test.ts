// The review folder is reached through the contracts, the gateway and the Claude client, and nothing else. These static checks
// keep it that way (CLAUDE.md rules 3, 8 and 9; Bible 17.2): no network call, no key or environment read, no logging, no
// Meridian credential, research, embeddings or Hypit module, and no import of another workstream's test helpers.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCOPE = "review";

function productionFiles(): string[] {
  return readdirSync(join(ENGINE, SCOPE), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => !path.endsWith(".test.ts") && !path.includes(`${sep}test${sep}`));
}

function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const at = (path: string) => relative(ENGINE, path).split(sep).join("/");

describe("review boundaries", () => {
  it("the scope has production files to check", () => {
    assert.ok(productionFiles().length >= 10);
  });

  it("no call to fetch, and no network host named", () => {
    const offenders = productionFiles().filter((path) => /\bfetch\s*\(|https?:\/\//.test(code(path)));
    assert.deepEqual(offenders.map(at), []);
  });

  it("no key, secret or environment variable is read", () => {
    const offenders = productionFiles().filter((path) => /process\.env|\bapiKey\b|\bsecret\b/i.test(code(path)));
    assert.deepEqual(offenders.map(at), []);
  });

  it("nothing is logged, so frames, rubric answers and verdicts never reach a log", () => {
    const offenders = productionFiles().filter((path) => /\bconsole\./.test(code(path)));
    assert.deepEqual(offenders.map(at), []);
  });

  it("no Meridian credential resolver, research, embeddings or Hypit module is imported", () => {
    const offenders = productionFiles().filter((path) => /lib\/meridian|research\/|embeddings\/|hypit/i.test(code(path)));
    assert.deepEqual(offenders.map(at), []);
  });

  it("no production file imports a test helper of another folder", () => {
    const offenders = productionFiles().filter((path) => /\/test\/helpers/.test(code(path)));
    assert.deepEqual(offenders.map(at), []);
  });
});
