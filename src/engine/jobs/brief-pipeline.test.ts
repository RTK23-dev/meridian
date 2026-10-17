// A brief request carried through the pipeline on fixtures (contract v8): analyze_reference, write_script, voice and plan, in the order the
// orchestrator queues them, with the artifact ids each stage really wrote. Three stages are the real handlers on recorded answers: the
// analysis (the harness's speech and segmenter answers), the scriptwriter (its recorded script) and the plan (the planner's and the
// director's recorded plan). Two things are fixtures, and each is said where it is used:
//   - voice: its track is built from the written script's words, on the fixture's beat spans. The voice stage's speech stack (router,
//     speech-to-text, loudness) is tested in voice/, and its harness is not shared;
//   - the plan's DNA: the fixture's, because the recorded planner answer names the shots of the fixture's reference segments. The
//     analysed DNA is what the orchestrator queues the plan with, and a plan on it needs a planner answer recorded on it (the live run).
// The identities are the fixtures' own (the recorded plan names shots by the fixture request's id). No test calls a live API. The
// orchestrator is the real one (advance), and each queued job must name the artifacts the stages wrote.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ProductionRequest, ScriptBeat, VoiceTrack, WrittenScript } from "../contracts/index.ts";
import { FIXTURE_IDS, productionRequestBriefFixture, videoDnaFixture, voiceTrackFixture, WORKSPACE_ID } from "../contracts/fixtures/index.ts";
import { referencePorts, segmenterBody, genomeBody } from "../analyze/test/harness.ts";
import { fixture, json } from "../claude/test/helpers.ts";
import { depsWith, fixtureKitBodies, recordedAnswer, validatedWithBudget } from "../plan/test/helpers.ts";
import { readArtifact, writeArtifact } from "./artifact-store.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { advance, type OrchestratorState } from "./orchestrator.ts";
import { createAnalyzeReferenceHandler } from "./handlers/analyze-reference.ts";
import { createWriteScriptHandler } from "./handlers/write-script.ts";
import { createPlanHandler } from "./handlers/plan.ts";
import type { ResolvedKits } from "./handlers/intake.ts";
import type { EngineEvent, EnginePayload, QueuedJob, StageContext, StageOutput } from "./types.ts";
import { validateStageOutput } from "./validate.ts";
import { scriptOf } from "../script/resolve.ts";

const REQ = FIXTURE_IDS.request;
const WS = WORKSPACE_ID;
const RES = FIXTURE_IDS.reservation;
const NOW = "2026-10-17T10:00:00.000Z";
const BRAND = "brand_brief_pipeline";

/** The brief request under the fixtures' identity: the recorded plan names its shots by this request id. */
const BRIEF: ProductionRequest = { ...productionRequestBriefFixture, requestId: REQ, workspaceId: WS };

let db: TestDatabase;
let briefArtifact: string;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, BRAND);
  await db.sql`
    insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state)
    values (${REQ}, ${WS}, ${BRAND}, 'fmt_fixture_rank', 'normal', 'running', '{}')
  `;
  briefArtifact = (
    await writeArtifact(db.sql, { organizationId: WS, requestId: REQ, stage: "intake", type: "production_request", body: BRIEF, createdAt: NOW })
  ).artifactId;
});

after(async () => {
  await db.close();
});

function contextOf(stage: string, inputArtifactIds: string[]): StageContext {
  const payload: EnginePayload = {
    organizationId: WS,
    requestId: REQ,
    stage: stage as EnginePayload["stage"],
    subjectId: REQ,
    attempt: "1",
    priority: "normal",
    budgetReservationId: RES,
    inputArtifactIds,
    hints: [],
    details: {},
  };
  return {
    sql: db.sql,
    jobId: `job_${stage}_brief`,
    organizationId: WS,
    requestId: REQ,
    stage: stage as StageContext["stage"],
    subjectId: REQ,
    attempt: "1",
    payload,
    signal: new AbortController().signal,
  };
}

/** The fixture kits (the persona's words per minute, the style and the product kit) the stages read. */
function kits(): ResolvedKits {
  const bodies = fixtureKitBodies();
  return { styleKit: bodies.styleKit, persona: bodies.persona, productKit: bodies.productKit, characters: bodies.characters, voice: undefined };
}

/**
 * The voice track of a script, for the stage's output. Its words are the written script's, spread over each beat's span. Its beat spans and
 * duration are the fixture's: the recorded plan was made on them, so the plan's timing is the fixture's (see the header). Its requestId is
 * the brief's.
 */
function voiceTrackOf(beats: ScriptBeat[]): VoiceTrack {
  let wordNumber = 0;
  const words: VoiceTrack["words"] = [];
  const beatSpans: VoiceTrack["beatSpans"] = [];
  for (const beat of beats) {
    const span = voiceTrackFixture.beatSpans.find((item) => item.beatId === beat.beatId);
    if (span === undefined) throw new Error(`the fixture voice has no span for beat ${beat.beatId}`);
    beatSpans.push({ beatId: span.beatId, startMs: span.startMs, endMs: span.endMs });
    const tokens = beat.text.match(/\S+/g) ?? [];
    const length = span.endMs - span.startMs;
    tokens.forEach((text, index) => {
      wordNumber += 1;
      words.push({
        wordId: `w${String(wordNumber).padStart(4, "0")}`,
        text,
        startMs: span.startMs + Math.round((index * length) / tokens.length),
        endMs: span.startMs + Math.round(((index + 1) * length) / tokens.length),
        confidence: 0.95,
      });
    });
  }
  return { ...voiceTrackFixture, requestId: REQ, audioUri: "store://voice/brief-pipeline.wav", words, beatSpans };
}

/** The written script as the stage stored it, read back through the artifact store (the resolver's own input). */
async function readWrittenScript(artifactId: string): Promise<WrittenScript> {
  const stored = await readArtifact(db.sql, { organizationId: WS, artifactId });
  return stored.envelope.body as WrittenScript;
}

test("a brief is carried through analyze, write_script, voice and plan, each stage on its real artifacts, and the orchestrator queues each next stage on them", async () => {
  // Start: the brief is queued for intake, and nothing else: write_script waits for the analysed reference.
  let state: OrchestratorState | null = null;
  let jobs: QueuedJob[] = [];
  const apply = (event: EngineEvent) => {
    const result = advance(state, event);
    state = result.state;
    jobs = result.jobs;
  };
  const succeed = (output: StageOutput) => apply({ type: "succeeded", output });
  const gateOf = (gate: "request" | "dna" | "voice") => ({ gate, subjectId: REQ, pass: true, checks: [{ rule: `${gate}.ok`, pass: true, value: 1 }] });
  apply({ type: "start", organizationId: WS, requestId: REQ, priority: "normal", cachedDna: false, variantCount: 0, requestArtifactId: briefArtifact, brief: true });
  assert.deepEqual(jobs.map((job) => job.stage), ["intake"]);
  succeed({ stage: "intake", subjectId: REQ, gate: gateOf("request"), budgetReservationId: RES, budgetPause: null, artifacts: { request: briefArtifact } });

  // 1. analyze_reference: the real handler on the recorded speech and segmenter answers. The reference's speech language is the one the test
  // gives: a brief has none, and production stops there (production-stages.test.ts).
  assert.deepEqual(jobs.map((job) => job.stage), ["analyze_reference"]);
  const analysis = await referencePorts({ responses: [segmenterBody, genomeBody] });
  const analysisRoles = await depsWith([json(200, segmenterBody), json(200, genomeBody)], 4);
  const analysisContext = contextOf("analyze_reference", [briefArtifact]);
  const analyzed = await createAnalyzeReferenceHandler({ ...analysis.ports, roles: analysisRoles.deps, speechLanguage: () => "en" }).run(analysisContext);
  assert.equal(analyzed.kind, "done");
  if (analyzed.kind !== "done") return;
  const analysisOutput = analyzed.output;
  if (analysisOutput.stage !== "analyze_reference") throw new Error(`the analysis answered for ${analysisOutput.stage}`);
  assert.equal(analysisOutput.gate.pass, true, JSON.stringify(analysisOutput.gate.checks.filter((check) => !check.pass)));
  const dnaId = analysisOutput.artifacts.dna;
  assert.ok(dnaId, "the analysis wrote the video DNA");
  assert.doesNotThrow(() => validateStageOutput(analyzed.output, analysisContext.payload));
  succeed(analyzed.output);

  // 2. write_script: queued after the analysis, with the brief and the DNA as its inputs. The real handler writes the script.
  assert.deepEqual(jobs.map((job) => job.stage), ["write_script"]);
  const writeInputs = jobs[0]?.payload.inputArtifactIds ?? [];
  assert.deepEqual(writeInputs, [briefArtifact, dnaId]);
  const writer = await depsWith([json(200, fixture("openrouter-scriptwriter-ok"))], 4);
  const writeContext = contextOf("write_script", writeInputs);
  const written = await createWriteScriptHandler({ loadKits: async () => kits(), roleDeps: () => writer.deps }).run(writeContext);
  assert.equal(written.kind, "done");
  if (written.kind !== "done") return;
  assert.doesNotThrow(() => validateStageOutput(written.output, writeContext.payload));
  const scriptId = written.output.artifacts.script;
  assert.ok(scriptId, "write_script names the written script");
  assert.equal(writer.requests.length, 1, "one scriptwriter call");
  succeed(written.output);

  // 3. voice: queued after the written script, reading the request and the script (a brief has no script of its own).
  assert.deepEqual(jobs.map((job) => job.stage), ["voice"]);
  assert.ok(jobs[0]?.payload.inputArtifactIds.includes(scriptId), "voice reads the written script");
  const script = scriptOf(BRIEF, await readWrittenScript(scriptId));
  const voice = await writeArtifact(db.sql, {
    organizationId: WS,
    requestId: REQ,
    stage: "voice",
    type: "voice_track",
    body: voiceTrackOf(script.beats),
    parentIds: [briefArtifact],
    createdAt: NOW,
  });
  succeed({ stage: "voice", subjectId: REQ, gate: gateOf("voice"), artifacts: { voice: voice.artifactId } });

  // 4. plan: queued after voice, reading the validated request, the DNA, the voice and the written script. The real handler runs on the
  // planner's and the director's recorded plan.
  assert.deepEqual(jobs.map((job) => job.stage), ["plan"]);
  const planInputs = jobs[0]?.payload.inputArtifactIds ?? [];
  for (const id of [dnaId, voice.artifactId, scriptId]) assert.ok(planInputs.includes(id), `plan reads ${id}`);
  const validated = await writeArtifact(db.sql, {
    organizationId: WS,
    requestId: REQ,
    stage: "intake",
    type: "validated_request",
    body: { ...validatedWithBudget(4), request: BRIEF },
    parentIds: [briefArtifact],
    createdAt: NOW,
  });
  const planner = await depsWith([recordedAnswer("openrouter-planner-ok"), recordedAnswer("openrouter-director-ok")], 4);
  // The plan runs on the fixture DNA, not the analysed one: the recorded planner answer names the shots of the fixture's reference segments,
  // and the segments the recorded segmenter gives differ, so that answer would not match (see the header). The orchestrator's queued plan
  // job above names the analysed DNA; the plan's own input is the fixture's.
  const fixtureDna = await writeArtifact(db.sql, { organizationId: WS, requestId: REQ, stage: "analyze_reference", type: "video_dna", body: videoDnaFixture, createdAt: NOW });
  const planned = await createPlanHandler({ loadKits: async () => kits(), roleDeps: () => planner.deps }).run(
    contextOf("plan", [validated.artifactId, fixtureDna.artifactId, voice.artifactId, scriptId]),
  );
  assert.equal(planned.kind, "done");
  if (planned.kind !== "done") return;
  assert.equal(planned.output.stage, "plan");
  const planId = planned.output.artifacts.plan;
  assert.ok(planId, "the plan is written as a scene_plan artifact");
  const plan = await readArtifact(db.sql, { organizationId: WS, artifactId: planId ?? "" });
  assert.equal(plan.envelope.type, "scene_plan");
  const beatIds = new Set(script.beats.map((beat) => beat.beatId));
  const shots = (plan.envelope.body as { shots: Array<{ beatId: string }> }).shots;
  assert.ok(shots.length > 0, "the plan has shots");
  assert.ok(shots.every((shot) => beatIds.has(shot.beatId)), "every shot is on a beat of the written script");
  assert.equal(planner.requests.length, 2, "the plan made its planner and director calls, and no classifier call (a brief names no beat)");
  assert.equal(FIXTURE_IDS.request, REQ);
});

test("the voice track built for a brief names the brief's request, carries every word of the written script, and keeps the fixture's spans", () => {
  const beats: ScriptBeat[] = [
    { beatId: "b1", role: "hook", text: "Your counter is full again." },
    { beatId: "b2", role: "cta", text: "Comment BLEND for the link." },
  ];
  const track = voiceTrackOf(beats);
  assert.equal(track.requestId, REQ);
  assert.deepEqual(track.beatSpans.map((span) => span.beatId), ["b1", "b2"]);
  const fixtureSpans = voiceTrackFixture.beatSpans.filter((span) => span.beatId === "b1" || span.beatId === "b2");
  assert.deepEqual(track.beatSpans, fixtureSpans, "the spans are the fixture's, because the recorded plan was made on them");
  assert.deepEqual(track.words.map((word) => word.text), ["Your", "counter", "is", "full", "again.", "Comment", "BLEND", "for", "the", "link."], "every word of the script, in order");
});
