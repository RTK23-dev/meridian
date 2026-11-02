import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { cycloneApiKey, emailApiKey, externalSemanticKey, tokenEncryptionKey, webhookSecret } from "./secret-settings.ts";

const ACCESSORS = [
  ["tokenEncryptionKey", tokenEncryptionKey, "TOKEN_ENCRYPTION_KEY"],
  ["externalSemanticKey", externalSemanticKey, "EXTERNAL_SEMANTIC_KEY"],
  ["emailApiKey", emailApiKey, "EMAIL_API_KEY"],
  ["cycloneApiKey", cycloneApiKey, "CYCLONE_API_KEY"],
  ["webhookSecret", webhookSecret, "WEBHOOK_SECRET"],
] as const;

describe("the secret accessors return the raw value", () => {
  for (const [name, accessor, variable] of ACCESSORS) {
    it(`${name} returns ${variable} exactly as set, and undefined when it is not set`, () => {
      assert.equal(accessor({ [variable]: " a-value " }), " a-value ", "whitespace is kept for the caller to decide");
      assert.equal(accessor({}), undefined);
    });
  }
});

// Every read of the five names is in this folder. A new reader calls an accessor instead of reading the environment itself.
const NAMES = ACCESSORS.map(([, , variable]) => variable).join("|");
const DIRECT_READ = new RegExp(`process\\.env(\\.(${NAMES})\\b|\\[["'](${NAMES})["']\\])`);
const SRC_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const THIS_MODULE = "lib/meridian/credentials/secret-settings.ts";

function appFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return appFiles(path);
    if (!/\.(ts|tsx)$/.test(entry) || /\.test\.(ts|tsx)$/.test(entry)) return [];
    return [path];
  });
}

describe("the environment is read for a secret in one place", () => {
  it("no app file reads one of the five names from process.env outside secret-settings.ts", () => {
    const offenders = appFiles(SRC_ROOT)
      .map((path) => relative(SRC_ROOT, path))
      .filter((rel) => rel !== THIS_MODULE)
      .filter((rel) => DIRECT_READ.test(readFileSync(join(SRC_ROOT, rel), "utf8")));
    assert.deepEqual(offenders, [], "read the secret through an accessor in src/lib/meridian/credentials/secret-settings.ts");
  });
});
