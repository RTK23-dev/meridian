// The Settings page's server functions for making a video from Claude Code. Any member may read the setup; a member may make or cancel a
// request (the role is checked again where the request is made, in requests.ts); a viewer can only look.

import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { asText, objectInput, requireMembership } from "../api-shared";
import { cancelRequest, createRequest, listRequests, requestPrompt } from "./requests.ts";
import { requeue, RUNNER_MODELS, runnerStatus } from "./queue.ts";
import { availableChoices, listVideoSkills } from "./skills.ts";
import { REQUEST_SOURCES, sourceAvailability, type RequestSource } from "./sources.ts";

const BRAND_LIMIT = 30;

function organizationOf(input: unknown): { organizationId: string; body: Record<string, unknown> } {
  const body = objectInput(input);
  const organizationId = asText(body.organizationId);
  if (!organizationId) throw new Error("organizationId is required.");
  return { organizationId, body };
}

/** What the Claude Code card shows: the skills on offer, each brand with the sources it has behind it, and the recent requests. */
export const getClaudeCodeSetup = createServerFn({ method: "GET" })
  .validator((input: unknown) => ({ organizationId: organizationOf(input).organizationId }))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "viewer");
    const brands = await sql<{ id: string; name: string }>`
      select id, name from brands where organization_id = ${data.organizationId} and deleted_at is null order by name limit ${BRAND_LIMIT}
    `;
    const withSources = await Promise.all(brands.map(async (brand) => ({ ...brand, sources: await sourceAvailability(sql, data.organizationId, brand.id) })));
    const requests = await listRequests(sql, data.organizationId);
    const now = new Date();
    return {
      runner: await runnerStatus(sql, data.organizationId, now),
      models: RUNNER_MODELS.map((model) => ({ id: model.id, label: model.label, plain: model.plain })),
      choices: availableChoices().map((choice) => ({ id: choice.id, label: choice.label, plain: choice.plain })),
      skills: listVideoSkills().map((skill) => ({ name: skill.name, description: skill.description, version: skill.version, files: skill.files.length })),
      brands: withSources,
      requests: requests.map((request) => ({ id: request.id, choice: request.choice, model: request.model, lastError: request.lastError, runnerName: request.runnerName, expired: new Date(request.expiresAt).getTime() <= now.getTime(), brandId: request.brandId, source: request.source, idea: request.idea, status: request.status, createdAt: request.createdAt, prompt: requestPrompt(request.id) })),
    };
  });

/** One click: records the request and returns the line to paste into Claude Code. */
export const createClaudeCodeRequest = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const { organizationId, body } = organizationOf(input);
    const source = asText(body.source) as RequestSource;
    if (!(REQUEST_SOURCES as readonly string[]).includes(source)) throw new Error("source must be gathered, factory or idea.");
    return { organizationId, brandId: asText(body.brandId) || null, source, choice: asText(body.choice), model: asText(body.model), idea: asText(body.idea) };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const membership = await requireMembership(sql, context.userId, data.organizationId, "member");
    return createRequest(sql, { organizationId: data.organizationId, userId: context.userId, role: membership.role, brandId: data.brandId, source: data.source, choice: data.choice, model: data.model, idea: data.idea });
  });

/** Cancels a request, so its line stops working. */
export const cancelClaudeCodeRequest = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const { organizationId, body } = organizationOf(input);
    const id = asText(body.id);
    if (!id) throw new Error("id is required.");
    return { organizationId, id };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const membership = await requireMembership(sql, context.userId, data.organizationId, "member");
    return { cancelled: await cancelRequest(sql, { organizationId: data.organizationId, role: membership.role, id: data.id }) };
  });

/** Queues a failed request again, as a fresh job for the runner. */
export const retryClaudeCodeRequest = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const { organizationId, body } = organizationOf(input);
    const id = asText(body.id);
    if (!id) throw new Error("id is required.");
    return { organizationId, id };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "member");
    return { queued: await requeue(sql, { organizationId: data.organizationId, id: data.id, now: new Date() }) };
  });
