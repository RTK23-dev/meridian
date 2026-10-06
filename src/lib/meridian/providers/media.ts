import { createHash } from "node:crypto";

export type ImageResult =
  | {
      status: "ready";
      provider: string;
      model: string;
      prompt: string;
      promptVersion: string;
      objectKey: string;
      bytes: Uint8Array;
      mediaType: string;
      width: number;
      height: number;
      sha256: string;
      latencyMs: number;
      costCents: number | null;
    }
  | { status: "failed"; provider: string; error: string };

export type ImageProvider = {
  id: "test:image" | "xai" | "unconfigured";
  generate: (input: { prompt: string; seed: string; promptVersion: string }) => ImageResult;
};

export type VideoStatus = "queued" | "submitted" | "processing" | "completed" | "failed";

export type VideoJob = {
  provider: "test:video";
  providerJobId: string;
  model: string;
  prompt: string;
  promptVersion: string;
  status: VideoStatus;
  objectKey: string;
  bytes: Uint8Array | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  transcript: string;
  scenes: { atMs: number; summary: string }[];
  error: string;
  attempts: number;
};

export function testImageProvider(allow: boolean, failuresLeft = 0): ImageProvider & { failuresLeft: number } {
  if (!allow) throw new Error("The test image provider is not enabled.");
  const state = { failuresLeft };
  return {
    id: "test:image",
    failuresLeft: state.failuresLeft,
    generate(input) {
      if (state.failuresLeft > 0) {
        state.failuresLeft -= 1;
        return { status: "failed", provider: "test:image", error: "The test image provider was scripted to fail." };
      }
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" data-provider="test:image"><title>${input.seed}</title></svg>`;
      const bytes = new TextEncoder().encode(svg);
      return {
        status: "ready",
        provider: "test:image",
        model: "test-image-v1",
        prompt: input.prompt,
        promptVersion: input.promptVersion,
        objectKey: `test/image/${input.seed}.svg`,
        bytes,
        mediaType: "image/svg+xml",
        width: 64,
        height: 64,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        latencyMs: 1,
        costCents: 0,
      };
    },
  };
}

/** A live image adapter is selected only when that vendor is configured. A text key is not an image model. */
export function selectImageProvider(env: { imageProvider?: string; xaiKey?: string }, allowTest: boolean): ImageProvider {
  if (env.imageProvider === "test:image") return testImageProvider(allowTest);
  if (env.xaiKey?.trim() && env.imageProvider === "xai") {
    return {
      id: "xai",
      generate() {
        return { status: "failed", provider: "xai", error: "The xAI image adapter must be called from the server. No image was invented." };
      },
    };
  }
  return {
    id: "unconfigured",
    generate() {
      return { status: "failed", provider: "unconfigured", error: "No image provider is configured. Nothing was generated." };
    },
  };
}

export function startTestVideo(input: { prompt: string; seed: string; promptVersion: string }, allow: boolean): VideoJob {
  if (!allow) throw new Error("The test video provider is not enabled.");
  return {
    provider: "test:video",
    providerJobId: `test:video:${input.seed}`,
    model: "test-video-v1",
    prompt: input.prompt,
    promptVersion: input.promptVersion,
    status: "queued",
    objectKey: "",
    bytes: null,
    durationMs: null,
    width: null,
    height: null,
    frameRate: null,
    transcript: "",
    scenes: [],
    error: "",
    attempts: 0,
  };
}

export function advanceTestVideo(job: VideoJob, allow: boolean): VideoJob {
  if (!allow || job.provider !== "test:video") throw new Error("The test video provider is not enabled.");
  if (job.status === "failed" || job.status === "completed") return job;
  const attempts = job.attempts + 1;
  if (job.status === "queued") return { ...job, status: "submitted", attempts };
  if (job.status === "submitted") return { ...job, status: "processing", attempts };
  const bytes = minimalMp4();
  return {
    ...job,
    status: "completed",
    attempts,
    objectKey: `test/video/${job.providerJobId}.mp4`,
    bytes,
    durationMs: 2500,
    width: 64,
    height: 64,
    frameRate: 24,
    transcript: job.prompt.slice(0, 280),
    scenes: [{ atMs: 0, summary: "Opens on the briefed product. Test provider only." }],
    error: "",
  };
}

export function runUntilSettled<T>(attempt: () => { ok: boolean; value?: T; error?: string }, maxAttempts = 3): { status: "ready"; value: T; attempts: number } | { status: "dead"; attempts: number; error: string } {
  let error = "The provider did not run.";
  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
    const result = attempt();
    if (result.ok && result.value !== undefined) return { status: "ready", value: result.value, attempts: attemptNumber };
    error = result.error || "The provider failed.";
  }
  return { status: "dead", attempts: maxAttempts, error };
}

function minimalMp4(): Uint8Array {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 32);
  bytes[4] = 109;
  bytes[5] = 118;
  bytes[6] = 104;
  bytes[7] = 100;
  view.setUint32(20, 1000);
  view.setUint32(24, 2500);
  return bytes;
}
