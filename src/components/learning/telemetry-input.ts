/**
 * The manual telemetry form's rules and its payload. Numbers are read the way recordTelemetryAction reads them: a blank
 * optional field is left out (the server stores it as unknown, never as 0), and any other value must be a finite number
 * under Number(). Required fields and the platform must be present.
 */
import { z } from "zod";

export type TelemetryPayload = {
  platform: string;
  sourceType: "organic" | "paid" | "hybrid";
  creativeId?: string;
  views: number;
  hookRetention3s: number;
  completionRate?: number;
  engagements?: number;
  shares?: number;
  hookType?: string;
  angle?: string;
};

/** A required number. Blank is "required"; anything else must be a finite number under Number(). */
const requiredNumber = (label: string) => z.string().trim()
  .min(1, `${label} is required.`)
  .refine((value) => Number.isFinite(Number(value)), `${label} must be a number.`);

/** An optional number. Blank is allowed and is left out of the payload. */
const optionalNumber = (label: string) => z.string().trim()
  .refine((value) => value === "" || Number.isFinite(Number(value)), `${label} must be a number.`);

export const telemetryFormSchema = z.object({
  platform: z.string().trim().min(1, "Choose a platform."),
  sourceType: z.enum(["organic", "paid", "hybrid"]),
  creativeId: z.string().trim(),
  views: requiredNumber("Views"),
  hookRetention3s: requiredNumber("3s hook retention"),
  completionRate: optionalNumber("Completion rate"),
  engagements: optionalNumber("Engagements"),
  shares: optionalNumber("Shares"),
  hookType: z.string().trim(),
  angle: z.string().trim(),
});

export type TelemetryFormFields = z.input<typeof telemetryFormSchema>;

function numberOrUndefined(text: string): number | undefined {
  const trimmed = text.trim();
  return trimmed === "" ? undefined : Number(trimmed);
}

export function telemetryPayload(values: TelemetryFormFields): TelemetryPayload {
  return {
    platform: values.platform.trim(),
    sourceType: values.sourceType,
    creativeId: values.creativeId.trim() || undefined,
    views: Number(values.views.trim()),
    hookRetention3s: Number(values.hookRetention3s.trim()),
    completionRate: numberOrUndefined(values.completionRate),
    engagements: numberOrUndefined(values.engagements),
    shares: numberOrUndefined(values.shares),
    hookType: values.hookType.trim() || undefined,
    angle: values.angle.trim() || undefined,
  };
}
