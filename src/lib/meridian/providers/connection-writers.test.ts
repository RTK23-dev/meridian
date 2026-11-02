// Every statement that writes a provider connection. The connection's status, last success and last error decide whether a provider is
// used: readiness, performance sync and publishing all read them. A status with a second writer nobody expected is how a connection
// goes stale or stays healthy when it should not (see docs/RELEASE_ACCEPTANCE.md, "Recording real use"). So a new writer fails this test
// until it is listed below, with the reason it writes.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SCANNED_DIRECTORIES = ["src", "scripts"];
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", ".output", ".nitro", ".tanstack", ".vinxi", "coverage"]);
const WRITE = /\b(?:update|insert\s+into)\s+provider_connections\b/g;

/** The files that write provider connections, the number of write statements each has, and why. */
const EXPECTED_WRITERS: Record<string, { count: number; why: string }> = {
  "src/lib/meridian/providers/connect.ts": {
    count: 4,
    why: "The connection test and reconnect, and the disconnect: each writes the probe result or the disconnected state.",
  },
  "src/lib/meridian/providers/usage.ts": {
    count: 2,
    why: "A real sync or publish: a refusal marks the connection FAILED, and an accepted request refreshes its last success.",
  },
  "src/lib/meridian/performance/job.ts": {
    count: 1,
    why: "A sync with no tenant credential marks the connection NOT_CONNECTED, and makes no provider request.",
  },
  "scripts/release-acceptance/seed-holds.mjs": {
    count: 1,
    why: "The release acceptance seeds its own workspace in the testing runtime. No production path runs it.",
  },
};

function* sourceFiles(directory: string): Generator<string> {
  for (const entry of readdirSync(directory)) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      yield* sourceFiles(path);
    } else if (/\.(ts|tsx|mjs|js)$/.test(entry) && !/\.(test|spec)\./.test(entry) && !entry.endsWith(".d.ts")) {
      yield path;
    }
  }
}

/** The write statements in each non-test file that has any, keyed by its path from the repository root. */
function writesByFile(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const directory of SCANNED_DIRECTORIES) {
    for (const path of sourceFiles(join(ROOT, directory))) {
      const matches = readFileSync(path, "utf8").match(WRITE);
      if (matches) counts.set(relative(ROOT, path).split(sep).join("/"), matches.length);
    }
  }
  return counts;
}

test("only the listed files write provider connections", () => {
  const unexpected = [...writesByFile().keys()].filter((file) => !(file in EXPECTED_WRITERS));
  assert.deepEqual(unexpected, [], "A new writer of provider_connections must be listed in EXPECTED_WRITERS, with its reason.");
});

test("each listed writer has the number of write statements it is listed for", () => {
  const found = writesByFile();
  for (const [file, expected] of Object.entries(EXPECTED_WRITERS)) {
    assert.equal(found.get(file) ?? 0, expected.count, `${file} changed how many statements write provider_connections`);
  }
});
