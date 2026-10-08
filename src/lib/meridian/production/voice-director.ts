/**
 * Voice Direction Engine
 * 
 * Directs speech tempo, energy, and pause placement for short-form video:
 * 1. Requires real creator audio or verified consented synthetic voice
 * 2. Tunes energy and cadence per beat (hook high-energy vs conversational body)
 * 3. Enforces 140-180 WPM target and deliberate silence pauses
 */

export interface VoiceActorProfile {
  id: string;
  name: string;
  isSynthetic: boolean;
  licensingConsentId: string;
  naturalWpm: number;
  availableEmotions: string[];
}

export interface BeatVoiceInstruction {
  beatIndex: number;
  scriptText: string;
  energyLevel: "high_hook" | "conversational_peer" | "authoritative_payoff";
  tempoMultiplier: number; // 0.9 to 1.2
  prePauseSec: number;
  postPauseSec: number;
}

export interface DirectedVoiceoverPlan {
  voiceActorId: string;
  isConsented: boolean;
  totalWords: number;
  estimatedDurationSec: number;
  targetWpm: number;
  beatInstructions: BeatVoiceInstruction[];
  ssmlRepresentation: string;
}

export class VoiceDirector {
  /**
   * Builds a directed voiceover plan from beat script lines.
   */
  static buildVoicePlan(
    actor: VoiceActorProfile,
    beatLines: Array<{ beatIndex: number; text: string }>
  ): DirectedVoiceoverPlan {
    if (actor.isSynthetic && !actor.licensingConsentId) {
      throw new Error(`Synthetic voice "${actor.name}" lacks required licensing consent.`);
    }

    let totalWords = 0;
    const instructions: BeatVoiceInstruction[] = [];
    const ssmlParts: string[] = ["<speak>"];

    for (let i = 0; i < beatLines.length; i++) {
      const line = beatLines[i];
      const words = line.text.trim().split(/\s+/).filter(Boolean);
      totalWords += words.length;

      let energy: BeatVoiceInstruction["energyLevel"] = "conversational_peer";
      let tempo = 1.0;
      let prePause = 0.0;
      let postPause = 0.2;

      if (i === 0) {
        // Opening Hook Beat: High energy, punchy 1.1x tempo
        energy = "high_hook";
        tempo = 1.1;
        postPause = 0.3; // Dramatic pause after hook
      } else if (i === beatLines.length - 1) {
        // Final Payoff Beat: Grounded cadence, 0.4s pre-pause before CTA
        energy = "authoritative_payoff";
        tempo = 0.95;
        prePause = 0.4;
      }

      instructions.push({
        beatIndex: line.beatIndex,
        scriptText: line.text,
        energyLevel: energy,
        tempoMultiplier: tempo,
        prePauseSec: prePause,
        postPauseSec: postPause,
      });

      if (prePause > 0) {
        ssmlParts.push(`<break time="${Math.round(prePause * 1000)}ms"/>`);
      }
      ssmlParts.push(`<prosody rate="${Math.round(tempo * 100)}%">${line.text}</prosody>`);
      if (postPause > 0) {
        ssmlParts.push(`<break time="${Math.round(postPause * 1000)}ms"/>`);
      }
    }

    ssmlParts.push("</speak>");

    // Average duration estimate based on ~160 WPM baseline
    const estimatedDuration = (totalWords / 160) * 60;

    return {
      voiceActorId: actor.id,
      isConsented: Boolean(actor.licensingConsentId),
      totalWords,
      estimatedDurationSec: Number(estimatedDuration.toFixed(1)),
      targetWpm: 160,
      beatInstructions: instructions,
      ssmlRepresentation: ssmlParts.join(" "),
    };
  }
}
