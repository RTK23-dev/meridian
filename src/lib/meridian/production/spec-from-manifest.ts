import type { CreativeManifest } from "../factory/creative-manifest.ts";
import type { CreativeSpec } from "./types.ts";

export type CreativeExecutionContext = {
  organizationId: string;
  brandId: string;
  title: string;
};

/** Deterministically projects an approved manifest into the provider contract. */
export function creativeSpecFromManifest(
  manifest: CreativeManifest,
  context: CreativeExecutionContext,
): CreativeSpec {
  if (manifest.brand.organizationId !== context.organizationId || manifest.brand.brandId !== context.brandId) {
    throw new Error("Creative manifest tenant does not match its execution context.");
  }
  const hookLine = manifest.hook?.text?.trim();
  if (!hookLine) throw new Error("Creative manifest has no approved hook.");
  if (!manifest.production?.provider || !manifest.production.model) {
    throw new Error("Creative manifest has no approved provider and model.");
  }
  const scenes = (manifest.scenes ?? []).map((scene, index) => ({
    index,
    description: scene.visualInstruction ?? scene.description,
    durationSeconds: scene.durationSeconds ?? 0,
    onScreenText: scene.onScreenText,
    voiceoverText: scene.scriptOrCaption,
    assetUrl: undefined,
  }));
  if (scenes.length === 0) throw new Error("Creative manifest has no approved scenes.");
  const script = manifest.narration ?? manifest.dialogue ?? scenes.map((scene) => scene.voiceoverText).filter(Boolean).join("\n");
  if (!script.trim()) throw new Error("Creative manifest has no approved script or scene dialogue.");

  return {
    id: manifest.creativeId,
    organizationId: context.organizationId,
    brandId: context.brandId,
    title: context.title,
    // A manifest projected here is a video deliverable: images and carousels have their own durable path (P4b-2).
    modality: "video",
    format: manifest.deliverableType ?? manifest.mode,
    aspectRatio: manifest.format.aspectRatio,
    durationTargetSeconds: manifest.format.targetDurationSeconds ?? scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0),
    hookLine,
    script,
    visualDirection: manifest.visualDirection,
    audioDirection: manifest.audioDirection,
    scenes,
    providerId: manifest.production.provider,
    modelId: manifest.production.model,
    assetIds: manifest.assets.map((asset) => asset.assetId),
  };
}
