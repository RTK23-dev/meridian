// Props for chat.thread (Bible 9.2, screen_mock DM stories): a short chat. Each message is data: a side, its text, the
// time its bubble appears and an optional typing lead-in (three dots from atMs - typingMs). Messages appear in order,
// and each typing lead-in starts after the message before it, so the thread reads top to bottom on the clock. Text is
// drawn with textContent, never as markup (L8 and Bible 9.1).

import { z } from "zod";
import { msSchema, shortTextSchema, withDuration } from "../shared.ts";

export const SIDES = ["left", "right"] as const;
export const MAX_TYPING_MS = 3000;

export const chatMessageSchema = z.object({
  side: z.enum(SIDES),
  text: shortTextSchema(200),
  atMs: msSchema,
  typingMs: z.int().min(0).max(MAX_TYPING_MS).default(0),
});

export const propsSchema = withDuration({
  header: shortTextSchema(40).optional(),
  messages: z.array(chatMessageSchema).min(1).max(10),
})
  .refine((props) => props.messages.every((message) => message.atMs < props.durationMs), {
    message: "every message must appear inside the clip",
    path: ["messages"],
  })
  .refine(
    (props) => props.messages.every((message, index) => index === 0 || message.atMs >= props.messages[index - 1].atMs),
    { message: "messages must be in time order", path: ["messages"] },
  )
  .refine(
    (props) =>
      props.messages.every((message, index) => {
        if (message.typingMs === 0) {
          return true;
        }
        const typingStart = message.atMs - message.typingMs;
        return typingStart >= 0 && (index === 0 || typingStart >= props.messages[index - 1].atMs);
      }),
    { message: "a typing lead-in must start after the message before it and not before 0", path: ["messages"] },
  );

export type ChatThreadProps = z.infer<typeof propsSchema>;
