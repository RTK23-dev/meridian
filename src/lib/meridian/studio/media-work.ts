import { createHash } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import { advanceTestVideo, startTestVideo, type VideoJob } from "../providers/media.ts";
import { inspectVideo, videoFactsFromInspection } from "../video/inspect.ts";
import type { ExecutableJob } from "../jobs/execute.ts";

export const STUDIO_PROMPT_VERSION = "studio-media-v1";
export const TEST_VIDEO_MAX_POLLS = 4;

export function variantPrompt(input: {
  productName: string;
  angle: string;
  hook: string;
  audience: string;
  constraints: string;
  index: number;
  kind: "image" | "video";
}): string {
  const treatments = [
    "Open on the product in use. Do not copy a competitor line.",
    "Closer framing of the same product. Change the first line, not the claim.",
    "A second setup of the same angle. Keep the brand words. Do not add a new promise.",
  ];
  return [
    `Variant ${input.index + 1}. ${input.kind}. Prompt ${STUDIO_PROMPT_VERSION}.`,
    `Product: ${input.productName || "unspecified product"}.`,
    `Angle: ${input.angle}.`,
    `Audience: ${input.audience || "the stored audience"}.`,
    `Hook direction: ${input.hook}`,
    treatments[input.index] ?? treatments[0],
    input.constraints ? `Constraints:\n${input.constraints}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function storeBlob(
  sql: Sql,
  input: { organizationId: string; brandId: string; key: string; mime: string; bytes: Uint8Array },
): Promise<{ checksum: string; byteSize: number }> {
  const checksum = createHash("sha256").update(input.bytes).digest("hex");
  const body = Buffer.from(input.bytes).toString("base64");
  await sql`
    insert into asset_blobs (
      storage_key, organization_id, brand_id, body, mime_type, checksum, byte_size, version, lifecycle
    ) values (
      ${input.key}, ${input.organizationId}, ${input.brandId}, ${body}, ${input.mime},
      ${checksum}, ${input.bytes.byteLength}, 1, 'stored'
    )
    on conflict (storage_key) do update set
      body = excluded.body,
      checksum = excluded.checksum,
      byte_size = excluded.byte_size,
      version = asset_blobs.version + 1,
      updated_at = now()
  `;
  return { checksum, byteSize: input.bytes.byteLength };
}

/** Stores the container and only the frames that are actually inside it. */
export async function persistVideoBytes(
  sql: Sql,
  input: {
    organizationId: string;
    brandId: string;
    assetId: string;
    key: string;
    bytes: Uint8Array;
    providerJobId: string;
    reportedDurationMs: number | null;
    scenes: { atMs: number; summary: string }[];
  },
): Promise<{ frameCount: number; durationMs: number | null; width: number | null; height: number | null }> {
  const inspected = inspectVideo(input.bytes);
  const facts = videoFactsFromInspection(inspected, input.bytes.byteLength);
  const stored = await storeBlob(sql, {
    organizationId: input.organizationId,
    brandId: input.brandId,
    key: input.key,
    mime: "video/mp4",
    bytes: input.bytes,
  });
  for (let index = 0; index < inspected.frames.length; index += 1) {
    const frame = inspected.frames[index];
    if (!frame) continue;
    await storeBlob(sql, {
      organizationId: input.organizationId,
      brandId: input.brandId,
      key: `${input.key}.frame.${index}.png`,
      mime: "image/png",
      bytes: frame,
    });
  }
  const scenes = input.scenes.length > 0 ? input.scenes : [{ atMs: 0, summary: facts.scene }];
  const durationMs = facts.durationMs ?? input.reportedDurationMs;
  await sql`
    update assets set
      storage_key = ${input.key}, content_hash = ${stored.checksum}, checksum = ${stored.checksum},
      mime_type = 'video/mp4', byte_size = ${stored.byteSize}, width = ${facts.width}, height = ${facts.height},
      duration_ms = ${durationMs}, frame_rate = ${null}, transcript = '',
      scenes = ${JSON.stringify(scenes)}, media_status = 'completed', status = 'stored', lifecycle = 'stored',
      provider_job_id = ${input.providerJobId}
    where id = ${input.assetId} and organization_id = ${input.organizationId}
  `;
  return { frameCount: inspected.frames.length, durationMs, width: facts.width, height: facts.height };
}

async function enqueue(
  sql: Sql,
  input: { id: string; organizationId: string; brandId: string; type: string; key: string; payload: unknown },
): Promise<void> {
  await sql`
    insert into jobs (
      id, organization_id, brand_id, job_type, idempotency_key, status, payload, max_attempts
    ) values (
      ${input.id}, ${input.organizationId}, ${input.brandId}, ${input.type}, ${input.key},
      'queued', ${JSON.stringify(input.payload)}, 4
    )
    on conflict (organization_id, idempotency_key) do nothing
  `;
}

export async function runVideoJob(sql: Sql, job: ExecutableJob, payload: Record<string, unknown>): Promise<string> {
  const mediaJobId = typeof payload.mediaJobId === "string" ? payload.mediaJobId : "";
  const rows = await sql<Record<string, unknown>>`
    select * from media_jobs
    where id = ${mediaJobId} and organization_id = ${job.organization_id}
    limit 1
  `;
  const row = rows[0];
  if (!row) throw new Error("Video job not found.");
  const provider = String(row.provider ?? "");
  const assetId = String(row.asset_id ?? "");
  if (provider !== "test:video") {
    await sql`
      update media_jobs set status = 'failed', error = 'No video vendor adapter is connected.', updated_at = now()
      where id = ${mediaJobId}
    `;
    await sql`update assets set media_status = 'failed', error = 'No video vendor adapter is connected.' where id = ${assetId}`;
    return "NOT_CONNECTED";
  }
  if (payload.allowTest !== true) throw new Error("The test video provider is not enabled.");

  if (job.job_type === "video.generate") {
    await sql`update media_jobs set status = 'queued', updated_at = now() where id = ${mediaJobId}`;
    await sql`update assets set media_status = 'queued' where id = ${assetId}`;
    const started = startTestVideo(
      { prompt: String(row.prompt ?? ""), seed: mediaJobId, promptVersion: String(row.prompt_version ?? "") },
      true,
    );
    const submitted = advanceTestVideo(started, true);
    await sql`
      update media_jobs set
        status = 'submitted', provider_job_id = ${submitted.providerJobId}, model = ${submitted.model},
        state = ${JSON.stringify({ ...submitted, bytes: null })}, attempts = attempts + 1, updated_at = now()
      where id = ${mediaJobId}
    `;
    await sql`
      update assets set media_status = 'submitted', provider = 'test:video', provider_job_id = ${submitted.providerJobId}, model = ${submitted.model}
      where id = ${assetId}
    `;
    const pollId = crypto.randomUUID();
    await enqueue(sql, {
      id: pollId,
      organizationId: job.organization_id,
      brandId: String(row.brand_id),
      type: "video.poll",
      key: `video.poll:${mediaJobId}:1`,
      payload: { mediaJobId, allowTest: true, organizationId: job.organization_id, step: 1 },
    });
    return `submitted:${submitted.providerJobId}`;
  }

  const current = JSON.parse(String(row.state || "{}")) as VideoJob;
  if (!current.providerJobId) throw new Error("Video poll has no submitted job.");
  const next = advanceTestVideo(current, true);
  const step = typeof payload.step === "number" ? payload.step : Number(payload.step) || 1;
  await sql`
    update media_jobs set status = ${next.status}, state = ${JSON.stringify({ ...next, bytes: null })}, attempts = attempts + 1, updated_at = now()
    where id = ${mediaJobId}
  `;
  await sql`update assets set media_status = ${next.status} where id = ${assetId}`;
  if (next.status !== "completed" || !next.bytes) {
    if (step >= TEST_VIDEO_MAX_POLLS) throw new Error("Test video did not finish.");
    await enqueue(sql, {
      id: crypto.randomUUID(),
      organizationId: job.organization_id,
      brandId: String(row.brand_id),
      type: "video.poll",
      key: `video.poll:${mediaJobId}:${step + 1}`,
      payload: { mediaJobId, allowTest: true, organizationId: job.organization_id, step: step + 1 },
    });
    return next.status;
  }
  const key = `${job.organization_id}/${row.brand_id}/runs/${row.generation_run_id}/${assetId}.mp4`;
  await persistVideoBytes(sql, {
    organizationId: job.organization_id,
    brandId: String(row.brand_id),
    assetId,
    key,
    bytes: next.bytes,
    providerJobId: next.providerJobId,
    reportedDurationMs: next.durationMs,
    scenes: next.scenes,
  });
  return `completed:${next.providerJobId}`;
}
