import { createHash } from "node:crypto";
import type {
  MultimodalPerceptionProvider,
  PerceptionBundle,
  PerceptionHealth,
  SceneObservation,
} from "./types.ts";

export class GeminiPerceptionProvider implements MultimodalPerceptionProvider {
  readonly id = "gemini_multimodal";
  readonly model: string;
  private fetchImpl: typeof fetch;

  constructor(
    model = process.env.PERCEPTION_MODEL || "gemini-2.5-flash",
    options?: { fetchImpl?: typeof fetch },
  ) {
    this.model = model;
    this.fetchImpl = options?.fetchImpl || globalThis.fetch;
  }

  private getApiKey(): string | undefined {
    return process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim();
  }

  async health(): Promise<PerceptionHealth> {
    const key = this.getApiKey();
    if (!key) {
      return {
        id: this.id,
        state: "NOT_CONFIGURED",
        detail: "GEMINI_API_KEY or GOOGLE_API_KEY is not set.",
      };
    }
    return {
      id: this.id,
      state: "HEALTHY",
      detail: `Gemini multimodal perception configured with model ${this.model}.`,
    };
  }

  async perceiveVideo(input: {
    artifactId: string;
    videoBytes?: Uint8Array;
    durationMs?: number;
    keyframes?: Array<{ sceneIndex: number; timestampMs: number; bytes: Uint8Array }>;
  }): Promise<PerceptionBundle> {
    const durationMs = input.durationMs ?? 0;
    const apiKey = this.getApiKey();

    if (!apiKey || !input.keyframes || input.keyframes.length === 0) {
      // Disconnected or no keyframes provided: return factual baseline with zero fabrication
      return {
        artifactId: input.artifactId,
        durationMs,
        scenes: [],
        transcriptSegments: [],
        capturedAt: new Date().toISOString(),
        provider: this.id,
        model: this.model,
      };
    }

    try {
      // Build multimodal contents for Gemini
      const imageParts = input.keyframes.map((kf) => ({
        inlineData: {
          mimeType: "image/jpeg",
          data: Buffer.from(kf.bytes).toString("base64"),
        },
      }));

      const promptText = `You are a factual video scene perception system. Analyze these ${imageParts.length} keyframe images in sequential order.
For each keyframe, return factual visual observations without editorial judgment.
Output a JSON array where each object has:
- index: integer (0 to ${imageParts.length - 1})
- shotType: "close_up" | "medium_shot" | "wide_shot" | "macro" | "screen_recording" | "unknown"
- presenterPresence: boolean
- facePresence: boolean
- productPresence: boolean
- setting: "indoor" | "outdoor" | "studio" | "vehicle" | "screen" | "unknown"
- motionIntensity: number between 0 and 1
- contrastRatio: number between 0 and 1
- typographyDensity: number between 0 and 1
- dominantColors: string[]
- ocrText: string (prominent visible text, or empty string)
Output ONLY the JSON array.`;

      const res = await this.fetchImpl(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [{ text: promptText }, ...imageParts],
              },
            ],
            generationConfig: {
              responseMimeType: "application/json",
              temperature: 0.1,
            },
          }),
        },
      );

      if (res.ok) {
        const data = (await res.json()) as {
          candidates?: Array<{
            content?: {
              parts?: Array<{ text?: string }>;
            };
          }>;
        };

        const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (rawText) {
          const parsed = JSON.parse(rawText) as Array<{
            index: number;
            shotType?: "close_up" | "medium_shot" | "wide_shot" | "macro" | "screen_recording" | "unknown";
            presenterPresence?: boolean;
            facePresence?: boolean;
            productPresence?: boolean;
            setting?: "indoor" | "outdoor" | "studio" | "vehicle" | "screen" | "unknown";
            motionIntensity?: number;
            contrastRatio?: number;
            typographyDensity?: number;
            dominantColors?: string[];
            ocrText?: string;
          }>;

          const scenes: SceneObservation[] = input.keyframes.map((kf, i) => {
            const sha256 = createHash("sha256").update(kf.bytes).digest("hex");
            const obs = parsed.find((p) => p.index === i) || parsed[i];
            return {
              sceneIndex: kf.sceneIndex,
              startMs: kf.timestampMs,
              endMs: kf.timestampMs + 2000,
              keyframeHash: sha256,
              visual: {
                shotType: obs?.shotType || "unknown",
                presenterPresence: obs?.presenterPresence,
                facePresence: obs?.facePresence,
                productPresence: obs?.productPresence,
                setting: obs?.setting || "unknown",
                motionIntensity: obs?.motionIntensity,
                contrastRatio: obs?.contrastRatio,
                typographyDensity: obs?.typographyDensity,
                dominantColors: obs?.dominantColors,
              },
              ocrText: obs?.ocrText || undefined,
              state: "OBSERVED",
              methodId: "gemini_visual_perception.v1",
              modelQualityEstimate: 0.85,
            };
          });

          return {
            artifactId: input.artifactId,
            durationMs,
            scenes,
            transcriptSegments: [],
            capturedAt: new Date().toISOString(),
            provider: this.id,
            model: this.model,
          };
        }
      }
    } catch {
      // Fall through to hash-only factual fallback if API call fails
    }

    const scenes: SceneObservation[] = input.keyframes.map((kf) => {
      const sha256 = createHash("sha256").update(kf.bytes).digest("hex");
      return {
        sceneIndex: kf.sceneIndex,
        startMs: kf.timestampMs,
        endMs: kf.timestampMs + 2000,
        keyframeHash: sha256,
        visual: {
          shotType: "unknown",
          facePresence: undefined,
          productPresence: undefined,
          setting: "unknown",
        },
        state: "INFERRED",
        methodId: "hash_keyframe_fallback.v1",
      };
    });

    return {
      artifactId: input.artifactId,
      durationMs,
      scenes,
      transcriptSegments: [],
      capturedAt: new Date().toISOString(),
      provider: this.id,
      model: this.model,
    };
  }
}

export const defaultPerceptionProvider = new GeminiPerceptionProvider();
