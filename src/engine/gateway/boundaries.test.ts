// The gateway is the engine's one way to the network (owner decision 2026-10-14). These static checks keep it that way:
// no production file but gateway/transport.ts calls fetch, only the gateway reads Meridian's credentials, and provider
// hosts are named only in the gateway's provider registry.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), "..");

function productionFiles(): string[] {
  return readdirSync(ENGINE, { recursive: true, withFileTypes: true })
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

describe("gateway boundaries", () => {
  it("only gateway/transport.ts calls fetch", () => {
    const offenders = productionFiles().filter((path) => at(path) !== "gateway/transport.ts" && /\bfetch\s*\(/.test(code(path)));
    assert.deepEqual(offenders.map(at), []);
  });

  it("only gateway/meridian.ts reads Meridian's credential resolver", () => {
    const offenders = productionFiles().filter((path) => at(path) !== "gateway/meridian.ts" && /lib\/meridian\/credentials\//.test(code(path)));
    assert.deepEqual(offenders.map(at), []);
  });

  it("model platform hosts are named only in the provider registry", () => {
    const offenders = productionFiles().filter(
      (path) => at(path) !== "gateway/providers.ts" && /openrouter\.ai|api\.anthropic\.com/.test(code(path)),
    );
    assert.deepEqual(offenders.map(at), []);
  });
});
