// The produce_shot stage's types and constants: the stock endpoint, the take's limits and frame size, the shot's production
// shapes, and the ports the handler takes. Moved out of engine/jobs/handlers/produce-shot.ts unchanged (coding loop, T9b).

import type { AssetSpec, Decision, ProviderError } from "../../contracts/index.ts";
import type { ProviderPoll } from "../../contracts/assets.ts";
import type { AssetJob } from "../../assets/job.ts";
import type { StockOutcome } from "../../assets/stock.ts";
import type { MediaDownloader } from "../../gateway/download.ts";
import type { MediaFunctions } from "../../media/interface.ts";
import type { Sql } from "../../../lib/meridian/learning/store.ts";
import { FFMPEG_LIMITS } from "../../../../functions/ffmpeg/limits.ts";
import type { MediaStorePort } from "../artifact-store.ts";
import type { ModelChoice } from "../../contracts/assets.ts";
import type { ProduceHold } from "../types.ts";

/** The stock route's endpoint family (config/routes.ts, "stock"). It names the call, not a model. */
export const STOCK_MODEL = "videos";

/** Stock search is free: list price 0 in config/prices.ts for pexels and pixabay. Stored as 0, not as an unknown. */

export const STOCK_COST_USD = 0;

/** The largest file a take may be (the media functions' input limit). */

export const TAKE_MAX_BYTES = FFMPEG_LIMITS.maxInputBytes;

/** The frame size a take must be stored at (Bible section 1). */

export const TAKE_WIDTH = 1080;

export const TAKE_HEIGHT = 1920;

/** A hint is a rule-style name written by this code. Anything else is dropped before it reaches a prompt (Bible 1). */

export const HINT_PATTERN = /^[a-z0-9_.:-]{1,64}$/;

/** What the router (or another generator) reports for one generate call. Every case is a fact about the call. */

export type ShotProduction =
  | {
      status: "done";
      providerId: string;
      uri: string;
      mediaType: string | null;
      costUsd: number;
      cacheHit: boolean;
      ledgerEntryId: string | null;
      decisions: Decision[];
    }
  /** The router submitted the call. job is the router's asset job: the poller carries it, and settle receives it back. */
  | { status: "submitted"; providerId: string; jobRef: string; submittedAt: string; job: AssetJob; runAfterMs: number; decisions: Decision[] }
  | { status: "failed"; providerId: string; error: ProviderError; decisions: Decision[] }
  | { status: "refused"; reasons: string[]; decisions: Decision[] }
  | { status: "queued"; reasons: string[] }
  | { status: "unavailable"; reasons: string[]; decisions: Decision[] }
  | { status: "not_connected"; reasons: string[] }
  | { status: "duplicate"; providerId: string; ledgerEntryId: string }
  | { status: "unsettled"; providerId: string; idempotencyKey: string; ledgerEntryId: string; reason: string; decisions: Decision[] };

export type GenerateInput = {
  sql: Sql;
  organizationId: string;
  requestId: string;
  reservationId: string;
  spec: AssetSpec;
  visualType: string;
};

/** Makes the generated take. generate submits; settle finishes a submit once the poller has its answer (Bible 15.2). */

export interface ShotGenerator {
  generate(input: GenerateInput): Promise<ShotProduction>;
  settle(input: GenerateInput, job: AssetJob, polled: ProviderPoll): Promise<ShotProduction>;
}

export type StockSearch = (input: { organizationId: string; query: string; minDurationMs: number }) => Promise<StockOutcome>;

export type ProduceShotPorts = {
  generator: ShotGenerator;
  stock: StockSearch;
  downloader: MediaDownloader;
  /** Only probe is used here. */
  media: Pick<MediaFunctions, "probe">;
  /** Object storage for the take's media (Bible 5.2). */
  objects: MediaStorePort;
  now?: () => number;
  /**
   * Whether the component library draws a closing component (a chain's player). Absent, the library itself answers. A chain whose
   * closing component is not drawn is refused before its first call, so no frame is paid for a shot that cannot be drawn.
   */
  componentHas?: (component: string) => boolean;
  /**
   * Makes a chain's input (a reference or a frame the provider reads) into a link the provider can fetch: an https URL (Bible 10.1).
   * The stored uri of a call's output or of a kit image is not one. Absent, the stored uri is sent as it is, and an adapter that needs
   * https refuses it before any call. A link that cannot be made for an input stops the chain as a hold (the call is not made). A link
   * service that is not connected is thrown, as a config error, so nothing is sent.
   */
  providerUrl?: (input: { organizationId: string; uri: string }) => Promise<string>;
};

/** Turns a router report into a ShotProduction. The router's facts are kept; nothing is inferred. */

export type Refused = { kind: "hold"; hold: ProduceHold };

export type Stored = { kind: "take"; takeId: string; artifacts: Record<string, string> };

/** The request's brand, which the media store is keyed by. A request with no brand has no media store (fail closed). */

export type ShotChoices = ReadonlyMap<string, ModelChoice>;
