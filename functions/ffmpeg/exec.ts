// Runs ffmpeg or ffprobe with an argument array (never a shell), a timeout and a bounded stdout. Every failure becomes a
// typed EngineError: a missing binary is config, a timeout is a retryable provider error, invalid media is invalid_input,
// and any other non-zero exit is a non-retryable provider error with the tail of stderr.

import { execFile, type ExecFileException } from "node:child_process";
import { EngineError } from "../../src/engine/contracts/errors.ts";
import { FFMPEG_LIMITS } from "./limits.ts";

export type Tool = "ffmpeg" | "ffprobe";

/** Binary locations. Undefined means the name is looked up on PATH. */
export type ToolPaths = { ffmpeg?: string; ffprobe?: string };

export type ToolOutput = { stdout: Buffer; stderr: string };

/** Stderr patterns that mean the input media is not usable (corrupt, empty or without the stream asked for). */
const INVALID_MEDIA_PATTERNS = [
  /Invalid data found/,
  /moov atom not found/,
  /matches no streams/,
  /does not contain any stream/,
  /could not find codec parameters/,
];

/** The tail of stderr for an error message, with temporary paths redacted (they are an implementation detail). */
export function stderrTail(stderr: string): string {
  const redacted = stderr.trim().replace(/\S*meridian-ffmpeg-[A-Za-z0-9]+\/?\S*/g, "<workdir>");
  return redacted.length > FFMPEG_LIMITS.stderrTailChars
    ? redacted.slice(-FFMPEG_LIMITS.stderrTailChars)
    : redacted;
}

/** Maps a failed tool run to a typed error. Pure, so the classification is testable without a process. */
export function classifyToolFailure(
  tool: Tool,
  failure: { code?: unknown; killed?: boolean },
  stderr: string,
  timeoutMs: number,
  stage: string,
): EngineError {
  if (failure.code === "ENOENT") {
    return new EngineError("config", `${tool} is not installed or not on PATH`, { stage });
  }
  if (failure.killed === true) {
    return new EngineError("provider", `${tool} timed out after ${timeoutMs} ms`, {
      retryable: true,
      stage,
    });
  }
  if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return new EngineError(
      "provider",
      `${tool} wrote more than ${FFMPEG_LIMITS.maxToolStdoutBytes} bytes`,
      { stage },
    );
  }
  if (INVALID_MEDIA_PATTERNS.some((pattern) => pattern.test(stderr))) {
    return new EngineError(
      "invalid_input",
      `${tool} could not read the media: ${stderrTail(stderr)}`,
      { stage },
    );
  }
  return new EngineError("provider", `${tool} failed: ${stderrTail(stderr) || "no error output"}`, {
    stage,
  });
}

/** Runs one tool. Resolves with stdout and stderr, or rejects with a typed EngineError. */
export function runTool(
  tool: Tool,
  args: readonly string[],
  options: { timeoutMs: number; stage: string; paths?: ToolPaths },
): Promise<ToolOutput> {
  const binary = options.paths?.[tool] ?? tool;
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      [...args],
      {
        timeout: options.timeoutMs,
        maxBuffer: FFMPEG_LIMITS.maxToolStdoutBytes,
        encoding: "buffer",
        windowsHide: true,
      },
      (error: ExecFileException | null, stdout: Buffer, stderr: Buffer) => {
        const stderrText = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr);
        if (error) {
          reject(classifyToolFailure(tool, error, stderrText, options.timeoutMs, options.stage));
          return;
        }
        resolve({
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout)),
          stderr: stderrText,
        });
      },
    );
  });
}
