// Contract v8 (Bible section 4, v8 note): the request sends a script or a brief, the written script, the model choices artifact and
// the two new Claude roles. Refusals are in invalid.test.ts; this file checks what must be accepted, and the fixtures' agreement.

import assert from "node:assert/strict";
import test from "node:test";
import {
  ARTIFACT_TYPES,
  BRIEF_LIST_MAX,
  BRIEF_SOURCE_TEXT_MAX,
  BRIEF_TEXT_MAX,
  CLAUDE_ROLES,
  CONTRACTS_VERSION,
  envelopeSchema,
  ledgerEntrySchema,
  manifestRoleCallSchema,
  modelChoicesSchema,
  productionRequestSchema,
  shotSpecSchema,
  validatedRequestSchema,
  writtenScriptSchema,
  type ModelChoices,
  type ProductionRequest,
} from "./index.ts";
import {
  FIXTURE_IDS as ID,
  briefFixture,
  cartoonChainShotFixture,
  ledgerClaudeFixture,
  manifestRoleCallsFixture,
  modelChoicesFixture,
  modelChoicesEnvelopeFixture,
  productionRequestBriefFixture,
  productionRequestFixture,
  validatedRequestFixture,
  writtenScriptEnvelopeFixture,
  writtenScriptFixture,
} from "./fixtures/index.ts";

function edit<T>(base: T, change: (draft: any) => void): unknown {
  const draft = structuredClone(base);
  change(draft);
  return draft;
}

/** The paths and messages of a refused parse, so a test can name the field a refusal points at. */
function issuePaths(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }): string[] {
  return result.success ? [] : (result.error?.issues ?? []).map((issue) => issue.path.map(String).join("."));
}

test("a request sends its script or its brief: the script request and the brief request both parse", () => {
  assert.equal(productionRequestSchema.safeParse(productionRequestFixture).success, true);
  assert.equal(productionRequestSchema.safeParse(productionRequestBriefFixture).success, true);
  assert.equal(productionRequestBriefFixture.script, undefined, "the brief request carries no script");
  assert.ok(productionRequestBriefFixture.brief, "the brief request carries its brief");
});

test("a v7 request, with a script and no brief key, parses unchanged (the schema literal stays v1)", () => {
  assert.equal(productionRequestFixture.schema, "meridian.production_request/v1");
  assert.equal("brief" in productionRequestFixture, false, "a v7 request has no brief key");
  const parsed = productionRequestSchema.parse(productionRequestFixture);
  assert.deepEqual(parsed, productionRequestFixture);
  assert.equal("brief" in parsed, false, "parsing adds no brief key");
});

test("a request with both a script and a brief is refused, and the issue points at brief", () => {
  const both = edit(productionRequestFixture, (draft: ProductionRequest) => {
    draft.brief = briefFixture;
  });
  const result = productionRequestSchema.safeParse(both);
  assert.equal(result.success, false);
  assert.deepEqual(issuePaths(result), ["brief"]);
  assert.ok(!result.success && result.error.issues[0].message.includes("not both"), "the message says the request sends one of the two");
});

test("a request with neither a script nor a brief is refused, and the issue points at script", () => {
  const neither = edit(productionRequestFixture, (draft: ProductionRequest) => {
    delete draft.script;
  });
  const result = productionRequestSchema.safeParse(neither);
  assert.equal(result.success, false);
  assert.deepEqual(issuePaths(result), ["script"]);
});

test("the validated request of a brief request parses, and names the brief request", () => {
  const validated = { ...validatedRequestFixture, requestId: ID.briefRequest, request: productionRequestBriefFixture };
  const result = validatedRequestSchema.safeParse(validated);
  assert.equal(result.success, true, result.success ? "" : result.error.message);
  assert.equal(result.success && result.data.request.brief?.text, briefFixture.text);
});

test("a brief at its bounds parses: the text, the sources, the attachments and the notes at their maxima", () => {
  const atBounds = edit(productionRequestBriefFixture, (draft: ProductionRequest) => {
    draft.brief = {
      text: "t".repeat(BRIEF_TEXT_MAX),
      sources: Array.from({ length: BRIEF_LIST_MAX }, (_, index) => ({ label: `s${index}`, text: "x".repeat(BRIEF_SOURCE_TEXT_MAX) })),
      attachments: Array.from({ length: BRIEF_LIST_MAX }, () => ({ uri: "store://x/a.png", mediaType: "image/png", note: "n".repeat(500) })),
    };
  });
  assert.equal(productionRequestSchema.safeParse(atBounds).success, true);
});

test("a brief with no sources or attachments is valid: both lists may be empty", () => {
  const bare = edit(productionRequestBriefFixture, (draft: ProductionRequest) => {
    draft.brief = { text: "A reel about the blender.", sources: [], attachments: [] };
  });
  assert.equal(productionRequestSchema.safeParse(bare).success, true);
});

test("the brief fixture's sources and attachments are the ones the written script names", () => {
  const labels = new Set(briefFixture.sources.map((source) => source.label));
  for (const label of writtenScriptFixture.basedOn.sourceLabels) {
    assert.ok(labels.has(label), `${label} is a source of the brief`);
  }
  assert.equal(briefFixture.attachments.length, 1);
});

test("the written script is the brief request's script: same request, and beats in order with their roles", () => {
  assert.equal(writtenScriptFixture.requestId, productionRequestBriefFixture.requestId);
  assert.deepEqual(writtenScriptSchema.parse(writtenScriptFixture), writtenScriptFixture);
  assert.deepEqual(
    writtenScriptFixture.beats.map((beat) => beat.role),
    ["hook", "setup", "item", "proof", "cta"],
  );
  assert.equal(writtenScriptFixture.basedOn.videoDnaId, ID.dna);
});

test("the written script's beats may carry emphasis, and a beat with no emphasis key parses too", () => {
  const withoutEmphasis = edit(writtenScriptFixture, (draft: { beats: { emphasis?: string[] }[] }) => {
    delete draft.beats[1].emphasis;
  });
  assert.equal(writtenScriptSchema.safeParse(withoutEmphasis).success, true);
});

test("model choices: the same shot may carry two outputs, and the same output may name two shots", () => {
  const twoOutputs: ModelChoices = modelChoicesFixture;
  assert.equal(modelChoicesSchema.safeParse(twoOutputs).success, true);
  const sameOutputTwoShots = edit(modelChoicesFixture, (draft: ModelChoices) => {
    draft.choices[1] = { ...draft.choices[0], shotId: ID.shot3 };
  });
  assert.equal(modelChoicesSchema.safeParse(sameOutputTwoShots).success, true);
});

test("model choices: an empty list is a valid record that the request made no model choice", () => {
  const none = edit(modelChoicesFixture, (draft: ModelChoices) => {
    draft.choices = [];
  });
  assert.equal(modelChoicesSchema.safeParse(none).success, true);
});

test("model choices fixture: each choice names one call of the cartoon chain, with its output and model class", () => {
  const source = cartoonChainShotFixture.source;
  assert.equal(source.kind, "chain");
  if (source.kind !== "chain") return;
  assert.equal(modelChoicesFixture.choices.length, source.calls.length);
  for (const [index, call] of source.calls.entries()) {
    const choice = modelChoicesFixture.choices[index];
    assert.equal(choice.shotId, cartoonChainShotFixture.shotId);
    assert.equal(choice.output, call.output);
    assert.equal(choice.modelClass, call.modelClass);
    assert.notEqual(choice.modelChoice, null);
    assert.equal(choice.modelChoice.provider, "openrouter");
  }
});

test("model choices fixture: its choices name only the cartoon chain, which is a valid chain shot of the plan", () => {
  const shots = new Set(modelChoicesFixture.choices.map((choice) => choice.shotId));
  assert.deepEqual([...shots], [ID.shotCartoonChain]);
  assert.equal(shotSpecSchema.safeParse(cartoonChainShotFixture).success, true);
});

test("model choices: the envelope round-trips, and its type is model_choices", () => {
  assert.equal(modelChoicesEnvelopeFixture.type, "model_choices");
  assert.deepEqual(envelopeSchema(modelChoicesSchema).parse(modelChoicesEnvelopeFixture), modelChoicesEnvelopeFixture);
});

test("written script: the envelope round-trips, and its type is written_script", () => {
  assert.equal(writtenScriptEnvelopeFixture.type, "written_script");
  assert.deepEqual(envelopeSchema(writtenScriptSchema).parse(writtenScriptEnvelopeFixture), writtenScriptEnvelopeFixture);
});

test("the two artifact types are in the artifact type list, and no other type was added", () => {
  assert.ok((ARTIFACT_TYPES as readonly string[]).includes("written_script"));
  assert.ok((ARTIFACT_TYPES as readonly string[]).includes("model_choices"));
  assert.equal(ARTIFACT_TYPES.length, 17);
});

test("the two new roles are Claude roles: a ledger row and a manifest role call each parse with their own prompt version", () => {
  assert.ok((CLAUDE_ROLES as readonly string[]).includes("model_chooser"));
  assert.ok((CLAUDE_ROLES as readonly string[]).includes("scriptwriter"));
  assert.equal(ledgerClaudeFixture.role, "planner", "the fixture is the planner's row; the new roles are tested on their own rows");
  const chooser = edit(ledgerClaudeFixture, (draft: { role: string; promptVersion: string; model: string }) => {
    draft.role = "model_chooser";
    draft.promptVersion = "model_chooser@1";
  });
  assert.equal(ledgerEntrySchema.safeParse(chooser).success, true);
  const writer = edit(ledgerClaudeFixture, (draft: { role: string; promptVersion: string }) => {
    draft.role = "scriptwriter";
    draft.promptVersion = "scriptwriter@1";
  });
  assert.equal(ledgerEntrySchema.safeParse(writer).success, true);
  const call = { ...manifestRoleCallsFixture[1], role: "scriptwriter", promptVersion: "scriptwriter@1" };
  assert.equal(manifestRoleCallSchema.safeParse(call).success, true);
});

test("the contract set is engine-contracts@8 (the version the v8 note of Bible section 4 records)", () => {
  assert.equal(CONTRACTS_VERSION, "engine-contracts@8");
});
