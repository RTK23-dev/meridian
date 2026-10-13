import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  TEST_GLOBS,
  discoverTestFiles,
  globToRegExp,
  partitionFiles,
  testShard,
  verifyCoverage,
} from "./test-shard.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fakeFiles(weights) {
  return weights.map((weight, i) => ({
    path: `src/fake/file-${String(i).padStart(3, "0")}.test.ts`,
    weight,
  }));
}

test("the shard globs match test files and nothing else", () => {
  const scripts = globToRegExp(TEST_GLOBS.scripts);
  assert.ok(scripts.test("scripts/with-dotenv.test.mjs"));
  assert.ok(scripts.test("scripts/nested/deeper/check.test.mjs"));
  assert.ok(!scripts.test("scripts/test-shard.mjs"));
  assert.ok(!scripts.test("src/lib/a.test.mjs"));

  const src = globToRegExp(TEST_GLOBS.src);
  assert.ok(src.test("src/lib/meridian/blockers.test.ts"));
  assert.ok(!src.test("src/components/Panel.test.tsx"));
  assert.ok(!src.test("other/src/lib/a.test.ts"));

  assert.throws(() => globToRegExp("src/{a,b}.test.ts"), /not "\{"/);
});

test("the shard globs are the globs the test script runs", () => {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const globs = [...pkg.scripts.test.matchAll(/"([^"]*\*[^"]*)"/g)].map((match) => match[1]);
  assert.deepEqual(globs.sort(), Object.values(TEST_GLOBS).sort());
});

test("the CI test matrix lists every shard index exactly once", () => {
  const ci = readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
  const match = ci.match(/^\s*shard:\s*\[([^\]]*)\]/m);
  assert.ok(match, "ci.yml has a shard matrix");
  const indexes = match[1].split(",").map((value) => Number(value.trim()));
  assert.deepEqual(
    indexes,
    indexes.map((_, i) => i),
  );
});

test("the real test files split into shards that cover every file once", () => {
  for (const glob of Object.values(TEST_GLOBS)) {
    const files = discoverTestFiles(glob, repoRoot);
    assert.ok(files.length > 0, `${glob} matches test files`);
    for (let count = 1; count <= Math.min(8, files.length); count++) {
      verifyCoverage(partitionFiles(files, count), files);
    }
  }
});

test("the shards of the real test files together hold every file", () => {
  const count = 6;
  const shards = Array.from({ length: count }, (_, index) =>
    testShard({ group: "src", index, count, root: repoRoot }),
  );
  const all = shards.flatMap((shard) => shard.paths);
  assert.equal(all.length, shards[0].total);
  assert.equal(new Set(all).size, all.length);
  for (const shard of shards) assert.ok(shard.paths.length > 0);
});

test("partitioning does not depend on the order files are found in", () => {
  const files = fakeFiles([5, 1, 9, 9, 2, 7, 3, 3, 8, 4]);
  const forward = partitionFiles(files, 4);
  assert.deepEqual(partitionFiles([...files].reverse(), 4), forward);
  assert.deepEqual(partitionFiles(files, 4), forward);
});

test("every file lands in exactly one shard, and the shards stay balanced", () => {
  let seed = 7;
  const next = () => {
    seed = (seed * 16807) % 2147483647;
    return seed;
  };
  const files = fakeFiles(Array.from({ length: 101 }, () => 1 + (next() % 5000)));
  const largest = Math.max(...files.map((file) => file.weight));
  for (let count = 1; count <= 12; count++) {
    const shards = partitionFiles(files, count);
    verifyCoverage(shards, files);
    const bytes = shards.map((shard) => shard.bytes);
    assert.ok(Math.max(...bytes) - Math.min(...bytes) <= largest, `count ${count} is balanced`);
  }
});

test("verifyCoverage fails for a dropped file, a repeated file and an empty shard", () => {
  const files = fakeFiles([4, 3, 2, 1]);
  const [first, second] = partitionFiles(files, 2);

  const dropped = [{ ...first, paths: first.paths.slice(1) }, second];
  assert.throws(() => verifyCoverage(dropped, files), /is in no shard/);

  const repeated = [first, { ...second, paths: [...second.paths, first.paths[0]] }];
  assert.throws(() => verifyCoverage(repeated, files), /is in shard 0 and shard 1/);

  const tooManyShards = partitionFiles(files, 5);
  assert.throws(() => verifyCoverage(tooManyShards, files), /1 of 5 shards have no files/);
});

test("testShard rejects an index outside the count and an unknown group", () => {
  assert.throws(() => testShard({ group: "src", index: 6, count: 6 }), /from 0 to 5/);
  assert.throws(() => testShard({ group: "docs", index: 0, count: 2 }), /unknown group "docs"/);
});
