// The Claude client and the prompts are reached through the gateway, the budget and the contracts, and nothing else. These
// static checks keep them that way (Bible 11, CLAUDE.md rules 3 and 9): no network call, no key in the environment, no
// logging of prompts or answers, no Meridian credential or research code.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCOPE = ["claude", "prompts"];

function productionFiles(): string[] {
  return SCOPE.flatMap((folder) =>
    readdirSync(join(ENGINE, folder), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => join(entry.parentPath, entry.name))
      .filter((path) => !path.endsWith(".test.ts") && !path.includes(`${sep}test${sep}`)),
  );
}

function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const at = (path: string) => relative(ENGINE, path).split(sep).join("/");

describe("claude and prompts boundaries", () => {
  it("the scope has production files to check", () => {
    assert.ok(productionFiles().length >= 5);
  });

  it("no call to fetch, and no network host named", () => {
    const offenders = productionFiles().filter((path) => /\bfetch\s*\(|https?:\/\//.test(code(path)));
    assert.deepEqual(offenders.map(at), []);
  });

  it("no key or environment variable is read", () => {
    const offenders = productionFiles().filter((path) => /process\.env|\bapiKey\b|\bsecret\b/i.test(code(path)));
    assert.deepEqual(offenders.map(at), []);
  });

  it("nothing is logged, so prompts and answers never reach a log", () => {
    const offenders = productionFiles().filter((path) => /\bconsole\./.test(code(path)));
    assert.deepEqual(offenders.map(at), []);
  });

  it("no Meridian credential resolver, research, embeddings or Hypit module is imported", () => {
    const offenders = productionFiles().filter((path) => /lib\/meridian|research\/|embeddings\/|hypit/i.test(code(path)));
    assert.deepEqual(offenders.map(at), []);
  });
});
