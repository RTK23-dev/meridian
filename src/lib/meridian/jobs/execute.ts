import { createHash } from "node:crypto";
import { assessCopy } from "../production/assess.ts";
import { collectMarket, publishThrough } from "../providers/boundaries.ts";
import { applyLearnedPatterns, type Sql } from "../learning/store.ts";
import { collectAdLibrarySource } from "../market/pipeline.ts";
import { rerankBrand } from "../opportunity/rerank.ts";
import { syncPublishingStatus } from "../publishing/provider.ts";
import { videoQa } from "../video/provider.ts";
import { allocateTraffic, type TrafficVariant } from "../experiments/allocate.ts";
import { deliverAlert } from "../alerts/deliver.ts";
import { deliveryPlan, deliveryUrlAllowed } from "../alerts/lifecycle.ts";
import { liveTransport } from "../providers/http.ts";

export type ExecutableJob = {
  id: string;
  organization_id: string;
  brand_id: string | null;
  job_type: string;
  payload: string;
  attempts: number;
  max_attempts: number;
};

function readPayload(job: ExecutableJob): Record<string, unknown> {
  try {
    const payload = JSON.parse(job.payload || "{}") as Record<string, unknown>;
    if (payload.organizationId && payload.organizationId !== job.organization_id) {
      throw new Error("Tenant scope violation.");
    }
    return payload;
  } catch (error) {
    if (error instanceof Error && error.message === "Tenant scope violation.") throw error;
    return {};
  }
}

/** Runs one claimed job. A string result means the work finished. It does not invent provider data. */
export async function executeJob(sql: Sql, job: ExecutableJob): Promise<string> {
  const payload = readPayload(job);
  if (job.job_type === "research.collect") {
    const { executeResearchCollection } = await import("../research/worker.ts");
    return executeResearchCollection(sql, job, payload);
  }
  if (job.job_type.startsWith("factory.")) {
    const { executeFactoryJob } = await import("../factory/worker.ts");
    return executeFactoryJob(sql, job, payload);
  }
  if (job.job_type === "learning.update") {
    if (!job.brand_id) throw new Error("Learning needs a brand.");
    const count = await applyLearnedPatterns(sql, job.organization_id, job.brand_id);
    return `patterns:${count}`;
  }
  if (job.job_type === "opportunity.refresh") {
    if (!job.brand_id) throw new Error("Ranking needs a brand.");
    const count = await rerankBrand(sql, job.organization_id, job.brand_id);
    return `opportunities:${count}`;
  }
  if (job.job_type === "embedding.generate") {
    const text = typeof payload.text === "string" ? payload.text : "";
    if (!text.trim()) throw new Error("Embedding needs text. No lexical hash was stored.");
    const { embedWithProvider } = await import("../embeddings/select.ts");
    const [vector] = await embedWithProvider("local:semantic", [text]);
    if (!vector) throw new Error("The embedding model returned no vector. No lexical hash was stored.");
    const hash = createHash("sha256").update(text).digest("hex");
    const creativeId = typeof payload.creativeId === "string" ? payload.creativeId : "";
    if (creativeId && job.brand_id) {
      await sql`
        insert into creative_embeddings (
          id, organization_id, brand_id, creative_id, provider, model, dimensions, vector
        ) values (
          ${`${creativeId}:${vector.provider}`}, ${job.organization_id}, ${job.brand_id}, ${creativeId},
          ${vector.provider}, ${vector.model}, ${vector.dimensions}, ${JSON.stringify(vector.values)}
        )
        on conflict (creative_id, provider, model) do update set vector = excluded.vector, dimensions = excluded.dimensions
      `;
    } else {
      await sql`
        insert into embedding_cache (
          organization_id, content_hash, provider, model, kind, dimensions, vector
        ) values (
          ${job.organization_id}, ${hash}, ${vector.provider}, ${vector.model}, ${vector.kind}, ${vector.dimensions}, ${JSON.stringify(vector.values)}
        )
        on conflict (organization_id, content_hash, provider, model) do update set vector = excluded.vector
      `;
    }
    return `semantic:${vector.dimensions}`;
  }
  if (job.job_type === "market.collect") {
    const pageUrl = typeof payload.url === "string" ? payload.url.trim() : "";
    if (pageUrl && job.brand_id) {
      const { fetchPublicText } = await import("../sources/fetch-page.server.ts");
      const { quarantineExternalText } = await import("../ingestion/quarantine.ts");
      try {
        const page = await fetchPublicText(pageUrl);
        const clean = quarantineExternalText(page.text);
        if (!clean.text) throw new Error("The page had no usable text after instruction-like lines were removed.");
        await sql`
          insert into source_documents (id, organization_id, brand_id, url, status, excerpt, created_by)
          values (
            ${crypto.randomUUID()}, ${job.organization_id}, ${job.brand_id}, ${page.url}, 'stored',
            ${clean.text.slice(0, 12000)}, 'market.collect'
          )
        `;
        return "stored";
      } catch (error) {
        const message = error instanceof Error ? error.message : "The page could not be read.";
        await sql`
          insert into source_documents (id, organization_id, brand_id, url, status, error, created_by)
          values (
            ${crypto.randomUUID()}, ${job.organization_id}, ${job.brand_id}, ${pageUrl}, 'failed',
            ${message.slice(0, 400)}, 'market.collect'
          )
        `;
        return message;
      }
    }
    const library = collectAdLibrarySource();
    const connection = collectMarket("ad_library");
    if (job.brand_id) {
      await sql`
        insert into source_connections (id, organization_id, brand_id, source, status, last_error)
        values (
          ${`${job.organization_id}:${job.brand_id}:ad_library`}, ${job.organization_id}, ${job.brand_id},
          'ad_library', ${connection.status}, ${library.detail ?? connection.detail}
        )
        on conflict (id) do update set status = excluded.status, last_error = excluded.last_error, updated_at = now()
      `;
    }
    if (library.records.length !== 0) throw new Error("A disconnected ad library returned records.");
    return library.status;
  }
  if (job.job_type === "publishing.sync") {
    const synced = syncPublishingStatus();
    if (synced.externalId !== null) throw new Error("A disconnected publisher returned an id.");
    return synced.status;
  }
  if (job.job_type === "publishing.dispatch") {
    const creativeId = typeof payload.creativeId === "string" ? payload.creativeId : "";
    if (creativeId) {
      const provider = payload.provider === "test" ? "test" : "meta";
      const result = publishThrough({
        provider,
        creativeId,
        allowTestProvider: payload.allowTestProvider === true,
      });
      return result.externalId ? `${result.status}:${result.externalId}` : result.status;
    }
    const { claimScheduledJobs } = await import("../publishing/orchestrator.ts");
    const claimed = await claimScheduledJobs(sql, 10);
    return `claimed:${claimed.length}`;
  }
  if (job.job_type === "performance.ingest" || job.job_type === "performance.sync") {
    const { runPerformanceSync } = await import("../performance/job.ts");
    return runPerformanceSync(sql, job, payload);
  }
  if (job.job_type === "experiment.process") {
    const variants = Array.isArray(payload.variants) ? (payload.variants as TrafficVariant[]) : [];
    const bucket = typeof payload.bucketKey === "string" ? payload.bucketKey : job.id;
    return allocateTraffic(variants, bucket);
  }
  if (job.job_type === "guardian.check") {
    const text = typeof payload.text === "string" ? payload.text : "";
    if (!text.trim()) return "HUMAN_REVIEW:missing-text";
    const assessed = assessCopy({
      text,
      productName: typeof payload.productName === "string" ? payload.productName : "",
      allowedClaims: typeof payload.allowedClaims === "string" ? payload.allowedClaims : "",
      prohibitedClaims: typeof payload.prohibitedClaims === "string" ? payload.prohibitedClaims : "",
      requiredDisclaimers: typeof payload.requiredDisclaimers === "string" ? payload.requiredDisclaimers : "",
      wordsToAvoid: typeof payload.wordsToAvoid === "string" ? payload.wordsToAvoid : "",
      hook: typeof payload.hook === "string" ? payload.hook : "",
      cta: typeof payload.cta === "string" ? payload.cta : "",
    });
    return assessed.decision.decision;
  }
  if (job.job_type === "vision.analyze") {
    return "HUMAN_REVIEW:missing-logo-bytes";
  }
  if (job.job_type === "video.analyze") {
    return videoQa(null).decision;
  }
  if (job.job_type === "webhook.received") {
    const eventId = typeof payload.eventId === "string" ? payload.eventId : "";
    if (!eventId) throw new Error("Webhook job has no event id.");
    return `stored:${eventId}`;
  }
  if (job.job_type === "alert.deliver") {
    const alertId = typeof payload.alertId === "string" ? payload.alertId : "";
    const targetUrl = typeof payload.targetUrl === "string" ? payload.targetUrl : "";
    if (!alertId) throw new Error("Alert delivery has no alert id.");
    const target = targetUrl && deliveryUrlAllowed(targetUrl) ? { kind: "webhook" as const, url: targetUrl } : { kind: "none" as const };
    const prior = await sql<{ status: string }>`
      select status from delivery_attempts where alert_id = ${alertId} and organization_id = ${job.organization_id}
    `;
    const plan = deliveryPlan(prior, target);
    if (plan.action !== "send" || target.kind !== "webhook") {
      await sql`update alert_events set delivery_status = ${plan.status} where id = ${alertId} and organization_id = ${job.organization_id}`;
      return plan.status;
    }
    const rows = await sql<{ id: string; code: string; severity: string; detail: string }>`
      select id, code, severity, detail from alert_events where id = ${alertId} and organization_id = ${job.organization_id} limit 1
    `;
    const row = rows[0];
    if (!row) return "missing";
    const result = await deliverAlert(
      {
        id: row.id,
        organizationId: job.organization_id,
        code: row.code,
        severity: row.severity === "critical" || row.severity === "info" ? row.severity : "warning",
        detail: row.detail,
        firstSeen: "",
        lastSeen: "",
        acknowledged: false,
      },
      target,
      liveTransport(),
    );
    await sql`
      insert into delivery_attempts (id, organization_id, alert_id, status, detail)
      values (${crypto.randomUUID()}, ${job.organization_id}, ${alertId}, ${result.status === "sent" ? "sent" : "failed"}, ${result.error.slice(0, 300)})
    `;
    if (result.status !== "sent") {
      const again = deliveryPlan([...prior, { status: "failed" }], target);
      await sql`update alert_events set delivery_status = ${again.status === "dead" ? "dead" : "failed"} where id = ${alertId}`;
      if (again.action === "dead") return "dead";
      throw new Error(result.error || "The delivery target did not accept the alert.");
    }
    await sql`update alert_events set delivery_status = 'sent' where id = ${alertId} and organization_id = ${job.organization_id}`;
    return "sent";
  }
  if (job.job_type === "video.generate" || job.job_type === "video.poll") {
    const { runVideoJob } = await import("../studio/media-work.ts");
    return runVideoJob(sql, job, payload);
  }
  if (job.job_type === "notification.dispatch") {
    const title = typeof payload.title === "string" ? payload.title : "";
    if (!title.trim()) throw new Error("Notification needs a title.");
    await sql`
      insert into notifications (id, organization_id, brand_id, kind, title, body)
      values (${job.id}, ${job.organization_id}, ${job.brand_id}, 'job', ${title}, ${typeof payload.body === "string" ? payload.body : ""})
    `;
    return "dispatched";
  }
  if (job.job_type === "telemetry.sync") {
    if (!job.brand_id) throw new Error("Telemetry sync needs a brand.");
    const { syncTelemetryToLearning } = await import("../learning/telemetry-engine.ts");
    const syncRes = await syncTelemetryToLearning(sql, job.organization_id, job.brand_id);
    return `synced:${syncRes.syncedRecords}:patterns:${syncRes.patternsLearned}`;
  }
  if (job.job_type === "market.normalize" || job.job_type === "creative.analyze" || job.job_type === "cluster.refresh" || job.job_type === "asset.process") {
    throw new Error(`${job.job_type} has no payload work in this claim. It was not marked done.`);
  }
  throw new Error(`No handler for ${job.job_type}.`);
}
