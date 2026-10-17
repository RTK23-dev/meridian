// analyze_reference for a brief request (lead decision 2026-10-17): a brief names no speech language, so the vendor detects it, and the DNA
// transcript names the language the transcription came back in. The speech and the segmenter are the recorded answers of the harness; the
// detected language is the recorded transcript's own.

import assert from "node:assert/strict";
import { test } from "node:test";
import { productionRequestBriefFixture } from "../contracts/fixtures/index.ts";
import { analyzeReference } from "./reference.ts";
import { genomeBody, referencePorts, referenceRun, segmenterBody } from "./test/harness.ts";

test("a brief's reference is analysed with the vendor's detected language, and the DNA transcript names it", async () => {
  const { ports } = await referencePorts({ responses: [segmenterBody, genomeBody] });
  const outcome = await analyzeReference(referenceRun({ request: productionRequestBriefFixture }), ports);
  assert.equal(outcome.status, "done");
  if (outcome.status !== "done") return;
  assert.equal(outcome.gate.pass, true, JSON.stringify(outcome.gate.checks.filter((check) => !check.pass)));
  assert.equal(outcome.dna?.transcript.language, "en", "the detected language is stored in the DNA transcript");
  assert.ok((outcome.dna?.transcript.words.length ?? 0) > 0, "the transcript's words are stored as before");
});

test("a script's reference keeps the script's language, and the DNA transcript names it too", async () => {
  const { ports } = await referencePorts({ responses: [segmenterBody, genomeBody] });
  const outcome = await analyzeReference(referenceRun(), ports);
  assert.equal(outcome.status, "done");
  if (outcome.status !== "done") return;
  assert.equal(outcome.dna?.transcript.language, "en");
});
