// The studio's review actions on plans and variants: approve and execute, reject, review, publish and the test performance
// record. Moved out of studio/session.server.ts unchanged (coding loop, T4).

import { getSql } from "../../db.ts";
import { applyLearnedPatterns } from "../learning/store.ts";
import { publishThrough } from "../providers/boundaries.ts";
import { testProviderPerformance } from "../providers/test-provider.ts";
import { claimAndRun } from "../jobs/sql-worker.ts";
import { decide } from "../jev/engine.ts";
import { publishingReadiness } from "../jev/guards.ts";
import { ruleDecisionRecordFields } from "../jev/decision-record.ts";
import { publishStudioHypitVideo } from "./hypit-run.ts";
import { assessPublishing } from "../publishing/readiness.ts";
import type { CreativePlan } from "../creative/plan.ts";
import { transitionCreativePlan } from "../creative/state-transition.server.ts";
import { accountSnapshots } from "./image-qc.server.ts";
import { isTestingRuntimeNow } from "../runtime-mode.ts";
import { loadSession, requireBrand } from "./session-load.server.ts";
import { executeApprovedCreativePlan } from "./session-execute.server.ts";

export async function approveAndExecuteCreativePlan(
  userId: string,
  data: { brandId: string; planId: string },
) {
  const sql = await getSql();
  const access = await requireBrand(sql, userId, data.brandId, "member");

  const existingPlans = await sql<{
    id: string;
    organization_id: string;
    brand_id: string;
    brief_id: string;
    version: string;
    status: string;
    scope: string;
    autonomy: string;
    objective: string;
    plan_payload: string;
    budget_reserved_usd: number;
    spend_cap_usd: number | null;
  }>`
    select * from creative_plans
    where id = ${data.planId} and brand_id = ${data.brandId} and organization_id = ${access.organizationId}
    limit 1
  `;

  const planRow = existingPlans[0];
  if (!planRow) {
    const existing = await sql<{ id: string; status: string }>`
      select id, status from creative_plans
      where id = ${data.planId} and brand_id = ${data.brandId} and organization_id = ${access.organizationId}
      limit 1
    `;
    if (!existing[0]) {
      throw new Error("Creative plan not found.");
    }
    if (existing[0].status === "executing") {
      throw new Error("Creative plan is currently executing.");
    }
    if (existing[0].status === "completed") {
      return loadSession(sql, access.organizationId, data.brandId, access.role);
    }
    if (existing[0].status === "abstained") {
      throw new Error("Cannot execute an abstained plan without choosing a format.");
    }
    if (existing[0].status === "rejected") {
      throw new Error("Cannot execute a rejected plan.");
    }
    if (existing[0].status === "failed") {
      throw new Error("Cannot execute a failed plan.");
    }
    if (existing[0].status === "draft") {
      throw new Error("Cannot execute a draft plan without preparation.");
    }
    throw new Error(`Creative plan is not awaiting approval (status: ${existing[0].status}).`);
  }

  // Load the brief
  const briefs = await sql<Record<string, unknown>>`
    select * from briefs
    where id = ${planRow.brief_id} and brand_id = ${data.brandId} and organization_id = ${access.organizationId}
    limit 1
  `;
  const brief = briefs[0];
  if (!brief) throw new Error("Brief associated with creative plan not found.");

  const planPayload: CreativePlan = typeof planRow.plan_payload === "string"
    ? JSON.parse(planRow.plan_payload)
    : planRow.plan_payload;

  await transitionCreativePlan(sql, {
    organizationId: access.organizationId,
    brandId: data.brandId,
    planId: data.planId,
    actorId: userId,
    target: "approved",
  });
  await transitionCreativePlan(sql, {
    organizationId: access.organizationId,
    brandId: data.brandId,
    planId: data.planId,
    actorId: userId,
    target: "executing",
  });
  return executeApprovedCreativePlan(sql, access, userId, planPayload);
}

export async function rejectCreativePlan(
  userId: string,
  data: { brandId: string; planId: string; reason?: string },
) {
  const sql = await getSql();
  const access = await requireBrand(sql, userId, data.brandId, "member");

  await transitionCreativePlan(sql, {
    organizationId: access.organizationId,
    brandId: data.brandId,
    planId: data.planId,
    actorId: userId,
    target: "rejected",
    reason: data.reason,
  });
  return loadSession(sql, access.organizationId, data.brandId, access.role);
}

export async function reviewStudioVariant(
  userId: string,
  data: { brandId: string; creativeId: string; action: string; reasonCode: string; note: string },
) {
  const context = { userId };
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "member");
    const rows = await sql<{ id: string; status: string }>`
      select id, status from creative_records
      where id = ${data.creativeId} and brand_id = ${data.brandId} and organization_id = ${access.organizationId}
      limit 1
    `;
    if (!rows[0]) throw new Error("Variant not found.");
    if (rows[0].status === "rejected" && data.action === "approve") throw new Error("Brand Guardian rejected this. Approval is not available.");
    const rejectedByQa = await sql<{ decision: string }>`
      select decision from jev_decisions
      where subject_id = ${data.creativeId} and organization_id = ${access.organizationId} and decision = 'REJECT'
      limit 1
    `;
    if (rejectedByQa[0] && data.action === "approve") throw new Error("Brand Guardian rejected this. Approval is not available.");
    if (data.action === "revision") {
      await sql`update assets set review_status = 'revision' where creative_id = ${data.creativeId} and organization_id = ${access.organizationId}`;
      await sql`
        update jev_decisions set reviewer_id = ${context.userId}, reviewer_decision = 'revision', reviewer_note = ${data.note}, reviewed_at = now()
        where subject_id = ${data.creativeId} and organization_id = ${access.organizationId}
      `;
      return loadSession(sql, access.organizationId, data.brandId, access.role);
    }
    const next = data.action === "approve" ? "approved" : "rejected";
    await sql`update creative_records set status = ${next}, updated_at = now() where id = ${data.creativeId}`;
    await sql`
      update assets set review_status = ${next}, lifecycle = ${next === "approved" ? "approved" : "rejected"}
      where creative_id = ${data.creativeId} and organization_id = ${access.organizationId}
    `;
    await sql`
      update reviews set status = ${next}
      where creative_id = ${data.creativeId} and organization_id = ${access.organizationId} and status = 'open'
    `;
    await sql`
      update jev_decisions set reviewer_id = ${context.userId}, reviewer_decision = ${data.action}, reviewer_note = ${data.note}, reviewed_at = now()
      where subject_id = ${data.creativeId} and organization_id = ${access.organizationId}
    `;
    if (data.action === "reject") {
      await sql`
        insert into rejections (id, organization_id, brand_id, creative_id, reason_code, note, rejected_by)
        values (${crypto.randomUUID()}, ${access.organizationId}, ${data.brandId}, ${data.creativeId}, ${data.reasonCode}, ${data.note}, ${context.userId})
      `;
    }
    return loadSession(sql, access.organizationId, data.brandId, access.role);
}

export async function publishStudioVariant(userId: string, data: { brandId: string; creativeId: string; publisher: string }) {
  const context = { userId };
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "member");
    const rows = await sql<{ status: string }>`
      select status from creative_records
      where id = ${data.creativeId} and brand_id = ${data.brandId} and organization_id = ${access.organizationId} and origin = 'generated'
      limit 1
    `;
    if (!rows[0]) throw new Error("Variant not found.");
    if (rows[0].status !== "approved") throw new Error("Publish only an approved asset.");
    const asset = await sql<{ mime_type: string; width: number | null; height: number | null; byte_size: number | null; kind: string }>`
      select mime_type, width, height, byte_size, kind from assets
      where creative_id = ${data.creativeId} and organization_id = ${access.organizationId}
      order by created_at desc limit 1
    `;
    const readiness = assessPublishing({
      accounts: await accountSnapshots(sql, access.organizationId),
      provider: data.publisher === "test" ? "test:publisher" : data.publisher,
      kind: asset[0]?.kind === "video" ? "video" : "image",
      mime: asset[0]?.mime_type ?? "",
      width: asset[0]?.width ?? null,
      height: asset[0]?.height ?? null,
      byteSize: asset[0]?.byte_size ?? 0,
      destinationUrl: "",
    });
    if (data.publisher !== "test" && readiness.state !== "READY") {
      throw new Error(`${readiness.state}. ${readiness.summary}`);
    }
    if (asset[0]?.kind === "video") {
      if (data.publisher !== "test") throw new Error(`${readiness.state}. ${readiness.summary}`);
      await publishStudioHypitVideo(sql, {
        organizationId: access.organizationId,
        brandId: data.brandId,
        creativeId: data.creativeId,
        actorId: context.userId,
      });
      return loadSession(sql, access.organizationId, data.brandId, access.role);
    }
    const existing = await sql<{ external_id: string }>`
      select external_id from provider_objects
      where organization_id = ${access.organizationId} and provider = 'test' and object_type = 'ad' and idempotency_key = ${data.creativeId}
      limit 1
    `;
    if (!existing[0]) {
      const decision = decide(publishingReadiness, {
        providerConnected: data.publisher === "test" || readiness.state === "READY",
        creativeApproved: true,
        policyAllowsAutoPublish: false,
      }, {
        provider: data.publisher === "test" ? "test:publisher" : data.publisher,
        model: "account-v1",
      });
      const reasons = decision.reasons.some((line) => line === readiness.summary)
        ? decision.reasons
        : [...decision.reasons, readiness.summary];
      const publishInput = { state: readiness.state };
      const publishEvidence = decision.evidence.length > 0 ? decision.evidence : [{ id: "publish", source: "provider_connections", summary: readiness.summary }];
      // The stored reasons may add the readiness summary, so the digest covers what the row says, not the raw rule output.
      const publishRecord = ruleDecisionRecordFields({ ...decision, reasons }, { input: publishInput, evidence: publishEvidence });
      await sql`
        insert into jev_decisions (
          id, organization_id, brand_id, correlation_id, question_id, question_version, subject_type, subject_id,
          input, evidence, probability, confidence, thresholds, decision, reasons, provider, model,
          answer, schema_version, policy_version, calibration_version, decision_fingerprint, outcome_digest
        ) values (
          ${crypto.randomUUID()}, ${access.organizationId}, ${data.brandId}, ${data.creativeId}, ${decision.questionId},
          ${decision.questionVersion}, 'creative', ${data.creativeId}, ${JSON.stringify(publishInput)},
          ${JSON.stringify(publishEvidence)},
          ${decision.probability}, ${decision.confidence}, ${JSON.stringify(decision.thresholds)},
          ${decision.decision}, ${JSON.stringify(reasons)}, ${decision.provider}, ${decision.model},
          ${JSON.stringify(decision.answer)}, ${decision.schemaVersion}, ${decision.policyVersion}, ${decision.calibrationVersion ?? ""},
          ${publishRecord.decisionFingerprint}, ${publishRecord.outcomeDigest}
        )
      `;
      const isTest = data.publisher === "test";
      const isTestRuntime = isTestingRuntimeNow();
      if (isTest && !isTestRuntime) {
        throw new Error("The test publisher is isolated to TestingRuntime and cannot be used in ProductionRuntime. Connect a live channel to publish.");
      }
      const publisherProvider = isTest ? "test" : (data.publisher as any);
      const result = publishThrough({
        provider: publisherProvider,
        creativeId: data.creativeId,
        allowTestProvider: isTest && isTestRuntime,
      });
      if (!result.externalId) {
        throw new Error(`The publisher (${data.publisher}) did not return an external id (${result.status}). Nothing was stored.`);
      }
      await sql`
        insert into provider_objects (
          id, organization_id, brand_id, provider, object_type, idempotency_key, external_id, status
        ) values (
          ${crypto.randomUUID()}, ${access.organizationId}, ${data.brandId}, ${publisherProvider}, 'ad', ${data.creativeId},
          ${result.externalId}, ${result.status}
        )
      `;
      await sql`
        update assets set lifecycle = 'published', review_status = 'published'
        where creative_id = ${data.creativeId} and organization_id = ${access.organizationId}
      `;
      await sql`update creative_records set status = 'testing', updated_at = now() where id = ${data.creativeId}`;
    }
    return loadSession(sql, access.organizationId, data.brandId, access.role);
}

export async function recordStudioTestPerformance(userId: string, data: { brandId: string }) {
  if (!isTestingRuntimeNow()) {
    throw new Error("Simulated performance is recorded only in the testing runtime. It is never used as a real outcome.");
  }
  const context = { userId };
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "member");
    const published = await sql<{ idempotency_key: string }>`
      select idempotency_key from provider_objects
      where brand_id = ${data.brandId} and organization_id = ${access.organizationId} and provider = 'test' and object_type = 'ad'
    `;
    if (published.length === 0) throw new Error("Publish an approved variant with the test publisher before recording test performance.");
    const siblings = await sql<{ id: string; status: string }>`
      select id, status from creative_records
      where brand_id = ${data.brandId} and organization_id = ${access.organizationId}
        and origin = 'generated' and status in ('approved', 'testing')
    `;
    const targets = siblings.length > 0 ? siblings : published.map((row) => ({ id: row.idempotency_key, status: "testing" }));
    for (const creative of targets) {
      const event = testProviderPerformance(creative.id, true);
      const prior = await sql<{ id: string }>`
        select id from performance_observations
        where creative_id = ${creative.id} and source = 'test:performance' and organization_id = ${access.organizationId}
        limit 1
      `;
      if (prior[0]) continue;
      await sql`
        insert into performance_observations (
          id, organization_id, brand_id, creative_id, platform, impressions, clicks, conversions,
          spend_cents, revenue_cents, observed_on, source, created_by
        ) values (
          ${crypto.randomUUID()}, ${access.organizationId}, ${data.brandId}, ${creative.id}, 'test',
          ${event.impressions}, ${event.clicks}, ${event.conversions}, ${event.spendCents}, ${event.revenueCents},
          ${event.observedOn}, 'test:performance', ${context.userId}
        )
      `;
    }
    const learningId = crypto.randomUUID();
    await sql`
      insert into jobs (id, organization_id, brand_id, job_type, idempotency_key, status, payload)
      values (
        ${learningId}, ${access.organizationId}, ${data.brandId}, 'learning.update', ${`learning.studio:${learningId}`},
        'queued', ${JSON.stringify({ organizationId: access.organizationId })}
      )
    `;
    await claimAndRun(sql, learningId);
    const refreshId = crypto.randomUUID();
    await sql`
      insert into jobs (id, organization_id, brand_id, job_type, idempotency_key, status, payload)
      values (
        ${refreshId}, ${access.organizationId}, ${data.brandId}, 'opportunity.refresh', ${`rerank.studio:${refreshId}`},
        'queued', ${JSON.stringify({ organizationId: access.organizationId })}
      )
    `;
    await claimAndRun(sql, refreshId);
    await applyLearnedPatterns(sql, access.organizationId, data.brandId);
    return loadSession(sql, access.organizationId, data.brandId, access.role);
}
