// Files that ship with the code are read on first use, beside the module or, in a bundle, at their path in the repository; and no module
// in src reads a file when it loads. A module-level read worked in the tests (they run from source) but failed in the web app's
// production bundle, where the file is not beside the chunk: it took down every server function of eleven app modules on the live
// site, the settings page among them.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import ts from "typescript";
import { COMPONENT_LIBRARY } from "./compose/components/index.ts";
import { motionKitSource } from "./compose/motion/kit.ts";
import { sourceFile } from "./source-file.ts";

/** The calls that touch the disk. Called at module level they run when the module is imported. */
const DISK_CALLS = new Set(["readFileSync", "readdirSync", "statSync", "existsSync", "readFile", "readdir"]);

/** Module-level disk calls in one file: calls that are not inside any function, method, getter or arrow. */
export function moduleLevelReads(fileName: string, text: string): string[] {
  const sourceFile_ = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node, insideFunction: boolean) => {
    const inside = insideFunction || ts.isFunctionLike(node);
    if (!inside && ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
      if (DISK_CALLS.has(name)) found.push(`${fileName}:${sourceFile_.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${name}`);
    }
    ts.forEachChild(node, (child) => visit(child, inside));
  };
  visit(sourceFile_, false);
  return found;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe("files that ship with the code", () => {
  it("are read beside the module when the code runs from source", () => {
    const read = sourceFile(import.meta.url, "./compose/motion/motion-kit.js", "src/engine/compose/motion/motion-kit.js");
    assert.equal(read(), readFileSync(new URL("./compose/motion/motion-kit.js", import.meta.url), "utf8"));
    assert.equal(read(), motionKitSource(), "the kit's own reader gives the same bytes");
  });

  it("are read at their path in the repository when the module runs from a bundle somewhere else", () => {
    const chunk = pathToFileURL(join(mkdtempSync(join(tmpdir(), "bundle-")), "_ssr", "runtime-abc.mjs")).href;
    const read = sourceFile(chunk, "./component.html", "src/engine/compose/components/cta.card/component.html");
    assert.match(read(), /data-composition-id="cta\.card"|cta/);
  });

  it("fail with the file's name when neither place has it, and only when read", () => {
    const chunk = pathToFileURL(join(mkdtempSync(join(tmpdir(), "bundle-")), "chunk.mjs")).href;
    const read = sourceFile(chunk, "./missing.html", "src/engine/no/such/file.html");
    assert.throws(() => read(), /src\/engine\/no\/such\/file\.html .*was not found/);
    assert.throws(() => sourceFile(chunk, "./x", "/etc/passwd"), /relative to the repository root/);
  });

  it("are read once", () => {
    const dir = mkdtempSync(join(tmpdir(), "once-"));
    const file = join(dir, "data.txt");
    writeFileSync(file, "first");
    const read = sourceFile(pathToFileURL(join(dir, "module.ts")).href, "./data.txt", "src/engine/source-file.ts");
    assert.equal(read(), "first");
    writeFileSync(file, "second");
    assert.equal(read(), "first");
  });

  it("include every component template, each at the repository path its definition names", () => {
    for (const [name, component] of Object.entries(COMPONENT_LIBRARY)) {
      const index = readFileSync(new URL(`./compose/components/${name}/index.ts`, import.meta.url), "utf8");
      assert.ok(index.includes(`"src/engine/compose/components/${name}/component.html"`), `${name} names its own template's repository path`);
      assert.ok(component.template.length > 0, `${name} has a template`);
    }
  });
});

describe("no module reads a file when it loads", () => {
  it("finds a module-level read, and passes a read inside a function or a getter", () => {
    assert.deepEqual(moduleLevelReads("a.ts", 'import { readFileSync } from "node:fs";\nexport const X = readFileSync(new URL("./x", import.meta.url));'), [
      "a.ts:2 readFileSync",
    ]);
    assert.deepEqual(moduleLevelReads("b.ts", 'export const c = { template: fs.readFileSync("./c.html") };'), ["b.ts:1 readFileSync"]);
    assert.deepEqual(moduleLevelReads("c.ts", 'export function f() { return readFileSync("./x"); }\nexport const o = { get t() { return readFileSync("./y"); } };\nexport const g = () => readFileSync("./z");'), []);
  });

  it("holds for every source file in src", () => {
    const root = new URL("..", import.meta.url).pathname;
    const reads = sourceFiles(root).flatMap((file) => moduleLevelReads(file.slice(root.length), readFileSync(file, "utf8")));
    assert.deepEqual(reads, [], "read these files on first use (src/engine/source-file.ts), never at module load");
  });
});
