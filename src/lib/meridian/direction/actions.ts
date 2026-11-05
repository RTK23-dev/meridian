import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { chooseInputSchema, draftInputSchema, parseInput, reviseInputSchema, writeInputSchema } from "./input.ts";
import { askForRevision, askForScripts, chooseScript, directionPanelOf, directionSeatsOf } from "./service.ts";

// Direction scripts for a draft (the Create page's Scripts panel; the agent tools call the same service). Every function needs the
// admin role in the draft's workspace, which the service reads from the draft. Writing and revising queue a run that spends from the
// workspace's budget; reading and choosing spend nothing.

/** The draft's direction runs and scripts. */
export const getDirectionPanel = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(draftInputSchema, input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => directionPanelOf(await getSql(), context.userId, data));

/** The model in each direction seat for the draft's workspace, checked against the live catalogue now. */
export const getDirectionSeats = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(draftInputSchema, input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => directionSeatsOf(await getSql(), context.userId, data));

/** Queues a run that writes 1 to 4 script options to choose from. */
export const writeDirectionScripts = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(writeInputSchema, input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => askForScripts(await getSql(), context.userId, data));

/** Queues a revision of one script, with the person's note. */
export const reviseDirectionScript = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(reviseInputSchema, input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => askForRevision(await getSql(), context.userId, data));

/** Makes one script the draft's script lines. */
export const chooseDirectionScript = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(chooseInputSchema, input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => chooseScript(await getSql(), context.userId, data));
