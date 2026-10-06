import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ResearchSegment } from "./schema.ts";

const execFile = promisify(execFileCallback);
const MAX_VIDEO_BYTES = 80_000_000;
const MAX_AUDIO_BYTES = 24_000_000;

export type TranscriptionResult =
  | { status: "transcribed"; transcript: string; segments: ResearchSegment[]; provider: "local:whisperx"; model: string; contentHash: string; durationMs: number | null }
  | { status: "no_speech"; transcript: ""; segments: []; provider: "local:whisperx"; model: string; contentHash: string; durationMs: number | null }
  | { status: "NOT_CONNECTED"; error: string; contentHash: string }
  | { status: "failed"; error: string; contentHash: string };

export type AudioExtractor = (videoBytes: Uint8Array, ffmpegPath?: string) => Promise<{ bytes: Uint8Array; durationMs: number | null }>;
export type LocalTranscriber = (audioBytes: Uint8Array, options: { model: string; device: string; executable: string }) => Promise<unknown>;

async function runWhisperX(audioBytes: Uint8Array, options: { model: string; device: string; executable: string }): Promise<unknown> {
  const folder = await mkdtemp(join(tmpdir(), "meridian-whisperx-"));
  const audioPath = join(folder, "audio.mp3");
  await writeFile(audioPath, audioBytes);
  try {
    await execFile(options.executable, [audioPath, "--model", options.model, "--device", options.device, "--output_dir", folder, "--output_format", "json"], {
      timeout: 30 * 60_000, maxBuffer: 2 * 1024 * 1024,
    });
    return JSON.parse(await readFile(join(folder, "audio.json"), "utf8")) as unknown;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

export async function extractAudioWithFfmpeg(videoBytes: Uint8Array, ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg"): Promise<{ bytes: Uint8Array; durationMs: number | null }> {
  if (!videoBytes.byteLength || videoBytes.byteLength > MAX_VIDEO_BYTES) throw new Error("The video is empty or larger than 80 MB.");
  const folder = await mkdtemp(join(tmpdir(), "meridian-research-"));
  const input = join(folder, "source.mp4");
  const output = join(folder, "audio.mp3");
  try {
    await writeFile(input, videoBytes);
    let probe: string;
    try {
      const result = await execFile(process.env.FFPROBE_PATH || "ffprobe", [
        "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type", "-of", "csv=p=0", input,
      ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
      probe = result.stdout.trim();
    } catch {
      throw new Error("ffprobe is unavailable or the source video could not be inspected.");
    }
    if (!probe) throw new Error("The source video has no audio stream.");
    let durationMs: number | null = null;
    try {
      const result = await execFile(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", input], { timeout: 30_000, maxBuffer: 1024 * 1024 });
      const seconds = Number(result.stdout.trim());
      if (Number.isFinite(seconds) && seconds > 0) durationMs = Math.round(seconds * 1000);
    } catch { /* Duration is optional metadata; extraction still validates the media. */ }
    try {
      await execFile(ffmpegPath, ["-nostdin", "-v", "error", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-f", "mp3", output], { timeout: 120_000, maxBuffer: 1024 * 1024 });
    } catch {
      throw new Error("ffmpeg could not extract audio from the source video.");
    }
    const bytes = new Uint8Array(await readFile(output));
    if (!bytes.byteLength || bytes.byteLength > MAX_AUDIO_BYTES) throw new Error("Extracted audio is empty or larger than 24 MB.");
    return { bytes, durationMs };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

function transcriptSegments(body: unknown): { text: string; segments: ResearchSegment[] } {
  if (!body || typeof body !== "object") return { text: "", segments: [] };
  const result = body as { text?: unknown; segments?: unknown };
  const text = typeof result.text === "string" ? result.text.trim() : "";
  const segments = Array.isArray(result.segments) ? result.segments.flatMap((raw, index): ResearchSegment[] => {
    if (!raw || typeof raw !== "object") return [];
    const segment = raw as { text?: unknown; start?: unknown; end?: unknown };
    const line = typeof segment.text === "string" ? segment.text.trim() : "";
    if (!line) return [];
    const start = Number(segment.start);
    const end = Number(segment.end);
    return [{
      id: `t${index + 1}`,
      text: line,
      startMs: Number.isFinite(start) && start >= 0 ? Math.round(start * 1000) : null,
      endMs: Number.isFinite(end) && end >= start ? Math.round(end * 1000) : null,
      role: "unclear",
      confidence: 0.5,
    }];
  }) : [];
  if (segments.length === 0 && text) {
    return { text, segments: [{ id: "t1", text, startMs: null, endMs: null, role: "unclear", confidence: 0.5 }] };
  }
  return { text: text || segments.map((segment) => segment.text).join(" "), segments };
}

export async function transcribeVideo(
  videoBytes: Uint8Array,
  options: {
    env?: { WHISPERX_PATH?: string; WHISPERX_MODEL?: string; WHISPERX_DEVICE?: string; FFMPEG_PATH?: string };
    extractAudio?: AudioExtractor;
    transcribeLocal?: LocalTranscriber;
  } = {},
): Promise<TranscriptionResult> {
  const contentHash = createHash("sha256").update(videoBytes).digest("hex");
  const env = options.env ?? process.env;
  if (!videoBytes.byteLength || videoBytes.byteLength > MAX_VIDEO_BYTES) return { status: "failed", error: "The video is empty or larger than 80 MB.", contentHash };
  const model = env.WHISPERX_MODEL?.trim() || "small";
  const device = env.WHISPERX_DEVICE?.trim() || "cpu";
  const executable = env.WHISPERX_PATH?.trim() || "whisperx";
  try {
    const audio = await (options.extractAudio ?? extractAudioWithFfmpeg)(videoBytes, env.FFMPEG_PATH);
    if (!audio.bytes.byteLength || audio.bytes.byteLength > MAX_AUDIO_BYTES) throw new Error("Extracted audio is empty or larger than 24 MB.");
    const result = await (options.transcribeLocal ?? runWhisperX)(audio.bytes, { model, device, executable });
    const parsed = transcriptSegments(result);
    if (!parsed.text.trim()) return { status: "no_speech", transcript: "", segments: [], provider: "local:whisperx", model, contentHash, durationMs: audio.durationMs };
    return { status: "transcribed", transcript: parsed.text, segments: parsed.segments, provider: "local:whisperx", model, contentHash, durationMs: audio.durationMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { status: "NOT_CONNECTED", error: `${executable} is not installed or WHISPERX_PATH is incorrect. No transcript was created.`, contentHash };
    return { status: "failed", error: error instanceof Error ? error.message : "Transcription failed.", contentHash };
  }
}
