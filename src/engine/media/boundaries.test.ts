// Boundaries (Bible principle 8 and the rules in src/engine/CLAUDE.md): production code takes MediaFunctions and never
// the in-process implementation; only the media folder touches the ffmpeg handlers; no code reads keys from the
// environment; no local models are imported. These are static checks over the source tree, run by npm test.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const ENGINE = join(ROOT, "src", "engine");
const FUNCTIONS = join(ROOT, "functions", "ffmpeg");

function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name));
}

function isTest(path: string): boolean {
  return path.endsWith(".test.ts") || path.includes(`${sep}test${sep}`);
}

/** Every module specifier in the file. typeOnly is true when nothing is imported at runtime (import type, or only type names). */
function importSpecifiers(source: string): Array<{ specifier: string; typeOnly: boolean }> {
  const found: Array<{ specifier: string; typeOnly: boolean }> = [];
  const pattern = /^\s*(import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/gm;
  for (const match of source.matchAll(pattern)) {
    const clause = (match[3] ?? "").trim();
    const names = clause
      .replace(/^\{/, "")
      .replace(/\}$/, "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    const typeOnly =
      match[2] !== undefined ||
      (names.length > 0 && names.every((name) => name.startsWith("type ")));
    found.push({ specifier: match[4] ?? "", typeOnly });
  }
  return found;
}

const HANDLER_MODULES = /functions\/ffmpeg\/(probe|frames|loudness|cuts|http|exec|source)\.ts$/;
const LOCAL_ONLY = /(\/|^)local\.ts$/;

describe("media boundaries", () => {
  const productionFiles = files(ENGINE).filter((path) => !isTest(path));

  it("no production file outside src/engine/media imports the in-process implementation", () => {
    const offenders: string[] = [];
    for (const path of productionFiles) {
      if (relative(ENGINE, path).startsWith(`media${sep}`)) {
        continue;
      }
      for (const { specifier } of importSpecifiers(readFileSync(path, "utf8"))) {
        if (LOCAL_ONLY.test(specifier)) {
          offenders.push(`${relative(ROOT, path)} imports ${specifier}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("no production file uses the recorded speech-to-text adapter (it is for tests and CI)", () => {
    const offenders: string[] = [];
    for (const path of productionFiles) {
      if (relative(ENGINE, path) === join("media", "stt.ts")) {
        continue;
      }
      const code = readFileSync(path, "utf8").replace(/\/\/.*$/gm, "");
      if (/\brecordedSpeechToText\b/.test(code)) {
        offenders.push(relative(ROOT, path));
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("the media folder's index exports neither the in-process implementation nor the recorded adapter", () => {
    const index = readFileSync(join(ENGINE, "media", "index.ts"), "utf8");
    const exported = importSpecifiers(index).map((item) => item.specifier);
    assert.equal(
      exported.some((specifier) => LOCAL_ONLY.test(specifier)),
      false,
    );
    assert.doesNotMatch(index.replace(/\/\/.*$/gm, ""), /localMediaFunctions|recordedSpeechToText/);
  });

  it("no production file outside src/engine/media runs a function handler (only types may come from functions/ffmpeg)", () => {
    const offenders: string[] = [];
    for (const path of productionFiles) {
      if (relative(ENGINE, path).startsWith(`media${sep}`)) {
        continue;
      }
      for (const { specifier, typeOnly } of importSpecifiers(readFileSync(path, "utf8"))) {
        if (
          !typeOnly &&
          specifier.includes("functions/ffmpeg/") &&
          HANDLER_MODULES.test(specifier)
        ) {
          offenders.push(`${relative(ROOT, path)} imports ${specifier}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("no production file reads the environment: keys come from the credential resolver", () => {
    const offenders: string[] = [];
    for (const path of [...productionFiles, ...files(FUNCTIONS)].filter((path) => !isTest(path))) {
      if (/process\.env/.test(readFileSync(path, "utf8"))) {
        offenders.push(relative(ROOT, path));
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("no engine code imports the legacy local models or embeddings (research/, embeddings/, Hypit)", () => {
    const offenders: string[] = [];
    for (const path of productionFiles) {
      for (const { specifier } of importSpecifiers(readFileSync(path, "utf8"))) {
        if (
          /(^|\/)(research|embeddings)\//.test(specifier) ||
          /hypit/i.test(specifier) ||
          /src\/lib\/meridian\/research/.test(specifier)
        ) {
          offenders.push(`${relative(ROOT, path)} imports ${specifier}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("the functions folder is self-contained: it imports nothing from the rest of src but the contracts and config", () => {
    const offenders: string[] = [];
    for (const path of files(FUNCTIONS).filter((path) => !isTest(path))) {
      for (const { specifier } of importSpecifiers(readFileSync(path, "utf8"))) {
        if (
          specifier.startsWith("../../src/") &&
          !/^\.\.\/\.\.\/src\/engine\/(contracts|config)\//.test(specifier)
        ) {
          offenders.push(`${relative(ROOT, path)} imports ${specifier}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });
});
