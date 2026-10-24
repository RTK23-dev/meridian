// Server functions for content governance (prompt 18): pillars and cadence, quality rubrics and scores, and rights records. Each checks the
// request's shape here, then the service checks the role, the brand and the rules. Admins of the brand's workspace only.

import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import type { RubricCriterion } from "./governance.ts";
import {
  assignPillar,
  createPillar,
  createRightsRecord,
  createRubric,
  deletePillar,
  governanceOf,
  revokeRightsRecord,
  scoreVideo,
  setCadence,
  videoScoreOf,
} from "./governance-service.ts";

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function body(input: unknown): Record<string, unknown> {
  return (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
}

function brandIdOf(input: unknown): string {
  const brandId = text(body(input).brandId, 80);
  if (!brandId) throw new Error("Choose a brand.");
  return brandId;
}

function numberOrNullOf(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}

export const getContentGovernance = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({ brandId: brandIdOf(input) }))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => governanceOf(await getSql(), context.userId, data));

export const createContentPillar = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const values = body(input);
    return { brandId: brandIdOf(input), name: text(values.name, 200), targetShare: numberOrNullOf(values.targetShare) };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => createPillar(await getSql(), context.userId, data));

export const removeContentPillar = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const pillarId = text(body(input).pillarId, 80);
    if (!pillarId) throw new Error("Choose a pillar.");
    return { brandId: brandIdOf(input), pillarId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => deletePillar(await getSql(), context.userId, data));

export const setVideoPillar = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const values = body(input);
    const sessionId = text(values.sessionId, 80);
    if (!sessionId) throw new Error("Choose a video.");
    const pillarId = text(values.pillarId, 80);
    return { brandId: brandIdOf(input), sessionId, pillarId: pillarId || null };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => assignPillar(await getSql(), context.userId, data));

export const setContentCadence = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({ brandId: brandIdOf(input), videosPerWeek: numberOrNullOf(body(input).videosPerWeek) }))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => setCadence(await getSql(), context.userId, data));

export const createQualityRubric = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const values = body(input);
    const criteria = Array.isArray(values.criteria)
      ? values.criteria.flatMap((item): RubricCriterion[] => {
          const record = (item && typeof item === "object" ? item : {}) as { name?: unknown; weight?: unknown };
          return [{ name: text(record.name, 200), weight: typeof record.weight === "number" ? record.weight : Number.NaN }];
        })
      : [];
    return { brandId: brandIdOf(input), name: text(values.name, 200), criteria };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => createRubric(await getSql(), context.userId, data));

export const getVideoScore = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const sessionId = text(body(input).sessionId, 80);
    if (!sessionId) throw new Error("Choose a video.");
    return { sessionId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => videoScoreOf(await getSql(), context.userId, data));

export const scoreContentVideo = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const values = body(input);
    const sessionId = text(values.sessionId, 80);
    const rubricId = text(values.rubricId, 80);
    if (!sessionId || !rubricId) throw new Error("Choose a video and a rubric.");
    const raw = (values.scores && typeof values.scores === "object" ? values.scores : {}) as Record<string, unknown>;
    const scores: Record<string, number> = {};
    for (const [name, value] of Object.entries(raw)) scores[name.slice(0, 200)] = typeof value === "number" ? value : Number.NaN;
    return { sessionId, rubricId, scores };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => scoreVideo(await getSql(), context.userId, data));

export const createRights = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const values = body(input);
    const validUntil = text(values.validUntil, 10);
    const attachmentId = text(values.attachmentId, 80);
    return {
      brandId: brandIdOf(input),
      subject: text(values.subject, 400),
      holder: text(values.holder, 400),
      permittedUse: text(values.permittedUse, 1000),
      validUntil: validUntil || null,
      attachmentId: attachmentId || null,
    };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => createRightsRecord(await getSql(), context.userId, data));

export const revokeRights = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const recordId = text(body(input).recordId, 80);
    if (!recordId) throw new Error("Choose a rights record.");
    return { brandId: brandIdOf(input), recordId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => revokeRightsRecord(await getSql(), context.userId, data));
