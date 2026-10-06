import { z } from "zod";

const text = (maximum: number) => z.string().trim().max(maximum, `Must be ${maximum} characters or fewer.`).nullish().transform((value) => value ?? "");
const token = z.string().trim().max(48, "Must be 48 characters or fewer.").nullish().transform((value) => value ?? "").transform((value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40));
const sourceUrl = z.string().trim().max(500, "Source URL must be 500 characters or fewer.").nullish().transform((value) => value ?? "").transform((value, context) => {
  if (!value) return "";
  let parsed: URL;
  try { parsed = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`); }
  catch { context.addIssue({ code: "custom", message: "Enter a valid source URL." }); return z.NEVER; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    context.addIssue({ code: "custom", message: "Source URL must use http or https." });
    return z.NEVER;
  }
  return parsed.toString();
});

export const observationFieldsSchema = z.object({
  origin: z.enum(["competitor", "own"]),
  competitorId: text(80),
  angle: text(48),
  observedAngle: token,
  hookType: token,
  format: token,
  proofType: token,
  title: text(160),
  hook: z.string().trim().min(1, "Enter the opening hook.").max(400, "Hook must be 400 characters or fewer."),
  message: z.string().trim().min(1, "Enter what the creative says.").max(4000, "Message must be 4000 characters or fewer."),
  offer: text(400),
  cta: text(240),
  claim: text(400),
  platform: text(80),
  productName: text(160),
  sourceUrl,
}).superRefine((value, context) => {
  if (value.origin === "competitor" && !value.competitorId) context.addIssue({ code: "custom", path: ["competitorId"], message: "Choose the confirmed competitor." });
  if (value.observedAngle.length < 2 && value.angle.trim().length < 2) context.addIssue({ code: "custom", path: ["observedAngle"], message: "Choose an angle or name what you observed." });
});

export type ObservationFields = z.input<typeof observationFieldsSchema>;
export type ObservationFieldsOutput = z.output<typeof observationFieldsSchema>;
