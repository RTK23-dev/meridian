// Props for character.rig (Bible 9.2 `cartoon.rig`, 13 CharacterSheet): one SVG character, drawn by this template, not by a
// model (no generated pixels). The rig has named parts (head, brows, eyes, arms, five mouth shapes) and a fixed pose library.
// Props give the timing only: a pose and expression timeline, and a mouth timeline (visemes), both on the clip clock. Colours
// come from the style kit (Bible 13), so the character matches the page. The names below are the rig's own; a character
// sheet lists the subset it uses (plan/sources.ts checks that), and the component never draws a name it does not know.

import { z } from "zod";
import { msSchema, withDuration } from "../shared.ts";

/** The one rig this library draws. A character sheet names the rig it uses; only "bean.v1" exists in E5. */
export const RIG_IDS = ["bean.v1"] as const;
export const RIG_POSES = ["idle", "point", "shrug", "cheer", "think", "surprise"] as const;
export const RIG_EXPRESSIONS = ["neutral", "happy", "surprised", "annoyed"] as const;
export const RIG_VISEMES = ["closed", "open", "wide", "round", "teeth"] as const;
export const RIG_POSITIONS = ["left", "center", "right"] as const;

export const MAX_POSE_EVENTS = 24;
export const MAX_MOUTH_EVENTS = 400;

export type RigPose = (typeof RIG_POSES)[number];
export type RigExpression = (typeof RIG_EXPRESSIONS)[number];
export type RigViseme = (typeof RIG_VISEMES)[number];

export const poseEventSchema = z.object({
  atMs: msSchema,
  pose: z.enum(RIG_POSES),
  expression: z.enum(RIG_EXPRESSIONS).default("neutral"),
});
export type PoseEvent = z.infer<typeof poseEventSchema>;

export const mouthEventSchema = z.object({
  atMs: msSchema,
  shape: z.enum(RIG_VISEMES),
});
export type MouthEvent = z.infer<typeof mouthEventSchema>;

function inOrderInside(events: ReadonlyArray<{ atMs: number }>, durationMs: number): boolean {
  return events.every((event, index) => event.atMs < durationMs && (index === 0 || event.atMs >= events[index - 1].atMs));
}

export const propsSchema = withDuration({
  rigId: z.enum(RIG_IDS).default("bean.v1"),
  characterId: z.string().min(1).max(64).optional(),
  position: z.enum(RIG_POSITIONS).default("center"),
  poses: z.array(poseEventSchema).max(MAX_POSE_EVENTS).default([]),
  mouth: z.array(mouthEventSchema).max(MAX_MOUTH_EVENTS).default([]),
})
  .refine((props) => inOrderInside(props.poses, props.durationMs), {
    message: "poses must fall inside the clip, in time order",
    path: ["poses"],
  })
  .refine((props) => inOrderInside(props.mouth, props.durationMs), {
    message: "mouth shapes must fall inside the clip, in time order",
    path: ["mouth"],
  });

export type CharacterRigProps = z.infer<typeof propsSchema>;
