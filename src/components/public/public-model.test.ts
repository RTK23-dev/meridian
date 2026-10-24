import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { COMMITMENTS, CONCEPTS, PUBLIC_NAV, PUBLIC_PAGES, QUICKSTART, REPO_DOCS, WORKFLOW, repoDocUrl } from "./public-model.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string) => readFileSync(`${ROOT}${path}`, "utf8");

/** Every line a visitor reads, so one rule can check all of the copy. */
function allCopy(): string[] {
  return [
    ...WORKFLOW.flatMap((step) => [step.label, step.what]),
    ...COMMITMENTS,
    ...CONCEPTS.flatMap((concept) => [concept.term, concept.definition]),
    ...QUICKSTART.flatMap((step) => [step.title, step.body, step.command ?? ""]),
    ...REPO_DOCS.flatMap((doc) => [doc.label, doc.what]),
  ];
}

describe("the public site's navigation", () => {
  test("every public page has a route file, and every navigation link goes to a public page", () => {
    for (const path of PUBLIC_PAGES) {
      assert.ok(existsSync(`${ROOT}src/routes/${path.slice(1)}.tsx`), `src/routes/${path.slice(1)}.tsx exists for ${path}`);
    }
    for (const item of PUBLIC_NAV) {
      assert.ok((PUBLIC_PAGES as readonly string[]).includes(item.to), `${item.label} links to a listed public page`);
    }
  });

  test("the public pages sit outside the signed-in layout, so they need no account", () => {
    for (const path of PUBLIC_PAGES) {
      const source = read(`src/routes/${path.slice(1)}.tsx`);
      assert.doesNotMatch(source, /_app/, `${path} does not nest under the gated layout`);
    }
  });
});

describe("the workflow copy", () => {
  test("lists the eight steps of docs/PRODUCT.md, in the same order, with the same names", () => {
    assert.equal(WORKFLOW.length, 8);
    assert.equal(new Set(WORKFLOW.map((step) => step.id)).size, WORKFLOW.length, "step ids are unique");
    const product = read("docs/PRODUCT.md");
    let at = 0;
    for (const step of WORKFLOW) {
      const found = product.indexOf(`**${step.label}.**`, at);
      assert.ok(found >= 0, `docs/PRODUCT.md names the step "${step.label}" in order`);
      at = found + 1;
    }
  });
});

describe("the quickstart", () => {
  test("each step has a title and a body, and the ids are unique", () => {
    assert.equal(new Set(QUICKSTART.map((step) => step.id)).size, QUICKSTART.length);
    for (const step of QUICKSTART) {
      assert.ok(step.title.trim().length > 0, `${step.id} has a title`);
      assert.ok(step.body.trim().length > 0, `${step.id} has a body`);
    }
  });

  test("the address and the start command are the ones the dev server uses", () => {
    const install = QUICKSTART.find((step) => step.id === "install");
    assert.ok(install?.command?.includes("npm run dev"), "the install step starts with npm run dev");
    assert.match(read("scripts/dev.mjs"), /8080/, "the dev server listens on port 8080, as the quickstart says");
  });
});

describe("the copy claims nothing the product does not do", () => {
  test("no price, percentage, guarantee, testimonial or customer count appears in any copy", () => {
    const banned = [/\$/, /%/, /\bfree\b/i, /guarantee/i, /trusted by/i, /testimonial/i, /\d+\s*(customers|users|brands|teams)\b/i, /\b\d+x\b/i];
    for (const line of allCopy()) {
      for (const pattern of banned) {
        assert.doesNotMatch(line, pattern, `"${line}" makes no ${pattern.source} claim`);
      }
    }
  });

  test("the concepts are described in the docs' own terms", () => {
    const terms = CONCEPTS.map((concept) => concept.term);
    assert.equal(new Set(terms).size, terms.length, "each concept appears once");
    assert.ok(terms.includes("Brand brain"));
  });
});

describe("the reference links", () => {
  test("every repository doc the docs page links to exists on disk", () => {
    for (const doc of REPO_DOCS) {
      assert.ok(existsSync(`${ROOT}${doc.path}`), `${doc.path} exists`);
      assert.equal(repoDocUrl(doc.path).endsWith(`/blob/main/${doc.path}`), true, `${doc.path} links to its main-branch file`);
    }
  });
});
