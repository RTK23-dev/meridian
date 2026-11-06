import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError } from "../contracts/errors.ts";
import { loadPrompt, promptId, promptPath } from "./load.ts";

// A shipped prompt version is immutable: an edit is a new version (Bible 11.3). This pin fails when the bytes of a shipped
// file change, so the change has to come with a new file and a new version.
const PINNED = {
  "segmenter@1": "sha256:a57745f3df2ca06a32a3e4168c7fa6ad4430afcbcd2d63fac8d6eaf4442fe39b",
  "variant_writer@1": "sha256:4c2aac567b21387d7e31cb972fdc59dc998f3c9b154c99f9af531a2256f891de",
  "variant_writer@2": "sha256:8a61f29242ff6f546ee1d8e078a818536a70f292fe4cd167ea8bf550ee2421f0",
  "scriptwriter@1": "sha256:e97b4e3426bc77af9e7221e8916c6c45267779d5ab3ab230a82bcd03502d867a",
  "model_chooser@1": "sha256:8e1b9bd1c4cffa8d532bae1053aa5d0f985415b9dbc6317f92e195fec84a3eb4",
  "scriptwriter@2": "sha256:ba5d1406721ea0a7d1d42d8bbde7734759c16c500b2a52acba80baea7f8c6710",
  "scriptwriter@3": "sha256:d4b896f608d624bee8574d1f505de11cab0069fd601191cff6dc1e8b00be25af",
  "cookbook_selector@1": "sha256:73fa74e0e72afbe1b806cf4ceab81ef74711e57ef4bbd8d5332a0e1d3aea1614",
  "shot_director@1": "sha256:2d905db024f035dc2d02f178c45620116a78db9a5689b8aa9a6e57782b286463",
  "pixel_crew@1": "sha256:2868179b6b95e02102a015f7179c5f9c3781bb377675831bf3b8e1caf15862d6",
  "orchestrator_plan@5": "sha256:72f3e50a14d2536806a5257a9db7f787118677bd0bfbb09553f7bd8a3514db1f",
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
