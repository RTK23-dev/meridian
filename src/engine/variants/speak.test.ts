import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError, type ProductionRequest, type VoiceKit } from "../contracts/index.ts";
import { productionRequestFixture, voiceKitFixture } from "../contracts/fixtures/index.ts";
import type { VoiceOutcome, VoicePorts, VoiceRun } from "../voice/voice.ts";
import { variantScriptFor, variantSubjectOf } from "./work.ts";
import { scriptOf } from "../script/resolve.ts";
import { runVoiceOverPorts, speakVariantScript, type VariantSpeech, type VoiceRunner } from "./speak.ts";

const REQUEST = productionRequestFixture as ProductionRequest;
const SCRIPT = scriptOf(REQUEST, null);
const VOICE = voiceKitFixture as VoiceKit;
const CLAIMS = ["Makes four smoothies in under two minutes"];
const SUBJECT_HOOK = variantSubjectOf("hook:2");
const SUBJECT_PERSONA = variantSubjectOf("persona:persona_variant");

/** A runner that records each run. It never reaches a provider: it answers not connected. */
function recordingRunner(): { runner: VoiceRunner; runs: VoiceRun[]; portsSeen: (VoicePorts | undefined)[] } {
  const runs: VoiceRun[] = [];
  const portsSeen: (VoicePorts | undefined)[] = [];
  const runner: VoiceRunner = async (run, ports): Promise<VoiceOutcome> => {
    runs.push(run);
    portsSeen.push(ports);
    return { status: "not_connected", reason: "NOT_CONNECTED: recorded runner" };
  };
  return { runner, runs, portsSeen };
}

function speech(overrides: Partial<VariantSpeech> = {}): VariantSpeech {
  return {
    organizationId: "ws_speak",
    requestId: REQUEST.requestId,
    reservationId: "res_speak",
    attempt: 1,
    subject: SUBJECT_HOOK,
    request: REQUEST,
    language: SCRIPT.language,
    script: SCRIPT,
    voice: VOICE,
    claims: CLAIMS,
    lines: [{ beatId: "b1", text: "Your counter has been lying to you all along." }],
    ...overrides,
  };
}

describe("a variant speaks its full script (Bible 6.13, the deviation in variants/STATUS.md)", () => {
  it("speaks every beat of the master's script, with the new line in place of the beat it changed", async () => {
    const { runner, runs } = recordingRunner();
    await speakVariantScript(undefined, speech(), runner);
    assert.equal(runs.length, 1);
    const beats = runs[0]?.script.beats ?? [];
    assert.deepEqual(beats.map((beat) => beat.beatId), SCRIPT.beats.map((beat) => beat.beatId), "every beat is spoken");
    assert.equal(beats[0]?.text, "Your counter has been lying to you all along.", "the hook beat is the writer's line");
    assert.equal(beats[1]?.text, SCRIPT.beats[1]?.text, "the other beats are the master's own text");
  });

  it("speaks a language variant's lines in the variant's language", async () => {
    const { runner, runs } = recordingRunner();
    const lines = SCRIPT.beats.map((beat) => ({ beatId: beat.beatId, text: `DE ${beat.text}` }));
    await speakVariantScript(undefined, speech({ language: "de", lines, subject: variantSubjectOf("language:de") }), runner);
    assert.equal(runs[0]?.script.language, "de");
    assert.ok(runs[0]?.script.beats.every((beat) => beat.text.startsWith("DE ")));
  });

  it("speaks a persona's voice over the master's own text, with the persona's voice kit", async () => {
    const { runner, runs } = recordingRunner();
    const persona: VoiceKit = { ...VOICE, voiceId: "voice_variant", providerVoiceId: "variant-voice-id" };
    await speakVariantScript(undefined, speech({ voice: persona, lines: [], subject: SUBJECT_PERSONA }), runner);
    assert.equal(runs[0]?.voice.voiceId, "voice_variant");
    assert.deepEqual(runs[0]?.script.beats.map((beat) => beat.text), SCRIPT.beats.map((beat) => beat.text));
  });

  it("keeps an emphasis word only while the new text still contains it", () => {
    const beats = SCRIPT.beats.map((beat, index) => ({ ...beat, emphasis: ["lying"], text: index === 1 ? "The lying counter is full." : beat.text }));
    const script = { ...SCRIPT, beats };
    const built = variantScriptFor({ script, language: "en", lines: [{ beatId: "b1", text: "Your counter fooled you." }] });
    assert.deepEqual(built.beats[0]?.emphasis, []);
    assert.deepEqual(built.beats[1]?.emphasis, ["lying"]);
  });

  it("refuses a line for a beat the request does not have, and two lines for one beat, before any call", async () => {
    const { runner, runs } = recordingRunner();
    await assert.rejects(speakVariantScript(undefined, speech({ lines: [{ beatId: "b9", text: "x" }] }), runner), (error: unknown) => {
      return error instanceof EngineError && error.kind === "invalid_input";
    });
    await assert.rejects(
      speakVariantScript(undefined, speech({ lines: [{ beatId: "b1", text: "a" }, { beatId: "b1", text: "b" }] }), runner),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
    );
    assert.equal(runs.length, 0);
  });

  it("hands the kit, the claims and the variant's gate subject to the voice stage unchanged, and the ports as they are", async () => {
    const { runner, runs, portsSeen } = recordingRunner();
    const ports = { router: {} } as unknown as VoicePorts;
    await speakVariantScript(ports, speech(), runner);
    assert.equal(runs[0]?.voice, VOICE);
    assert.deepEqual(runs[0]?.claims, CLAIMS);
    assert.equal(runs[0]?.subjectId, SUBJECT_HOOK, "the gate of the call names the variant");
    assert.equal(portsSeen[0], ports, "the voice stage gets the ports it was given");
  });
});

describe("a variant's speech without ports (variants/speak.ts)", () => {
  it("the default voice runner refuses before any call when no speech route is wired", async () => {
    await assert.rejects(runVoiceOverPorts({} as VoiceRun, undefined), (error: unknown) => {
      return error instanceof EngineError && error.kind === "config" && error.message.startsWith("NOT_CONNECTED:");
    });
  });
});
