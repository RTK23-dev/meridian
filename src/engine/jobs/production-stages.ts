// The production ports of the analyze_reference, voice and write_script stages (Bible 6.2, 6.3; contract v8). Each builder takes the
// dependencies the composition root gives it (the gateway's roles, the media functions, the speech ports, the reference store, the asset
// router) and returns the ports the stage handler takes. Nothing here reads an environment variable or a key: the Claude deps come from
// the gateway (through the composition's roleDeps), the bytes from the stores the composition passes, and the speech from the speech ports.
//
// Speech in production (owner decisions, lead 2026-10-17): the speech output is MP3 and the engine's asset store holds it (engine-asset-media.ts,
// audio/mpeg); a speech call's bill is read once from the generation stats (openrouterSpeech.ts) and the submit stays unsettled on a miss. A
// brief's reference is transcribed with the vendor's language detection (analyze/reference.ts, referenceSpeechLanguageOf). Nothing here is
// blocked any more: the voice port sends through the asset router, and refuses only when no router is built.

import type { ReferencePorts, ReferenceSource } from "../analyze/reference.ts";
import type { AssetRouter, ProduceReport } from "../assets/router.ts";
import type { RoleDeps } from "../claude/client.ts";
import { EngineError, type ProductKit, type ProductionRequest, type VoiceKit } from "../contracts/index.ts";
import type { MediaFunctions } from "../media/interface.ts";
import type { SpeechPorts } from "../media/index.ts";
import { notConnectedReason } from "../media/stt-connection.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import type { EngineReferenceStore } from "../../lib/meridian/storage/engine-reference-store.ts";
import type { MediaStorePort } from "./artifact-store.ts";
import { readKit } from "./kit-store.ts";
import type { ReferencePortsFor } from "./handlers/analyze-reference.ts";
import type { VoicePortsFor } from "./handlers/voice.ts";
import { brandOfRequest, objectKeyOfUri, STORE_URI_PREFIX } from "./production-ports.ts";

/** The reference video of a request is read from Meridian's store only: a store:// uri (the Content Factory upload). */
export function storeKeyOfReference(referenceVideo: string): string | null {
  return referenceVideo.startsWith(STORE_URI_PREFIX) ? objectKeyOfUri(referenceVideo) : null;
}

/**
 * The reference source of production (Bible 6.2 steps 1 and 7). The reference is read from the store under the request's brand, as bytes
 * for the media functions (in-process ffmpeg refuses URL inputs). Any other reference (an ig: reel, an s3: uri) is not connected. A missing
 * object is a refused request: it is not guessed as absent. A Content Factory upload stays: the session still names that file, including
 * after a revision, so releasing it would make the next request fail. Other store objects are deleted when analysis ends.
 */
export function productionReferenceSource(input: { sql: Sql; store: EngineReferenceStore }): ReferenceSource {
  return {
    async resolve(referenceVideo, organizationId, requestId) {
      const key = storeKeyOfReference(referenceVideo);
      if (key === null) {
        return {
          status: "not_connected",
          reason: notConnectedReason(
            "the reference video is not in Meridian's store: only a store:// reference is read, and ig: and s3: references are not connected",
          ),
        };
      }
      const brandId = await brandOfRequest(input.sql, organizationId, requestId);
      const object = await input.store.get(organizationId, brandId, key);
      if (object === null) {
        throw new EngineError("invalid_input", "the reference video is not in the store, so it cannot be analysed", { stage: "analyze_reference" });
      }
      return { status: "ready", source: { kind: "bytes", bytes: new Uint8Array(object.bytes) } };
    },
    async release(referenceVideo, organizationId, requestId) {
      const key = storeKeyOfReference(referenceVideo);
      if (key === null || key.startsWith("content-factory/")) return;
      const brandId = await brandOfRequest(input.sql, organizationId, requestId);
      await input.store.release(organizationId, brandId, key);
    },
  };
}

export type AnalysisDeps = {
  media: MediaFunctions;
  speech: SpeechPorts;
  /** The Claude deps of one job's reservation (the gateway, the reservation's ledger, the journal). */
  roles: (scope: { organizationId: string; requestId: string; reservationId: string }) => RoleDeps;
  source: ReferenceSource;
};

/** The analyze_reference ports of production, per job's reservation. The picture readings are added by the runtime (analysisPortsOf). */
export function productionAnalysisPortsFor(deps: AnalysisDeps): ReferencePortsFor {
  return (scope): ReferencePorts => ({
    media: deps.media,
    speech: deps.speech.connection,
    sttPricePerMinuteUsd: deps.speech.sttPricePerMinuteUsd,
    roles: deps.roles(scope),
    source: deps.source,
  });
}

/** A produce report that sent nothing: the router's not_connected outcome with its reasons. */
function unsentReport(reasons: readonly string[]): ProduceReport {
  return { outcome: { status: "not_connected", reasons: [...reasons] }, decisions: [], alerts: [], attempts: [] };
}

export type VoiceDeps = {
  sql: Sql;
  /** Meridian's object store for engine media: the narration's bytes are read from it when they can be stored. */
  objects: MediaStorePort;
  media: MediaFunctions;
  speech: SpeechPorts;
  roles: (scope: { organizationId: string; requestId: string; reservationId: string }) => RoleDeps;
  /** The asset router of one job's reservation, or null when the composition has no shot ports to build one from. */
  router: (scope: { organizationId: string; requestId: string; reservationId: string }) => AssetRouter | null;
};

/** The approved claim texts of the request's product kit, the ones named by its claimIds. Empty when the kit is not found (no claim). */
async function approvedClaimTexts(sql: Sql, organizationId: string, request: ProductionRequest): Promise<string[]> {
  const product = request.product;
  if (product === undefined) return [];
  const kit = await readKit<ProductKit>(sql, { organizationId, kind: "product", kitId: product.productKitId });
  if (kit === null) return [];
  const wanted = new Set(product.claimIds);
  return kit.body.approvedClaims.filter((claim) => wanted.has(claim.claimId)).map((claim) => claim.text);
}

/**
 * The voice ports of production, per job's reservation (Bible 6.3). The speech goes through the asset router's speech route with the
 * reservation's ledger. With no router built for the job (no shot ports), the speech is not sent and the stage reports NOT_CONNECTED with
 * that reason.
 */
export function productionVoicePortsFor(deps: VoiceDeps): VoicePortsFor {
  return (scope) => {
    const router = deps.router(scope);
    return {
      router: {
        async produce(input) {
          if (router === null) return unsentReport(["the asset router is not built: the composition has no shot ports for it"]);
          return router.produce(input);
        },
      },
      speech: deps.speech.connection,
      sttPricePerMinuteUsd: deps.speech.sttPricePerMinuteUsd,
      media: deps.media,
      roles: deps.roles(scope),
      loadAudio: async (uri, organizationId) => {
        const brandId = await brandOfRequest(deps.sql, organizationId, scope.requestId);
        const object = await deps.objects.get(organizationId, brandId, uri);
        if (object === null) throw new EngineError("not_found", "the narration's audio is missing from the object store", { stage: "voice" });
        return new Uint8Array(object.bytes);
      },
      voiceKit: async (organizationId, voiceId) => (await readKit<VoiceKit>(deps.sql, { organizationId, kind: "voice", kitId: voiceId }))?.body ?? null,
      claims: async (organizationId, request) => approvedClaimTexts(deps.sql, organizationId, request),
    };
  };
}
