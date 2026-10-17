import assert from "node:assert/strict";
import { test } from "node:test";
import { EngineError, type ProductionRequest, type WrittenScript } from "../contracts/index.ts";
import { productionRequestBriefFixture, productionRequestFixture, writtenScriptEnvelopeFixture, writtenScriptFixture } from "../contracts/fixtures/index.ts";
import { isBriefRequest, scriptOf, writtenScriptOf, type ArtifactLike } from "./resolve.ts";

function refusedWith(kind: string, fragment: string): (error: unknown) => boolean {
  return (error) => error instanceof EngineError && error.kind === kind && error.message.includes(fragment);
}

test("a script request reads its own script, and no written script is read", () => {
  const script = scriptOf(productionRequestFixture, null);
  assert.equal(script.language, productionRequestFixture.script?.language);
  assert.deepEqual(script.beats, productionRequestFixture.script?.beats);
  assert.equal(isBriefRequest(productionRequestFixture), false);
});

test("a script request given a written script is an internal error, never a choice between the two", () => {
  assert.throws(() => scriptOf(productionRequestFixture, writtenScriptFixture), refusedWith("internal", "sends its own script"));
});

test("a brief request reads the written script, its language and its beats", () => {
  const script = scriptOf(productionRequestBriefFixture, writtenScriptFixture);
  assert.equal(script.language, writtenScriptFixture.language);
  assert.deepEqual(script.beats, writtenScriptFixture.beats);
  assert.equal(isBriefRequest(productionRequestBriefFixture), true);
});

test("a brief request with no written script yet is an internal error, never an empty or guessed script", () => {
  assert.throws(() => scriptOf(productionRequestBriefFixture, null), refusedWith("internal", "has no written script yet"));
});

test("a written script of another request is refused", () => {
  const other: WrittenScript = { ...writtenScriptFixture, requestId: "req_01K0000000000000000000OTHER" as WrittenScript["requestId"] };
  assert.throws(() => scriptOf(productionRequestBriefFixture, other), refusedWith("internal", "names request"));
});

test("the resolver returns copies, so a caller cannot change the stored beats", () => {
  const script = scriptOf(productionRequestBriefFixture, writtenScriptFixture);
  script.beats.pop();
  assert.equal(writtenScriptFixture.beats.length, 5);
});

test("writtenScriptOf finds the written script among a job's inputs and ignores other artifacts", () => {
  const request: ArtifactLike = { envelope: { type: "production_request", body: productionRequestBriefFixture, requestId: writtenScriptFixture.requestId } };
  const written: ArtifactLike = { envelope: { type: "written_script", body: writtenScriptFixture, requestId: writtenScriptFixture.requestId } };
  assert.deepEqual(writtenScriptOf([request, written], writtenScriptFixture.requestId), writtenScriptFixture);
  assert.equal(writtenScriptOf([request], writtenScriptFixture.requestId), null);
});

test("writtenScriptOf refuses a written script that does not parse, and never reads it as a script", () => {
  const broken: ArtifactLike = {
    envelope: { type: "written_script", body: { ...writtenScriptEnvelopeFixture.body, beats: [] }, requestId: writtenScriptFixture.requestId },
  };
  assert.throws(() => writtenScriptOf([broken], writtenScriptFixture.requestId), refusedWith("internal", "no longer matches its contract"));
});

test("writtenScriptOf refuses a written script of another request, and two written scripts", () => {
  const foreign: ArtifactLike = { envelope: { type: "written_script", body: writtenScriptFixture, requestId: "req_01K0000000000000000000OTHER" } };
  assert.throws(() => writtenScriptOf([foreign], writtenScriptFixture.requestId), refusedWith("invalid_input", "belongs to request"));
  const one: ArtifactLike = { envelope: { type: "written_script", body: writtenScriptFixture, requestId: writtenScriptFixture.requestId } };
  assert.throws(() => writtenScriptOf([one, one], writtenScriptFixture.requestId), refusedWith("internal", "more than one written script"));
});

test("the brief fixture carries no script of its own (the request type allows one or the other)", () => {
  const brief: ProductionRequest = productionRequestBriefFixture;
  assert.equal(brief.script, undefined);
  assert.notEqual(brief.brief, undefined);
});
