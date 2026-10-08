import assert from "node:assert/strict";
import test from "node:test";
import { VoiceDirector, type VoiceActorProfile } from "./voice-director.ts";

test("VoiceDirector rejects synthetic voice without licensing consent ID", () => {
  const unconsentedSynthetic: VoiceActorProfile = {
    id: "synth-01",
    name: "AI Clone Sarah",
    isSynthetic: true,
    licensingConsentId: "",
    naturalWpm: 155,
    availableEmotions: ["energetic"],
  };

  assert.throws(
    () => {
      VoiceDirector.buildVoicePlan(unconsentedSynthetic, [{ beatIndex: 0, text: "Hello" }]);
    },
    /lacks required licensing consent/
  );
});

test("VoiceDirector shapes energy, prosody, and pauses across beats", () => {
  const consentedActor: VoiceActorProfile = {
    id: "creator-vo-1",
    name: "Marcus Authentic",
    isSynthetic: false,
    licensingConsentId: "contract-vo-555",
    naturalWpm: 160,
    availableEmotions: ["high_energy", "conversational"],
  };

  const plan = VoiceDirector.buildVoicePlan(consentedActor, [
    { beatIndex: 0, text: "Stop doing standard lunges right now!" },
    { beatIndex: 1, text: "Here is why your knees hurt every single leg day." },
    { beatIndex: 2, text: "Grab this band and fix your form in seconds." },
  ]);

  assert.equal(plan.beatInstructions.length, 3);
  // Beat 0: High energy hook with faster tempo and dramatic post-pause
  assert.equal(plan.beatInstructions[0].energyLevel, "high_hook");
  assert.equal(plan.beatInstructions[0].tempoMultiplier, 1.1);
  assert.equal(plan.beatInstructions[0].postPauseSec, 0.3);

  // Beat 2: Payoff / CTA with authoritative energy and pre-pause
  assert.equal(plan.beatInstructions[2].energyLevel, "authoritative_payoff");
  assert.equal(plan.beatInstructions[2].prePauseSec, 0.4);

  assert.ok(plan.ssmlRepresentation.includes("<speak>"));
  assert.ok(plan.ssmlRepresentation.includes('<break time="300ms"/>'));
});
