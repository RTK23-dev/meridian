/**
 * Creative image generation for a signed-in user, server only.
 *
 * The attach action makes one image for a creative through the production lifecycle, not around it:
 * - Nothing is requested without a usable workspace production key and a usable artifact store. Either one missing refuses the
 *   attach before any row, reservation or provider call exists.
 * - In one transaction, the creative row is locked, an attach that is in flight or unresolved for it is refused, the attach's
 *   production job is written as SUBMITTING, and its budget is reserved against that job.
 * - The provider is called once. A failure, or a call that throws, may have reached the provider, so the job becomes
 *   SUBMISSION_UNKNOWN and the reservation stays held for reconciliation. It is never released or retried here.
 * - The bytes are stored and verified by the shared artifact finalizer, which marks the job COMPLETED. The reservation then
 *   settles at its ceiling, because the image was made and the provider reports no billed amount.
 * - The quality judgment (image-qc.server.ts) is made from the stored image. recordAttachOutcome writes the asset, the creative's
 *   state and its review or rejection row in one transaction, and marks the job materialized.
 *
 * It lives in this module, not in creative-actions.ts, so that the client build never sees its server imports. The server function
 * loads this module inside its handler, as opportunity-brief.server.ts does.
 */
import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import { semanticNearest } from "@/lib/meridian/embeddings/store";
import { resolveCredential } from "@/lib/meridian/credentials/resolve";
import { generateNanoBananaImage } from "@/lib/meridian/providers/nano-banana.server";
import type { ImageResult } from "@/lib/meridian/providers/media";
import type { ProductFact } from "../domain.ts";
import type { PolicyOutcome } from "../decisions/policy.ts";
import { withTransaction, type Sql } from "../learning/store.ts";
import { finalizeProductionArtifact } from "../production/artifact-finalizer.ts";
import { settleProductionReservation } from "../production/materialization.ts";
import { BudgetLedgerService, toMicros } from "../security/budget-ledger.ts";
import { isTestingRuntimeNow } from "../runtime-mode.ts";
import { resolveDriveAccess } from "../storage/google-auth.ts";
import { id, requireBrand, loadContext } from "../machine-shared";
import { competitorCopy, factsFor, generatedImageVisual, qcBrandOf, visualFacts, writeJudgment } from "./image-qc.server.ts";

const PROVIDER_ID = "google_nano_banana";
const PROMPT_VERSION = "creative-image-v1";
const NO_KEY_MESSAGE =
  "No usable Google production credential is available for this workspace. Image generation is optional; no image was created.";

/**
 * The most one attach may cost, in USD, reserved before the provider is called. It is a guard, not a price: no per-image price
 * is declared for this provider, and the provider reports no billed amount. A stored attach therefore settles at this ceiling
 * under the unpriced-ceiling estimator, as an unpriced production image does. It is an operator value to confirm.
 */
export const ATTACH_IMAGE_CEILING_USD = 1;

/**
 * How long a job stays out of the poller's reach after it is written as SUBMITTING. The provider call is bounded to 90 seconds,
 * so the poller, which would otherwise read a fresh job as interrupted, waits until the call has had time to return.
 */
const ATTACH_POLL_HOLD = "5 minutes";

/**
 * How long a stored-but-unrecorded attach blocks another attach for its creative. The judgment runs in this window. Past it, the
 * block lifts, so a crash cannot hold a creative out of attach for good.
 */
const ATTACH_RECORDING_WINDOW = "15 minutes";

export type AttachCreativeImageResult = {
  /** For a stored image, the creative's new state: approved, in_review or rejected. Otherwise, why no image was stored. */
  status: "approved" | "in_review" | "rejected" | "failed" | "NOT_CONNECTED";
  /** The judgment's outcome, when a stored image was judged. */
  decision?: PolicyOutcome;
  message: string;
};

export type CreativeProductMatch = {
  product: ProductFact | null;
  /**
   * stored: the creative's stored product name resolved to one product.
   * copy: no stored name, and the copy or title named exactly one product.
   * none: no stored name, and the copy and title name no product. No product is claimed.
   * unknown: the creative names a product that does not resolve to exactly one. Its product-specific claims cannot be checked.
   */
  evidence: "stored" | "copy" | "none" | "unknown";
};

/**
 * The product a creative is judged against. A stored product name decides when there is one, and a name that matches no product
 * resolves to nothing. No other product is used in its place. With no stored name, the copy or the title must name exactly one
 * product. A product the creative does not name is never claimed.
 */
export function productForCreative(
  products: ProductFact[],
  creative: { product_name: string; raw_text: string; title: string },
): CreativeProductMatch {
  const stored = creative.product_name.trim();
  if (stored) {
    const match = products.find((item) => item.name.trim() === stored);
    return match ? { product: match, evidence: "stored" } : { product: null, evidence: "unknown" };
  }
  const named = products.filter((item) => {
    const name = item.name.trim();
    return name !== "" && (creative.raw_text.includes(name) || creative.title.includes(name));
  });
  const [only] = named;
  if (named.length === 1 && only) return { product: only, evidence: "copy" };
  if (named.length > 1) return { product: null, evidence: "unknown" };
  return { product: null, evidence: "none" };
}

/**
 * The state a judgment implies for the creative and for the asset it produced. The values are the ones the review and
 * materialization paths already use: a creative is in_review, approved or rejected. An asset waits in qa_required while a person
 * must look, and is approved or rejected once its judgment is final. Anything unrecognised waits for review.
 */
export function attachStatesFor(rollup: PolicyOutcome): {
  creativeStatus: "in_review" | "approved" | "rejected";
  assetLifecycle: "qa_required" | "approved" | "rejected";
} {
  if (rollup === "REJECT") return { creativeStatus: "rejected", assetLifecycle: "rejected" };
  if (rollup === "AUTO_APPROVE") return { creativeStatus: "approved", assetLifecycle: "approved" };
  return { creativeStatus: "in_review", assetLifecycle: "qa_required" };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Moves an attach job to a failed or unresolved state, scoped to its tenant. */
async function setAttachJob(
  sql: Sql,
  jobId: string,
  scope: { organizationId: string; brandId: string },
  change: { status: "FAILED" | "SUBMISSION_UNKNOWN"; code: string; message: string },
) {
  await sql`
    update production_jobs
    set status = ${change.status}, error_code = ${change.code}, error_message = ${change.message.slice(0, 500)}, updated_at = now()
    where id = ${jobId} and organization_id = ${scope.organizationId} and brand_id = ${scope.brandId}
  `;
}

/**
 * Whether the artifact store can take the bytes before an image is requested. The finalizer writes to Google Drive outside the
 * testing runtime, and an image that cannot be stored would be paid for and lost. The check is the one the Drive client makes on
 * every write.
 */
async function artifactStoreReady(organizationId: string): Promise<{ ready: true } | { ready: false; reason: string }> {
  if (isTestingRuntimeNow()) return { ready: true };
  const access = await resolveDriveAccess(organizationId);
  return access.ok ? { ready: true } : { ready: false, reason: access.reason };
}

/**
 * Writes the asset, the creative's state and the review or rejection row for one judged image, in one transaction, and marks
 * the attach job materialized in the same commit. A failure at any step rolls all of them back, so the creative is never left
 * in a state its review or rejection does not explain.
 */
export async function recordAttachOutcome(
  sql: Sql,
  outcome: {
    organizationId: string;
    brandId: string;
    creativeId: string;
    jobId: string;
    assetId: string;
    storageKey: string;
    sha256: string;
    mimeType: string;
    byteSize: number;
    width: number;
    height: number;
    provider: string;
    model: string;
    promptVersion: string;
    provenance: string;
    decisionId: string;
    rollup: PolicyOutcome;
    reason: string;
  },
): Promise<void> {
  const { creativeStatus, assetLifecycle } = attachStatesFor(outcome.rollup);
  await withTransaction(sql, async (tx) => {
    await tx`
      insert into assets (
        id, organization_id, brand_id, creative_id, version, storage_key, content_hash, mime_type, source, status,
        lifecycle, checksum, width, height, byte_size, provider, model, prompt_version, kind, media_status, provenance,
        qa_decision, review_status
      ) values (
        ${outcome.assetId}, ${outcome.organizationId}, ${outcome.brandId}, ${outcome.creativeId}, 1, ${outcome.storageKey},
        ${outcome.sha256}, ${outcome.mimeType}, ${outcome.provider}, 'stored', ${assetLifecycle}, ${outcome.sha256},
        ${outcome.width}, ${outcome.height}, ${outcome.byteSize}, ${outcome.provider}, ${outcome.model}, ${outcome.promptVersion},
        'image', 'completed', ${outcome.provenance}, ${outcome.rollup}, ${creativeStatus}
      )
    `;
    // A rejected image never becomes the creative's picture. Its asset is kept, marked rejected, and the old picture stays.
    if (outcome.rollup === "REJECT") {
      await tx`
        update creative_records set status = ${creativeStatus}, updated_at = now()
        where id = ${outcome.creativeId} and organization_id = ${outcome.organizationId} and brand_id = ${outcome.brandId}
      `;
    } else {
      await tx`
        update creative_records set status = ${creativeStatus}, asset_url = ${outcome.storageKey}, updated_at = now()
        where id = ${outcome.creativeId} and organization_id = ${outcome.organizationId} and brand_id = ${outcome.brandId}
      `;
    }
    // The review or the rejection row comes after the state. A failure here rolls the state back with it.
    if (outcome.rollup === "HUMAN_REVIEW") {
      await tx`
        insert into reviews (id, organization_id, brand_id, decision_id, creative_id, subject_label)
        values (${`review-${outcome.jobId}`}, ${outcome.organizationId}, ${outcome.brandId}, ${outcome.decisionId}, ${outcome.creativeId}, ${"Image needs a person"})
        on conflict (id) do nothing
      `;
    }
    if (outcome.rollup === "REJECT") {
      await tx`
        insert into rejections (id, organization_id, brand_id, creative_id, decision_id, reason_code, note, rejected_by)
        values (
          ${`rejection-${outcome.jobId}`}, ${outcome.organizationId}, ${outcome.brandId}, ${outcome.creativeId}, ${outcome.decisionId},
          ${"other"}, ${outcome.reason.slice(0, 500)}, ${"creative_qa"}
        )
        on conflict (id) do nothing
      `;
    }
    await tx`
      update production_jobs
      set output = ${JSON.stringify({ width: outcome.width, height: outcome.height, mediaType: outcome.mimeType, promptVersion: outcome.promptVersion, model: outcome.model, provider: outcome.provider })},
          materialized_creative_id = ${outcome.creativeId}, materialized_at = now(), updated_at = now()
      where id = ${outcome.jobId} and organization_id = ${outcome.organizationId} and brand_id = ${outcome.brandId}
    `;
  });
}

/**
 * The quality judgment for one stored image, made from its bytes and the brand's data as it is now. A product whose claims cannot
 * be matched to the creative leaves those claims unknown, and an unknown claim check never auto-approves: it goes to a person.
 */
async function judgeAttachedImage(
  sql: Sql,
  input: {
    organizationId: string;
    brandId: string;
    creative: { title: string; raw_text: string; angle: string; product_name: string };
    creativeId: string;
    bytes: Uint8Array;
    sha256: string;
    prompt: string;
    width: number;
    height: number;
  },
): Promise<{ rollup: PolicyOutcome; reason: string; decisionId: string }> {
  // The judgment compares against the brand as it is now, and reads the creative's persisted copy, not the prompt. The creative
  // is checked against the brand's other creatives. Its own stored copy is not an earlier creative, so it is left out. Otherwise
  // every creative would duplicate itself. The materializer judges before the creative row exists, so it never sees its own copy.
  const loaded = await loadContext(sql, input.organizationId, input.brandId);
  const brand = qcBrandOf({ ...loaded, creatives: loaded.creatives.filter((item) => item.id !== input.creativeId) });
  const match = productForCreative(loaded.products, input.creative);
  const copy = input.creative.raw_text;
  const visual = await visualFacts(sql, input.organizationId, input.brandId, input.bytes);
  const facts = factsFor(brand, {
    kind: "image",
    productName: input.creative.product_name || match.product?.name || "",
    angle: input.creative.angle,
    copy,
    prompt: input.prompt,
    mime: "image/png",
    byteSize: input.bytes.byteLength,
    width: input.width,
    height: input.height,
    checksum: input.sha256,
    durationMs: null,
    transcript: "",
    sceneCount: 0,
    logoSimilarity: visual.measuredLogo.similarity,
    logoOutcome: visual.measuredLogo.outcome,
    logoEvidence: visual.measuredLogo.evidence,
    paletteDistance: visual.measuredPalette.distance,
    paletteOutcome: visual.measuredPalette.outcome,
    paletteEvidence: visual.measuredPalette.evidence,
    semanticSimilarity: await semanticNearest(copy, competitorCopy(brand)).catch(() => null),
    ownSemanticSimilarity: await semanticNearest(copy, brand.creatives.filter((item) => item.origin !== "competitor").map((item) => item.text)).catch(() => null),
  });
  // The matched product's prohibited claims apply to its copy. No other product's claims are added.
  facts.prohibited = [facts.prohibited, match.product?.prohibitedClaims ?? ""].filter(Boolean).join("\n");
  const judgment = await writeJudgment(sql, {
    organizationId: input.organizationId,
    brandId: input.brandId,
    creativeId: input.creativeId,
    facts,
    visual: generatedImageVisual(input.bytes, input.sha256),
  });
  if (match.evidence === "unknown" && judgment.rollup === "AUTO_APPROVE") {
    return {
      rollup: "HUMAN_REVIEW",
      reason: `${judgment.reason} The product this creative is for could not be matched, so its product claims were not checked. A person must review it.`,
      decisionId: judgment.decisionId,
    };
  }
  return { rollup: judgment.rollup, reason: judgment.reason, decisionId: judgment.decisionId };
}

/**
 * Generates and stores an image for a creative, for a signed-in user. The role and the tenant are checked here. The image is
 * generated with the creative's own workspace production key, resolved through the shared credential resolver.
 */
export async function attachCreativeImageFor(userId: string, data: { brandId: string; creativeId: string }): Promise<AttachCreativeImageResult> {
  const sql = await getSql();
  const access = await requireBrand(sql, userId, data.brandId, "member");
  const orgId = access.organizationId;
  const creatives = await sql<{ title: string; raw_text: string; hook: string; angle: string; product_name: string; status: string; brief_id: string | null }>`
    select title, raw_text, hook, angle, product_name, status, brief_id from creative_records
    where id = ${data.creativeId} and brand_id = ${data.brandId} and organization_id = ${orgId}
      and origin <> 'competitor'
    limit 1
  `;
  const creative = creatives[0];
  if (!creative) throw new Error("Creative not found.");
  if (creative.status === "rejected") throw new Error("Rejected creatives are not illustrated.");
  const briefRows = creative.brief_id ? await sql<{ decision_id: string }>`
    select decision_id from briefs
    where id = ${creative.brief_id} and organization_id = ${orgId} and brand_id = ${data.brandId}
    limit 1
  ` : [];
  const jevDecisionId = briefRows[0]?.decision_id ?? "";
  const prompt = `Advertising still for ${creative.title}. ${creative.hook}. ${creative.raw_text}`.slice(0, 1800);

  // Refused before any row or reservation: without a key or an artifact store, nothing could be requested or stored.
  const workspaceKey = await resolveCredential(sql, orgId, "production");
  if (workspaceKey.status !== "ready") return { status: "NOT_CONNECTED", message: NO_KEY_MESSAGE };
  const store = await artifactStoreReady(orgId);
  if (!store.ready) return { status: "NOT_CONNECTED", message: `${store.reason} No image was requested, so nothing was spent.` };
  const apiKey = workspaceKey.secret;

  // The attach's job id is its idempotency key: the creative plus a fresh attempt id, so no key is ever reused.
  const jobId = `attach-${data.creativeId}-${randomUUID()}`;
  const scope = { organizationId: orgId, brandId: data.brandId };
  const reservation = await withTransaction(sql, async (tx) => {
    // The creative row is locked, so two attaches for it cannot both pass the check below.
    const locked = await tx<{ id: string }>`
      select id from creative_records
      where id = ${data.creativeId} and brand_id = ${data.brandId} and organization_id = ${orgId}
      for update
    `;
    if (!locked[0]) throw new Error("Creative not found.");
    // An attach that is running, unresolved, or stored but not yet recorded blocks another one for this creative.
    const inFlight = await tx<{ id: string }>`
      select id from production_jobs
      where organization_id = ${orgId} and brand_id = ${data.brandId} and modality = 'image'
        and input->>'attachCreativeId' = ${data.creativeId}
        and (
          status in ('SUBMITTING', 'SUBMISSION_UNKNOWN')
          or (status = 'COMPLETED' and materialized_at is null and created_at > now() - ${ATTACH_RECORDING_WINDOW}::interval)
        )
      limit 1
    `;
    if (inFlight[0]) {
      throw new Error("An image is already being attached to this creative. Wait for that attach to finish, or for its held budget to be resolved, before attaching another.");
    }
    await tx`
      insert into production_jobs (
        id, organization_id, brand_id, provider, provider_job_id, request_id, status_url, cancel_url,
        status, cost_mode, estimated_cost_cents, input, created_at, submitted_at, updated_at, next_poll_at, modality, cost_status
      ) values (
        ${jobId}, ${orgId}, ${data.brandId}, ${PROVIDER_ID}, null, null, null, null,
        'SUBMITTING', 'BALANCED', null,
        ${JSON.stringify({ kind: "creative_attach", attachCreativeId: data.creativeId, prompt, copy: creative.raw_text, promptVersion: PROMPT_VERSION })},
        now(), null, now(), now() + ${ATTACH_POLL_HOLD}::interval, 'image', 'unknown'
      )
    `;
    // A budget the account cannot cover throws here, and the job row above rolls back with it. No provider call is made.
    return BudgetLedgerService.reserve(tx, {
      organizationId: orgId,
      brandId: data.brandId,
      amountMicros: toMicros(ATTACH_IMAGE_CEILING_USD),
      productionJobId: jobId,
    });
  });

  // The provider is called once. From here a failure is ambiguous, so the reservation is held, never released.
  let image: ImageResult;
  try {
    image = await generateNanoBananaImage({ prompt, promptVersion: PROMPT_VERSION, apiKey });
  } catch (callError) {
    await setAttachJob(sql, jobId, scope, { status: "SUBMISSION_UNKNOWN", code: "PROVIDER_CALL_AMBIGUOUS", message: errorText(callError) });
    throw callError;
  }
  if (image.status !== "ready") {
    if (image.status === "NOT_CONNECTED") {
      // The adapter made no request, so nothing was submitted, and the reservation is released.
      await setAttachJob(sql, jobId, scope, { status: "FAILED", code: "NOT_CONNECTED", message: image.error });
      await BudgetLedgerService.release(sql, { reservationId: reservation.id, reason: image.error });
      return { status: "NOT_CONNECTED", message: image.error };
    }
    await setAttachJob(sql, jobId, scope, { status: "SUBMISSION_UNKNOWN", code: "PROVIDER_CALL_FAILED", message: image.error });
    return { status: "failed", message: `${image.error} The reservation is held for reconciliation.` };
  }

  // The bytes are stored and verified by the shared finalizer, which also marks the job COMPLETED.
  const stored = await finalizeProductionArtifact(sql, {
    jobId,
    organizationId: orgId,
    brandId: data.brandId,
    provider: image.provider,
    rawArtifact: { bytes: image.bytes, mimeType: image.mediaType },
  });
  if (!stored.success || !stored.storageKey || !stored.sha256 || stored.byteSize === undefined || !stored.artifactId) {
    // The provider returned an image, so the spend happened. The reservation settles at its ceiling, and the job says why it was not stored.
    const reason = stored.error ?? "The image could not be stored.";
    await setAttachJob(sql, jobId, scope, { status: "FAILED", code: stored.errorCode ?? "STORAGE_PERSISTENCE_FAILED", message: reason });
    await settleProductionReservation(sql, { organizationId: orgId, brandId: data.brandId, productionJobId: jobId });
    return { status: "failed", message: `The image was generated, but it was not stored. ${reason}` };
  }
  // The image is stored and the provider has made it, so the reservation settles now. A judgment error cannot leave it held.
  await settleProductionReservation(sql, { organizationId: orgId, brandId: data.brandId, productionJobId: jobId });

  try {
    const judged = await judgeAttachedImage(sql, {
      organizationId: orgId,
      brandId: data.brandId,
      creative,
      creativeId: data.creativeId,
      bytes: image.bytes,
      sha256: stored.sha256,
      prompt,
      width: image.width,
      height: image.height,
    });
    await recordAttachOutcome(sql, {
      organizationId: orgId,
      brandId: data.brandId,
      creativeId: data.creativeId,
      jobId,
      assetId: id(),
      storageKey: stored.storageKey,
      sha256: stored.sha256,
      mimeType: stored.mimeType ?? "image/png",
      byteSize: stored.byteSize,
      width: image.width,
      height: image.height,
      provider: image.provider,
      model: image.model,
      promptVersion: image.promptVersion,
      provenance: `jev-creative-image:${jevDecisionId || "no-decision"}`,
      decisionId: judged.decisionId,
      rollup: judged.rollup,
      reason: judged.reason,
    });
    return { status: attachStatesFor(judged.rollup).creativeStatus, decision: judged.rollup, message: judged.reason };
  } catch (error) {
    // The image is stored but its outcome was not recorded. The job leaves the poller's queue as failed, so it is not retried.
    await sql`
      update production_jobs set status = 'FAILED', error_code = 'ATTACH_NOT_RECORDED', error_message = ${errorText(error).slice(0, 500)}, updated_at = now()
      where id = ${jobId} and organization_id = ${orgId} and brand_id = ${data.brandId} and materialized_at is null
    `.catch(() => undefined);
    throw error;
  }
}
