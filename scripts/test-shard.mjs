// Splits the test files that `npm test` runs into shards, so CI can run them in parallel.
//
// Each CI shard runs the same two commands as `npm test`, each given only that shard's files. Every job computes the
// same partition from the same checkout. Every call also checks that the shards cover each test file exactly once for
// the shard count it was given. A gap, an overlap or an empty shard fails the call, so no test file is skipped silently.
//
// Usage, from the repository root:
//   node scripts/test-shard.mjs --group <scripts|src> --index <i> --count <n>
// Prints the shard's test files to stdout, one per line, and a summary to stderr.

import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// These must match the globs in the `test` script of package.json.
// scripts/test-shard.test.mjs fails when they drift apart.
export const TEST_GLOBS = {
  scripts: "scripts/**/*.test.mjs",
  src: "src/**/*.test.ts",
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Only `*` and `**/` are supported, which is all the test globs use. Anything else throws, so a new glob cannot be
// misread silently.
export function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith("**/", i)) {
      source += "(?:.*/)?";
      i += 2;
    } else if (glob[i] === "*") {
      source += "[^/]*";
    } else if ("?[]{}()!+@|\\".includes(glob[i])) {
      throw new Error(`test-shard reads only * and **/ in globs, not "${glob[i]}" in ${glob}`);
    } else {
      source += glob[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

// Returns the files that match the glob, sorted by path. Each has a weight: its size in bytes, at least 1. The weight
// stands in for run time, because the repository keeps no per-file timings.
export function discoverTestFiles(glob, root = repoRoot) {
  const [baseDir, ...rest] = glob.split("/");
  if (!baseDir || /[*?[{]/.test(baseDir) || rest.length === 0) {
    throw new Error(`a test glob must start with a plain directory, like src/**/*.test.ts, not ${glob}`);
  }
  const pattern = globToRegExp(glob);
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const relative = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(relative);
      } else if (entry.isFile() && pattern.test(relative)) {
        const bytes = statSync(path.join(root, relative)).size;
        found.push({ path: relative, weight: Math.max(1, bytes) });
      }
    }
  };
  walk(baseDir);
  return found.sort((a, b) => compareText(a.path, b.path));
}

// Largest files first, each to the shard with the least weight so far. Ties go to the lowest shard index. The order of
// the input does not matter, so every job gets the same partition. Each shard's paths are sorted.
export function partitionFiles(files, count) {
  assertCount(count);
  const shards = Array.from({ length: count }, () => ({ paths: [], bytes: 0 }));
  const largestFirst = [...files].sort(
    (a, b) => b.weight - a.weight || compareText(a.path, b.path),
  );
  for (const file of largestFirst) {
    let target = 0;
    for (let i = 1; i < count; i++) {
      if (shards[i].bytes < shards[target].bytes) target = i;
    }
    shards[target].paths.push(file.path);
    shards[target].bytes += file.weight;
  }
  for (const shard of shards) shard.paths.sort(compareText);
  return shards;
}

// Throws unless the shards hold every file exactly once, and no shard is empty.
export function verifyCoverage(shards, files) {
  const problems = [];
  const owner = new Map();
  const emptyCount = shards.filter((shard) => shard.paths.length === 0).length;
  if (emptyCount > 0) {
    problems.push(
      `${emptyCount} of ${shards.length} shards have no files, because there are only ${files.length} test files`,
    );
  }
  shards.forEach((shard, index) => {
    for (const file of shard.paths) {
      if (owner.has(file)) {
        problems.push(`${file} is in shard ${owner.get(file)} and shard ${index}`);
      } else {
        owner.set(file, index);
      }
    }
  });
  const known = new Set(files.map((file) => file.path));
  for (const file of known) {
    if (!owner.has(file)) problems.push(`${file} is in no shard`);
  }
  for (const file of owner.keys()) {
    if (!known.has(file)) problems.push(`${file} is in a shard but was not discovered`);
  }
  if (problems.length > 0) {
    const detail = problems.join("\n  ");
    throw new Error(`test shards do not cover the test files exactly once:\n  ${detail}`);
  }
}

// Shard `index` of `count` for one group of test files, after checking that the whole split covers every file.
export function testShard({ group, index, count, root = repoRoot }) {
  const glob = TEST_GLOBS[group];
  if (!glob) {
    const known = Object.keys(TEST_GLOBS).join(", ");
    throw new Error(`unknown group "${group}"; expected one of ${known}`);
  }
  assertCount(count);
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error(`index ${index} must be an integer from 0 to ${count - 1} for count ${count}`);
  }
  const files = discoverTestFiles(glob, root);
  const shards = partitionFiles(files, count);
  verifyCoverage(shards, files);
  return { ...shards[index], total: files.length };
}

function assertCount(count) {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`count must be a positive integer, got ${count}`);
  }
}

function parseNumber(value, name) {
  if (value === undefined || !/^\d+$/.test(value)) {
    const got = value === undefined ? "nothing" : `"${value}"`;
    throw new Error(`${name} must be a whole number, got ${got}`);
  }
  return Number(value);
}

function parseOptions(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    if (!name?.startsWith("--") || argv[i + 1] === undefined) {
      throw new Error(`expected --name value pairs, got "${argv.slice(i).join(" ")}"`);
    }
    options[name.slice(2)] = argv[i + 1];
  }
  return options;
}

function main(argv) {
  const options = parseOptions(argv);
  const index = parseNumber(options.index, "--index");
  const count = parseNumber(options.count, "--count");
  const shard = testShard({ group: options.group, index, count });
  process.stdout.write(shard.paths.map((file) => `${file}\n`).join(""));
  const kib = Math.round(shard.bytes / 1024);
  const summary = `${shard.paths.length} of ${shard.total} files, ${kib} KiB`;
  process.stderr.write(`test-shard: ${options.group} shard ${index} of ${count}: ${summary}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`test-shard: ${error.message}`);
    process.exitCode = 1;
  }
}
