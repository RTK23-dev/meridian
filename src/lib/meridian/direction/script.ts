// A directed script: the beat timeline a direction agent writes (framework 9 and 15). Each beat carries its voice line, its on-screen text,
// its picture, its sound and its link to the beat before, and the script declares its structure (its promise, loops, feeling, send
// trigger, rewatch device and, from codex version 2, its topic, job, lock-in, trust anchor, villain, ahas, rehooks and call to action) so
// the checks in attention.ts and craft.ts can test what the writer claims. A model's answer is untrusted until it parses.
//
// `directedScriptSchema` accepts a script with or without the version 2 fields, so older scripts still check; `directedScriptV2Schema`
// requires them, and is the answer contract of script_director@2.

import { z } from "zod";
import { beatRoleSchema } from "../../../engine/contracts/request.ts";
import {
  emotionIdSchema,
  formatIdSchema,
  hookFamilyIdSchema,
  lockInApproachSchema,
  rewatchDeviceIdSchema,
  shareTriggerIdSchema,
  trustAnchorTypeSchema,
  videoJobSchema,
  villainTypeSchema,
} from "./codex.ts";

export const BEAT_LINKS = ["but", "therefore", "and"] as const;
export const beatLinkSchema = z.enum(BEAT_LINKS);
export type BeatLink = z.infer<typeof beatLinkSchema>;

const BEAT_ID = /^b[0-9]{1,2}$/;
const beatIdSchema = z.string().regex(BEAT_ID, { message: "a beat id is b followed by a number, for example b1" });

export const directedBeatSchema = z.strictObject({
  beatId: beatIdSchema,
  role: beatRoleSchema,
  /** The words the voice speaks. Empty for a beat with no voice (a picture-only beat). */
  voice: z.string().max(600),
  /** The words on screen, drawn by code. Absent when the beat shows none. */
  onScreenText: z.string().max(160).optional(),
  /** What the picture shows: subject, action, framing. Never text to draw. */
  picture: z.string().max(400).optional(),
  /** A sound cue: an effect, a music change, or a silence (codex 2). */
  sound: z.string().max(120).optional(),
  /** How the beat follows the one before. The first beat has none. */
  link: beatLinkSchema.optional(),
  /** Words of the voice line to stress. Each must appear in the line. */
  emphasis: z.array(z.string().min(1).max(40)).max(6).optional(),
  /** The beat's planned length, when the writer sets it. Otherwise it is estimated from the voice at the voice's pace. */
  durationMs: z.int().positive().max(60_000).optional(),
});
export type DirectedBeat = z.infer<typeof directedBeatSchema>;

const v1Fields = {
  language: z.string().min(2).max(16),
  hookFamily: hookFamilyIdSchema,
  format: formatIdSchema,
  feeling: emotionIdSchema,
  sendTrigger: shareTriggerIdSchema,
  rewatchDevice: rewatchDeviceIdSchema,
  /** The hook's promise and the beat that pays it. */
  promise: z.strictObject({ text: z.string().min(1).max(200), paidByBeatId: beatIdSchema }),
  /** The questions the script opens, each with the beat that opens it and the beat that closes it. */
  loops: z.array(z.strictObject({ question: z.string().min(1).max(200), opensAt: beatIdSchema, closesAt: beatIdSchema })).max(6),
  beats: z.array(directedBeatSchema).min(2).max(20),
  /** Why the script is shaped as it is, in one paragraph. */
  rationale: z.string().min(1).max(1200),
};

const v2Fields = {
  /** The subject, in a few words: line 1 must name it (context first). */
  topic: z.string().min(1).max(80),
  /** The video's one job. */
  job: videoJobSchema,
  /** The lock-in zone: how the sentences after the hook keep the viewer, and the beat they are in. */
  lockIn: z.strictObject({ approach: lockInApproachSchema, beatId: beatIdSchema }),
  /** The proof the hook leans on, from the brief, or null when the brief gives none (it is never invented). */
  trustAnchor: z.strictObject({ type: trustAnchorTypeSchema, beatId: beatIdSchema }).nullable(),
  /** What the video argues against, or null when it has no villain. */
  villain: z.strictObject({ type: villainTypeSchema, text: z.string().min(1).max(160) }).nullable(),
  /** The non-obvious lightbulb moments, in order. */
  ahas: z.array(z.strictObject({ text: z.string().min(1).max(200), beatId: beatIdSchema })).max(4),
  /** The beats that rehook: a turn that opens a new loop. */
  rehooks: z.array(beatIdSchema).max(6),
  /** The call to action, for a video whose job is to convert; null otherwise. The keyword, when there is one, names the topic. */
  cta: z
    .strictObject({
      beatId: beatIdSchema,
      keyword: z
        .string()
        .regex(/^[A-Z0-9]{2,24}$/, { message: "a keyword is 2 to 24 capital letters or digits" })
        .optional(),
      offer: z.string().min(1).max(160),
    })
    .nullable(),
};

export const directedScriptSchema = z.strictObject({
  ...v1Fields,
  topic: v2Fields.topic.optional(),
  job: v2Fields.job.optional(),
  lockIn: v2Fields.lockIn.optional(),
  trustAnchor: v2Fields.trustAnchor.optional(),
  villain: v2Fields.villain.optional(),
  ahas: v2Fields.ahas.optional(),
  rehooks: v2Fields.rehooks.optional(),
  cta: v2Fields.cta.optional(),
});
export type DirectedScript = z.infer<typeof directedScriptSchema>;

/** The answer contract of script_director@2: every version 2 field is declared. */
export const directedScriptV2Schema = z.strictObject({ ...v1Fields, ...v2Fields });
export type DirectedScriptV2 = z.infer<typeof directedScriptV2Schema>;
