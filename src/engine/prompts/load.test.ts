import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError } from "../contracts/errors.ts";
import { loadPrompt, promptId, promptPath } from "./load.ts";

// A shipped prompt version is immutable: an edit is a new version (Bible 11.3). This pin fails when the bytes of a shipped
// file change, so the change has to come with a new file and a new version.
const PINNED = {
  "segmenter@1": "sha256:a57745f3df2ca06a32a3e4168c7fa6ad4430afcbcd2d63fac8d6eaf4442fe39b",
} as const;

describe("prompt loading", () => {
  it("loads segmenter@1 with the four parts of Bible 11.2", () => {
    const prompt = loadPrompt({ role: "segmenter", version: 1 });
    assert.equal(prompt.id, "segmenter@1");
    assert.equal(prompt.version, 1);
    for (const heading of ["## Role and rules", "## Reference material", "## Task input", "## Output contract"]) {
      assert.match(prompt.text, new RegExp(`^${heading}$`, "m"), `missing ${heading}`);
    }
  });

  it("pins the bytes of each shipped version", () => {
    for (const [id, hash] of Object.entries(PINNED)) {
      const [role, version] = id.split("@");
      assert.equal(loadPrompt({ role: role ?? "", version: Number(version) }).fileHash, hash, `${id} changed: ship a new version instead`);
    }
  });

  it("names the file by role and version", () => {
    assert.equal(promptId({ role: "segmenter", version: 1 }), "segmenter@1");
    assert.match(promptPath({ role: "segmenter", version: 1 }), /prompts[\\/]segmenter@1\.md$/);
  });

  it("refuses a role or version that could name another file", () => {
    assert.throws(() => loadPrompt({ role: "../segmenter", version: 1 }), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
    assert.throws(() => loadPrompt({ role: "segmenter", version: 0 }), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
    assert.throws(() => loadPrompt({ role: "segmenter", version: 1.5 }), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
  });

  it("fails closed for a version with no file", () => {
    assert.throws(() => loadPrompt({ role: "segmenter", version: 99 }), (error: unknown) => error instanceof EngineError && error.kind === "config");
  });
});
