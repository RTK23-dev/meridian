/**
 * Turns the manual telemetry form's text fields into the payload recordTelemetryAction expects.
 * A blank optional field is left out (the server stores it as unknown), never sent as 0.
 * Required fields and the platform must be present. Validation is the same as before, except that
 * blank optional numbers are no longer coerced to 0.
 */

export type TelemetryFormFields = {
  platform: string;
  sourceType: "organic" | "paid" | "hybrid";
  creativeId: string;
  views: string;
  hookRetention3s: string;
  completionRate: string;
  engagements: string;
  shares: string;
  hookType: string;
  angle: string;
};

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

export type TelemetryParse = { ok: true; payload: TelemetryPayload } | { ok: false; message: string };

function optionalNumber(text: string, label: string): { ok: true; value: number | undefined } | { ok: false; message: string } {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: undefined };
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return { ok: false, message: `${label} must be a number.` };
  return { ok: true, value };
}

function requiredNumber(text: string, label: string): { ok: true; value: number } | { ok: false; message: string } {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, message: `${label} is required.` };
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return { ok: false, message: `${label} must be a number.` };
  return { ok: true, value };
}

export function parseTelemetryForm(fields: TelemetryFormFields): TelemetryParse {
  if (!fields.platform.trim()) return { ok: false, message: "Choose a platform." };
  const views = requiredNumber(fields.views, "Views");
  if (!views.ok) return views;
  const hookRetention = requiredNumber(fields.hookRetention3s, "3s hook retention");
  if (!hookRetention.ok) return hookRetention;
  const completion = optionalNumber(fields.completionRate, "Completion rate");
  if (!completion.ok) return completion;
  const engagements = optionalNumber(fields.engagements, "Engagements");
  if (!engagements.ok) return engagements;
  const shares = optionalNumber(fields.shares, "Shares");
  if (!shares.ok) return shares;
  return {
    ok: true,
    payload: {
      platform: fields.platform.trim(),
      sourceType: fields.sourceType,
      creativeId: fields.creativeId.trim() || undefined,
      views: views.value,
      hookRetention3s: hookRetention.value,
      completionRate: completion.value,
      engagements: engagements.value,
      shares: shares.value,
      hookType: fields.hookType.trim() || undefined,
      angle: fields.angle.trim() || undefined,
    },
  };
}
