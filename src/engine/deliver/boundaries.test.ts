// The deliver, events and variants code reaches the world only through the gateway, the ledger and the stores passed in as ports. These
// static checks keep them that way (Bible 1 and 17.2, CLAUDE.md rules 3, 6 and 9): no fetch call, no environment read, no logging, and no
// research, embeddings or Hypit module. The E5 handlers (jobs/handlers/variants.ts and deliver.ts) and the variant writer are checked too.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), "..");
const FOLDERS = ["deliver", "events", "variants"];
const EXTRA_FILES = [
  join(ENGINE, "jobs", "handlers", "variants.ts"),
  join(ENGINE, "jobs", "handlers", "deliver.ts"),
  join(ENGINE, "claude", "roles", "variant_writer.ts"),
];

function productionFiles(): string[] {
  const folders = FOLDERS.flatMap((folder) =>
    readdirSync(join(ENGINE, folder), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => join(entry.parentPath, entry.name)),
  );
  return [...folders, ...EXTRA_FILES].filter((path) => !path.endsWith(".test.ts") && !path.includes(`${sep}test${sep}`));
}

function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const at = (path: string) => relative(ENGINE, path).split(sep).join("/");

describe("deliver, events, variants and the E5 handlers: boundaries", () => {
  it("the scope has production files to check", () => {
    assert.ok(productionFiles().length >= 15);
  });

  it("no call to fetch, and no network host named", () => {
    const offenders = productionFiles().filter((path) => /\bfetch\s*\(|https?:\/\//.test(code(path)));
    assert.deepEqual(offenders.map(at), []);
  });

  it("no environment variable or key is read", () => {
    const offenders = productionFiles().filter((path) => /process\.env|\bapiKey\b|\bsecret\b/i.test(code(path)));
    assert.deepEqual(offenders.map(at), []);
  });

  it("nothing is logged, so manifests, events and answers never reach a log", () => {
    const offenders = productionFiles().filter((path) => /\bconsole\./.test(code(path)));
    assert.deepEqual(offenders.map(at), []);
  });

  it("no research, embeddings or Hypit module is imported, and no Meridian credential resolver", () => {
    const offenders = productionFiles().filter((path) => /lib\/meridian\/(research|embeddings)|research\/|embeddings\/|hypit|credential/i.test(code(path)));
    assert.deepEqual(offenders.map(at), []);
  });

  it("no S3 client is imported: artifacts and media go through the object-store port", () => {
    const offenders = productionFiles().filter((path) => /@aws-sdk|\bs3\b|S3Client/i.test(code(path)));
    assert.deepEqual(offenders.map(at), []);
  });
});
