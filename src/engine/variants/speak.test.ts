import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError, type ProductionRequest, type VoiceKit } from "../contracts/index.ts";
import { productionRequestFixture, voiceKitFixture } from "../contracts/fixtures/index.ts";
import type { VoiceOutcome, VoicePorts, VoiceRun } from "../voice/voice.ts";
import { callScopeOf, variantRequestFor, variantSubjectOf } from "./work.ts";
import { runVoiceOverPorts, scopedVoicePorts, speakVariantScript, type VariantSpeech, type VoiceRunner } from "./speak.ts";

const REQUEST = productionRequestFixture as ProductionRequest;
const VOICE = voiceKitFixture as VoiceKit;
const CLAIMS = ["Makes four smoothies in under two minutes"];
const SUBJECT_HOOK = variantSubjectOf("hook:2");
const SUBJECT_PERSONA = variantSubjectOf("persona:persona_variant");

/** A runner that records each run. It never reaches a provider: it answers not connected. */
function recordingRunner(): { runner: VoiceRunner; runs: VoiceRun[] } {
  const runs: VoiceRun[] = [];
  const runner: VoiceRunner = async (run): Promise<VoiceOutcome> => {
    runs.push(run);
    return { status: "not_connected", reason: "NOT_CONNECTED: recorded runner" };
  };
  return { runner, runs };
}

/** A router stub whose produce records the spec's seed. */
function routerStub(seeds: number[]): VoicePorts {
  return {
    router: {
      produce: async (input: { spec: { seed: number } }) => {
        seeds.push(input.spec.seed);
        return { outcome: { status: "not_connected", reason: "stub" } };
      },
    },
  } as unknown as VoicePorts;
}

function speech(overrides: Partial<VariantSpeech> = {}): VariantSpeech {
  return {
    organizationId: "ws_speak",
    requestId: REQUEST.requestId,
    reservationId: "res_speak",
    attempt: 1,
    subject: SUBJECT_HOOK,
    request: REQUEST,
    language: REQUEST.script.language,
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
    const beats = runs[0]?.request.script.beats ?? [];
    assert.deepEqual(beats.map((beat) => beat.beatId), REQUEST.script.beats.map((beat) => beat.beatId), "every beat is spoken");
    assert.equal(beats[0]?.text, "Your counter has been lying to you all along.", "the hook beat is the writer's line");
    assert.equal(beats[1]?.text, REQUEST.script.beats[1]?.text, "the other beats are the master's own text");
  });

  it("speaks a language variant's lines in the variant's language", async () => {
    const { runner, runs } = recordingRunner();
    const lines = REQUEST.script.beats.map((beat) => ({ beatId: beat.beatId, text: `DE ${beat.text}` }));
    await speakVariantScript(undefined, speech({ language: "de", lines, subject: variantSubjectOf("language:de") }), runner);
    assert.equal(runs[0]?.request.script.language, "de");
    assert.ok(runs[0]?.request.script.beats.every((beat) => beat.text.startsWith("DE ")));
  });

  it("speaks a persona's voice over the master's own text, with the persona's voice kit", async () => {
    const { runner, runs } = recordingRunner();
    const persona: VoiceKit = { ...VOICE, voiceId: "voice_variant", providerVoiceId: "variant-voice-id" };
    await speakVariantScript(undefined, speech({ voice: persona, lines: [], subject: SUBJECT_PERSONA }), runner);
    assert.equal(runs[0]?.voice.voiceId, "voice_variant");
    assert.deepEqual(runs[0]?.request.script.beats.map((beat) => beat.text), REQUEST.script.beats.map((beat) => beat.text));
  });

  it("keeps an emphasis word only while the new text still contains it", () => {
    const beats = REQUEST.script.beats.map((beat, index) => ({ ...beat, emphasis: ["lying"], text: index === 1 ? "The lying counter is full." : beat.text }));
    const request = { ...REQUEST, script: { ...REQUEST.script, beats } };
    const built = variantRequestFor({ request, language: "en", lines: [{ beatId: "b1", text: "Your counter fooled you." }] });
    assert.deepEqual(built.script.beats[0]?.emphasis, []);
    assert.deepEqual(built.script.beats[1]?.emphasis, ["lying"]);
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

  it("hands the kit and the claims to the voice stage unchanged", async () => {
    const { runner, runs } = recordingRunner();
    await speakVariantScript(undefined, speech(), runner);
    assert.equal(runs[0]?.voice, VOICE);
    assert.deepEqual(runs[0]?.claims, CLAIMS);
    assert.equal(runs[0]?.subjectId, SUBJECT_HOOK, "the gate of the call names the variant");
  });
});

describe("a variant's provider calls are scoped to the variant (variants/speak.ts)", () => {
  it("shifts the spec's seed by the variant's scope, so the same text in another voice is another cache entry", async () => {
    const seedsHook: number[] = [];
    const seedsPersona: number[] = [];
    const hook = scopedVoicePorts(routerStub(seedsHook), SUBJECT_HOOK);
    const persona = scopedVoicePorts(routerStub(seedsPersona), SUBJECT_PERSONA);
    await hook?.router.produce({ spec: { seed: 0 } } as Parameters<VoicePorts["router"]["produce"]>[0]);
    await persona?.router.produce({ spec: { seed: 0 } } as Parameters<VoicePorts["router"]["produce"]>[0]);
    assert.equal(seedsHook[0], callScopeOf(SUBJECT_HOOK));
    assert.equal(seedsPersona[0], callScopeOf(SUBJECT_PERSONA));
    assert.notEqual(seedsHook[0], seedsPersona[0]);
  });

  it("keeps a retake one seed step from the take before it, inside the variant's scope", async () => {
    const seeds: number[] = [];
    const scoped = scopedVoicePorts(routerStub(seeds), SUBJECT_HOOK);
    await scoped?.router.produce({ spec: { seed: 0 } } as Parameters<VoicePorts["router"]["produce"]>[0]);
    await scoped?.router.produce({ spec: { seed: 1 } } as Parameters<VoicePorts["router"]["produce"]>[0]);
    assert.equal((seeds[1] ?? 0) - (seeds[0] ?? 0), 1);
  });

  it("passes no ports when none are wired, so the voice runner refuses before any call", async () => {
    assert.equal(scopedVoicePorts(undefined, SUBJECT_HOOK), undefined);
    await assert.rejects(runVoiceOverPorts({} as VoiceRun, undefined), (error: unknown) => {
      return error instanceof EngineError && error.kind === "config" && error.message.startsWith("NOT_CONNECTED:");
    });
  });
});
