// The voice stage for a brief request (contract v8, lead decision 2026-10-17): the real voice handler speaks the written script of the brief,
// through the job's asset router (a fake here, its answer shaped as the router's done outcome), and the narration is transcribed and
// checked against the script. The speech-to-text is a recorded double whose words are the script's words, in the recorded shape; the
// loudness and the duration are measured on the test's bytes. The router's own speech path and the speech bill are tested in assets/.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ScriptBeat, WrittenScript } from "../../contracts/index.ts";
import { FIXTURE_IDS, productionRequestBriefFixture, voiceKitFixture, writtenScriptFixture, WORKSPACE_ID } from "../../contracts/fixtures/index.ts";
import { recordedSpeechToText, type RecordedSttFixture, type RecordedSttResponse } from "../../media/stt.ts";
import { depsWith } from "../../plan/test/helpers.ts";
import { readArtifact, writeArtifact } from "../artifact-store.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../test/pg-test-db.ts";
import type { EnginePayload, StageContext } from "../types.ts";
import { EngineError } from "../../contracts/index.ts";
import { createVoiceHandler, type VoiceStagePorts } from "./voice.ts";

const WS = WORKSPACE_ID;
const REQ = FIXTURE_IDS.request;
const RES = FIXTURE_IDS.reservation;
const NOW = "2026-10-17T10:00:00.000Z";
const DURATION_MS = 14000;
const BRIEF = { ...productionRequestBriefFixture, requestId: REQ, workspaceId: WS };
const SCRIPT: WrittenScript = { ...writtenScriptFixture, requestId: REQ };

let db: TestDatabase;
let requestArtifact: string;
let scriptArtifact: string;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, "brand_voice_brief");
  await db.sql`
    insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state)
    values (${REQ}, ${WS}, 'brand_voice_brief', 'fmt_fixture_rank', 'normal', 'running', '{}')
  `;
  requestArtifact = (await writeArtifact(db.sql, { organizationId: WS, requestId: REQ, stage: "intake", type: "production_request", body: BRIEF, createdAt: NOW })).artifactId;
  scriptArtifact = (await writeArtifact(db.sql, { organizationId: WS, requestId: REQ, stage: "write_script", type: "written_script", body: SCRIPT, createdAt: NOW })).artifactId;
});

after(async () => {
  await db.close();
});

/** The words the narration says, in the script's order, with times that cover the duration (seconds, as the vendor's raw answer). */
function narrationWords(beats: readonly ScriptBeat[]) {
  const tokens = beats.flatMap((beat) => (beat.text.match(/\S+/g) ?? []).map((word) => ({ word, beatId: beat.beatId })));
  const step = DURATION_MS / tokens.length;
  return tokens.map((token, index) => ({
    text: token.word,
    start: (index * step) / 1000,
    end: ((index + 1) * step) / 1000,
    confidence: 0.97,
  }));
}

/** The recorded speech-to-text answer of the narration: the script's words, as the vendor transcribed them. */
function recordedNarration(beats: readonly ScriptBeat[]): RecordedSttFixture {
  const response: RecordedSttResponse = { outcome: "ok", language: "en", words: narrationWords(beats), billedUsd: 0.0002 };
  return { provider: "recorded-stt", model: "recorded-narration", source: "synthetic", recordedAt: NOW, responses: [response] };
}

function ports(): { ports: VoiceStagePorts; routerCalls: Array<{ spec: { modelClass: string; prompt: string }; voiceId: string | null | undefined }> } {
  const routerCalls: Array<{ spec: { modelClass: string; prompt: string }; voiceId: string | null | undefined }> = [];
  const router = {
    async produce(input: { spec: { modelClass: string; prompt: string }; voiceId?: string | null }) {
      routerCalls.push({ spec: input.spec, voiceId: input.voiceId });
      return {
        outcome: {
          status: "done" as const,
          asset: {
            providerId: "openrouter:recorded-tts",
            modelClass: "tts" as const,
            uri: "store://engine/narration-1.mp3",
            cacheKey: "sha256:narration",
            costUsd: 0.0031,
            cacheHit: false,
            savedUsd: 0,
            ledgerEntryId: null,
            generationId: "gen-narration-1",
            mediaType: "audio/mpeg",
            submits: 1,
          },
        },
        decisions: [],
        alerts: [],
        attempts: [],
      };
    },
  };
  const built = {
    router,
    speech: { status: "ready" as const, stt: recordedSpeechToText(recordedNarration(SCRIPT.beats)) },
    sttPricePerMinuteUsd: 0.0043,
    media: {
      probe: async () => ({ container: "mp3", videoCodec: null, audioCodec: "mp3", width: null, height: null, fps: null, durationMs: DURATION_MS, audioPresent: true, bytes: 3 }),
      loudness: async () => ({ integratedLufs: -16, truePeakDbtp: -1.5, loudnessRangeLu: 6 }),
    },
    loadAudio: async () => new Uint8Array([0x49, 0x44, 0x33]) as Uint8Array<ArrayBuffer>,
    voiceKit: async () => voiceKitFixture,
    claims: async () => [],
  } as unknown as Omit<VoiceStagePorts, "roles">;
  return { ports: built as VoiceStagePorts, routerCalls };
}

function contextFor(inputArtifactIds: string[]): StageContext {
  const payload: EnginePayload = {
    organizationId: WS,
    requestId: REQ,
    stage: "voice",
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
    jobId: "job_voice_brief",
    organizationId: WS,
    requestId: REQ,
    stage: "voice",
    subjectId: REQ,
    attempt: "1",
    payload,
    signal: new AbortController().signal,
  };
}

test("a brief's narration is spoken from its written script through the job's router, and the voice track names the script's words and beats", async () => {
  const { ports: base, routerCalls } = ports();
  const roles = await depsWith([], 4);
  const handler = createVoiceHandler({ ...base, roles: roles.deps } as VoiceStagePorts);
  const result = await handler.run(contextFor([requestArtifact, scriptArtifact]));
  assert.equal(result.kind, "done");
  if (result.kind !== "done") return;
  assert.equal(result.output.stage, "voice");
  assert.equal(result.output.gate.pass, true, JSON.stringify(result.output.gate.checks.filter((check) => !check.pass)));

  assert.equal(routerCalls.length, 1, "one speech call, through the router");
  assert.equal(routerCalls[0]?.spec.modelClass, "tts");
  assert.equal(routerCalls[0]?.spec.prompt.split(/\s+/).length, SCRIPT.beats.flatMap((beat) => beat.text.match(/\S+/g) ?? []).length, "the script's words are spoken");
  assert.equal(routerCalls[0]?.voiceId, voiceKitFixture.providerVoiceId, "in the page's voice");

  const voiceId = result.output.artifacts.voice;
  assert.ok(voiceId, "the voice track is written");
  const track = await readArtifact(db.sql, { organizationId: WS, artifactId: voiceId ?? "" });
  assert.equal(track.envelope.type, "voice_track");
  const body = track.envelope.body as { words: Array<{ text: string }>; beatSpans: Array<{ beatId: string }>; durationMs: number };
  assert.deepEqual(body.words.map((word) => word.text), SCRIPT.beats.flatMap((beat) => beat.text.match(/\S+/g) ?? []), "every word of the script, in order");
  assert.deepEqual(body.beatSpans.map((span) => span.beatId), SCRIPT.beats.map((beat) => beat.beatId), "every beat of the script has a span");
  assert.equal(body.durationMs, DURATION_MS);
});

test("a brief whose script is not written yet is refused: the voice stage does not speak an empty or guessed script", async () => {
  const { ports: base, routerCalls } = ports();
  const roles = await depsWith([], 4);
  const handler = createVoiceHandler({ ...base, roles: roles.deps } as VoiceStagePorts);
  await assert.rejects(handler.run(contextFor([requestArtifact])), (error: unknown) => error instanceof EngineError && error.kind === "internal");
  assert.equal(routerCalls.length, 0, "nothing is spoken");
});
