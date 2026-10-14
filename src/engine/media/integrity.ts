// render_integrity (Bible 6.11 and 12.3): the rendered file, as ffprobe reports it, against the EDL it was rendered from.
// Pure. Unknown values fail: a null duration, size or limit is a failed check, never a pass (Bible 12).

import type { ProbeResult } from "../../../functions/ffmpeg/types.ts";
import { gateResultSchema, type GateCheck, type GateResult } from "../contracts/gate.ts";
import type { EditDecisionList } from "../contracts/edl.ts";
import { allChecksPass } from "../contracts/primitives.ts";
import { thresholds } from "../config/thresholds.ts";

export type IntegrityLimits = {
  /** Largest difference between the rendered and the EDL duration, in ms (Bible 6.11: 100 ms). */
  durationToleranceMs: number;
  /** The platform's file-size limit in bytes. Null until the owner sets it: the size check then fails (Bible 12). */
  platformMaxBytes: number | null;
};

export function integrityLimitsFromConfig(): IntegrityLimits {
  return {
    durationToleranceMs: thresholds.render.durationToleranceMs.value,
    platformMaxBytes: thresholds.render.platformMaxBytes,
  };
}

export type RenderIntegrityInput = {
  /** The rendered video's id (the gate's subject). */
  videoId: string;
  /** ffprobe's result for the rendered file. */
  probe: ProbeResult;
  /** The EDL the file was rendered from. */
  edl: Pick<EditDecisionList, "durationMs" | "width" | "height" | "fps">;
};

/** Checks the render against the EDL. Returns a GateResult for gate render_integrity, validated against the contract. */
export function checkRenderIntegrity(
  input: RenderIntegrityInput,
  limits: IntegrityLimits = integrityLimitsFromConfig(),
): GateResult {
  const { probe, edl } = input;
  const checks: GateCheck[] = [];

  checks.push({
    rule: "resolution",
    pass: probe.width === edl.width && probe.height === edl.height,
    ...(probe.width === null ? {} : { value: probe.width }),
    limit: edl.width,
    detail: `${probe.width ?? "unknown"}x${probe.height ?? "unknown"} against ${edl.width}x${edl.height}`,
  });

  const fpsPass = probe.fps !== null && probe.fps.num === edl.fps * probe.fps.den;
  checks.push({
    rule: "fps",
    pass: fpsPass,
    ...(probe.fps === null ? {} : { value: probe.fps.value }),
    limit: edl.fps,
    detail:
      probe.fps === null ? "frame rate unknown" : `frame rate ${probe.fps.num}/${probe.fps.den}`,
  });

  checks.push({
    rule: "video_codec_h264",
    pass: probe.videoCodec === "h264",
    detail: `video codec ${probe.videoCodec ?? "unknown"}`,
  });

  checks.push({
    rule: "audio_codec_aac",
    pass: probe.audioCodec === "aac",
    detail: `audio codec ${probe.audioCodec ?? "unknown"}`,
  });

  checks.push({
    rule: "audio_present",
    pass: probe.audioPresent,
    detail: probe.audioPresent ? "audio stream present" : "no audio stream",
  });

  const durationDiff =
    probe.durationMs === null ? null : Math.abs(probe.durationMs - edl.durationMs);
  checks.push({
    rule: "duration_matches_edl",
    pass: durationDiff !== null && durationDiff <= limits.durationToleranceMs,
    ...(durationDiff === null ? {} : { value: durationDiff }),
    limit: limits.durationToleranceMs,
    detail:
      probe.durationMs === null
        ? "rendered duration unknown"
        : `rendered ${probe.durationMs} ms against EDL ${edl.durationMs} ms`,
  });

  if (limits.platformMaxBytes === null) {
    checks.push({
      rule: "size_under_platform_limit",
      pass: false,
      detail:
        "the platform file-size limit is not set (null), so the size cannot be judged; the check fails",
    });
  } else if (probe.bytes === null) {
    checks.push({ rule: "size_under_platform_limit", pass: false, detail: "file size unknown" });
  } else {
    checks.push({
      rule: "size_under_platform_limit",
      pass: probe.bytes <= limits.platformMaxBytes,
      value: probe.bytes,
      limit: limits.platformMaxBytes,
    });
  }

  return gateResultSchema.parse({
    gate: "render_integrity",
    subjectId: input.videoId,
    pass: allChecksPass(checks),
    checks,
  });
}
