import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadPrompt } from "./load.ts";

// The model brief is a dated reference the orchestrator reads with its candidate list (owner direction 2026-10-23, B4). Its rules are
// checked here: each class has rows with a listing date and a price basis, a quality claim has a source, and the order it states holds.

const brief = loadPrompt({ role: "model_brief", version: 1 });
const CLASSES = ["Text: analysis and script steps", "Image: visual steps", "Speech: voice steps", "Video: video and avatar steps"];

/** The text of one section, from its heading to the next section heading. */
function sectionOf(heading: string): string {
  const start = brief.text.indexOf(`## ${heading}`);
  if (start === -1) throw new Error(`no section ${heading}`);
  const next = brief.text.indexOf("\n## ", start + 1);
  return brief.text.slice(start, next === -1 ? undefined : next);
}

/** The cells of each table row of a section, without the header and the divider. */
function rowsOf(section: string): string[][] {
  return section
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| Model |") && !line.startsWith("|---"))
    .map((line) => line.slice(2, -2).split(" | "));
}

describe("the model brief (owner direction 2026-10-23, B4)", () => {
  it("loads as model_brief@1 with the reading rules and a section for each class", () => {
    assert.equal(brief.id, "model_brief@1");
    for (const heading of ["How to read it", ...CLASSES, "What this brief does not decide"]) {
      assert.ok(brief.text.includes(`## ${heading}`), `missing the section ${heading}`);
    }
  });

  it("lists no Veo model, because the workspace policy switches the google/veo family off by default", () => {
    for (const heading of CLASSES) {
      for (const [model = ""] of rowsOf(sectionOf(heading))) {
        assert.doesNotMatch(model, /^google\/veo/, `${model} is in the list`);
      }
    }
  });

  it("gives every model a row of four cells: its id, its listing date, its price basis and its quality note", () => {
    for (const heading of CLASSES) {
      const rows = rowsOf(sectionOf(heading));
      assert.ok(rows.length > 0, `${heading} has rows`);
      for (const cells of rows) {
        const [model = "", listed = "", price = "", quality = ""] = cells;
        assert.equal(cells.length, 4, `${model} has four cells`);
        assert.match(model, /^[a-z0-9-]+\/[a-z0-9._-]+$/, `${model} is a vendor/model id`);
        assert.match(listed, /^\d{4}-\d{2}-\d{2}$/, `${model} has a listing date`);
        assert.ok(price.length > 0, `${model} has a price basis`);
        assert.ok(quality.length > 0, `${model} has a quality note`);
      }
    }
  });

  it("states a quality claim only with a source in its section: every other note is unverified", () => {
    for (const heading of CLASSES) {
      const section = sectionOf(heading);
      for (const [model = "", , , quality = ""] of rowsOf(section)) {
        if (quality === "unverified") continue;
        assert.ok(section.includes("https://"), `${model} is a quality claim, and its section gives no source`);
      }
    }
  });

  it("lists the sourced models first, then the rest newest first, as the reading rules say", () => {
    for (const heading of CLASSES) {
      const rows = rowsOf(sectionOf(heading));
      const firstUnsourced = rows.findIndex(([, , , quality = ""]) => quality === "unverified");
      if (firstUnsourced === -1) continue;
      assert.ok(
        rows.slice(firstUnsourced).every(([, , , quality = ""]) => quality === "unverified"),
        `${heading}: a sourced model comes after an unsourced one`,
      );
      const dates = rows.slice(firstUnsourced).map(([, listed = ""]) => listed);
      assert.deepEqual(dates, [...dates].sort().reverse(), `${heading}: the unsourced models are newest first`);
    }
  });
});
