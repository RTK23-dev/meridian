// Props for screen.mock (Bible 9.2, screen_mock shots): a phone or desktop UI mock with one of three screens. The screen is a
// discriminated union, so each kind takes only its own data: a notification (an app name, a headline and a body), an app
// screen (a title and up to four labelled rows, with an optional picture) or a chat (up to six messages). Every string is
// data drawn with textContent (L8 and Bible 9.1). Pictures are image URIs only, and the compiler maps them to local assets.

import { z } from "zod";
import { imageUriSchema, msSchema, shortTextSchema, withDuration } from "../shared.ts";

export const DEVICES = ["phone", "desktop"] as const;
export const SCREENS = ["notification", "app", "chat"] as const;
export const MAX_APP_ROWS = 4;
export const MAX_CHAT_MESSAGES = 6;

const deviceSchema = z.enum(DEVICES).default("phone");

const notificationSchema = withDuration({
  device: deviceSchema,
  screen: z.literal("notification"),
  app: shortTextSchema(24),
  title: shortTextSchema(60),
  body: shortTextSchema(140).optional(),
  timeLabel: shortTextSchema(12).default("now"),
  iconUri: imageUriSchema.optional(),
  atMs: msSchema.default(0),
}).refine((props) => props.atMs < props.durationMs, {
  message: "the notification must arrive inside the clip",
  path: ["atMs"],
});

const appRowSchema = z.object({
  label: shortTextSchema(64),
  value: shortTextSchema(20).optional(),
});

const appSchema = withDuration({
  device: deviceSchema,
  screen: z.literal("app"),
  title: shortTextSchema(40),
  rows: z.array(appRowSchema).min(1).max(MAX_APP_ROWS),
  imageUri: imageUriSchema.optional(),
  atMs: msSchema.default(0),
  rowStepMs: z.int().min(60).max(600).default(220),
}).refine((props) => props.atMs < props.durationMs, {
  message: "the app screen must appear inside the clip",
  path: ["atMs"],
});

const chatMessageSchema = z.object({
  side: z.enum(["left", "right"]),
  text: shortTextSchema(160),
  atMs: msSchema,
});

const chatSchema = withDuration({
  device: deviceSchema,
  screen: z.literal("chat"),
  title: shortTextSchema(40).optional(),
  messages: z.array(chatMessageSchema).min(1).max(MAX_CHAT_MESSAGES),
})
  .refine((props) => props.messages.every((message) => message.atMs < props.durationMs), {
    message: "every message must appear inside the clip",
    path: ["messages"],
  })
  .refine((props) => props.messages.every((message, index) => index === 0 || message.atMs >= props.messages[index - 1].atMs), {
    message: "messages must be in time order",
    path: ["messages"],
  });

export const propsSchema = z.discriminatedUnion("screen", [notificationSchema, appSchema, chatSchema]);

export type ScreenMockProps = z.infer<typeof propsSchema>;
