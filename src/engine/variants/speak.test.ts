import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError, type ProductionRequest, type VoiceKit } from "../contracts/index.ts";
import { productionRequestFixture, voiceKitFixture } from "../contracts/fixtures/index.ts";
import type { VoiceOutcome, VoicePorts, VoiceRun } from "../voice/voice.ts";
import { changedRequestFor, speakChangedLines, type SpeakChangedRun } from "./speak.ts";

const request = productionRequestFixture as ProductionRequest;
const voice = voiceKitFixture as VoiceKit;

function run(overrides: Partial<SpeakChangedRun> = {}): SpeakChangedRun {
  return {
    organizationId: "ws_test",
    requestId: request.requestId,
    reservationId: "res_01JABCDEFGHJKMNPQRSTVWXYZ0",
    attempt: 1,
    subjectId: request.requestId,
    request,
    language: request.script.language,
    voice,
    claims: [],
    lines: [{ beatId: "b1", text: "Your counter has been lying to you all along." }],
    ...overrides,
  };
}

const NOT_RUN: VoiceOutcome = { status: "not_connected", reason: "NOT_CONNECTED: the runner was not expected to run" };

describe("the beat-scoped voice call of a variant (Bible 6.3, 6.13)", () => {
  it("speaks only the changed beat, in script order, with its new text", () => {
    const changed = changedRequestFor(run());
    assert.deepEqual(
      changed.script.beats.map((beat) => [beat.beatId, beat.text]),
      [["b1", "Your counter has been lying to you all along."]],
    );
    assert.equal(changed.constraints.maxMs, request.constraints.maxMs);
  });

  it("keeps an emphasis word only while the new text still contains it", () => {
    const changed = changedRequestFor(run({ lines: [{ beatId: "b1", text: "Your counter is lying again." }] }));
    assert.deepEqual(changed.script.beats[0]?.emphasis, ["lying"]);
    const dropped = changedRequestFor(run({ lines: [{ beatId: "b1", text: "Your counter misleads you." }] }));
    assert.deepEqual(dropped.script.beats[0]?.emphasis, []);
  });

  it("speaks in the language of the variant, which is what the voice stage transcribes against", () => {
    const changed = changedRequestFor(run({ language: "de", lines: [{ beatId: "b1", text: "Deine Arbeitsplatte lügt dich an." }] }));
    assert.equal(changed.script.language, "de");
  });

  it("refuses a line for a beat the request does not have, a beat with two lines, and an empty set, before anything is called", async () => {
    let called = false;
    const runner = async (): Promise<VoiceOutcome> => {
      called = true;
      return NOT_RUN;
    };
    const ports = {} as VoicePorts;
    await assert.rejects(
      speakChangedLines(ports, run({ lines: [{ beatId: "b9", text: "Not a beat." }] }), runner),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
    );
    await assert.rejects(
      speakChangedLines(ports, run({ lines: [{ beatId: "b1", text: "One." }, { beatId: "b1", text: "Two." }] }), runner),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
    );
    await assert.rejects(
      speakChangedLines(ports, run({ lines: [] }), runner),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
    );
    assert.equal(called, false);
  });

  it("hands the voice stage the changed request, the kit and the claims, and returns its outcome", async () => {
    const seen: VoiceRun[] = [];
    const ports = { marker: "ports" } as unknown as VoicePorts;
    const outcome: VoiceOutcome = { status: "done", gate: { gate: "voice", subjectId: request.requestId, pass: false, checks: [] }, track: null };
    const result = await speakChangedLines(
      ports,
      run({ claims: ["Makes four smoothies in under two minutes"] }),
      async (voiceRun, received) => {
        seen.push(voiceRun);
        assert.equal((received as unknown as { marker: string }).marker, "ports");
        return outcome;
      },
    );
    assert.equal(result, outcome);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0]?.request.script.beats.map((beat) => beat.beatId), ["b1"]);
    assert.deepEqual(seen[0]?.claims, ["Makes four smoothies in under two minutes"]);
    assert.equal(seen[0]?.voice.providerVoiceId, voice.providerVoiceId);
  });

  it("with no speech connection the real voice stage makes no call and reports NOT_CONNECTED", async () => {
    const ports = { speech: { status: "not_connected", reason: "no speech-to-text key" } } as unknown as VoicePorts;
    const outcome = await speakChangedLines(ports, run());
    assert.deepEqual(outcome, { status: "not_connected", reason: "no speech-to-text key" });
  });
});
