// A directed script: the beat timeline a direction agent writes (framework 9 and 15). Each beat carries its voice line, its on-screen text,
// its picture and its link to the beat before, and the script declares its promise, its open loops, its feeling, its send trigger and its
// rewatch device, so the checks in attention.ts can test the structure the writer claims. The schema is the answer contract of the
// script_director prompt; a model's answer is untrusted until it parses.

import { z } from "zod";
import { beatRoleSchema } from "../../../engine/contracts/request.ts";
import { emotionIdSchema, formatIdSchema, hookFamilyIdSchema, rewatchDeviceIdSchema, shareTriggerIdSchema } from "./codex.ts";

export const BEAT_LINKS = ["but", "therefore", "and"] as const;
export const beatLinkSchema = z.enum(BEAT_LINKS);
export type BeatLink = z.infer<typeof beatLinkSchema>;

const BEAT_ID = /^b[0-9]{1,2}$/;

export const directedBeatSchema = z.strictObject({
  beatId: z.string().regex(BEAT_ID, { message: "a beat id is b followed by a number, for example b1" }),
  role: beatRoleSchema,
  /** The words the voice speaks. Empty for a beat with no voice (a picture-only beat). */
  voice: z.string().max(600),
  /** The words on screen, drawn by code. Absent when the beat shows none. */
  onScreenText: z.string().max(160).optional(),
  /** What the picture shows: subject, action, framing. Never text to draw. */
  picture: z.string().max(400).optional(),
  /** How the beat follows the one before. The first beat has none. */
  link: beatLinkSchema.optional(),
  /** Words of the voice line to stress. Each must appear in the line. */
  emphasis: z.array(z.string().min(1).max(40)).max(6).optional(),
  /** The beat's planned length, when the writer sets it. Otherwise it is estimated from the voice at the voice's pace. */
  durationMs: z.int().positive().max(60_000).optional(),
});
export type DirectedBeat = z.infer<typeof directedBeatSchema>;

export const directedScriptSchema = z.strictObject({
  language: z.string().min(2).max(16),
  hookFamily: hookFamilyIdSchema,
  format: formatIdSchema,
  feeling: emotionIdSchema,
  sendTrigger: shareTriggerIdSchema,
  rewatchDevice: rewatchDeviceIdSchema,
  /** The hook's promise and the beat that pays it. */
  promise: z.strictObject({ text: z.string().min(1).max(200), paidByBeatId: z.string().regex(BEAT_ID) }),
  /** The questions the script opens, each with the beat that opens it and the beat that closes it. */
  loops: z
    .array(z.strictObject({ question: z.string().min(1).max(200), opensAt: z.string().regex(BEAT_ID), closesAt: z.string().regex(BEAT_ID) }))
    .max(6),
  beats: z.array(directedBeatSchema).min(2).max(20),
  /** Why the script is shaped as it is, in one paragraph. */
  rationale: z.string().min(1).max(1200),
});
export type DirectedScript = z.infer<typeof directedScriptSchema>;
