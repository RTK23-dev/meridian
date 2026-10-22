import { createHash } from "node:crypto";
import { publishPausedStages, type PausedStage } from "../providers/live.ts";
import type { Transport } from "../providers/http.ts";

export type PublishEngineStatus =
  | { status: "CONFIGURED"; provider: string; detail: string }
  | { status: "NOT_CONNECTED"; provider: string; detail: string };

export type PublishPausedRequest = {
  name: string;
  dailyBudgetCents: number;
  countries: string[];
  pageId: string;
  link: string;
  message: string;
  videoId?: string;
  imageIds?: string[];
  accessToken?: string;
  /** The brand's saved Meta ad account (Connected accounts). A publish needs it. */
  adAccountId?: string;
  env?: NodeJS.ProcessEnv;
  transport?: Transport;
};

export type PublishEngineResult = {
  engineId: string;
  ok: boolean;
  stages: PausedStage[];
  error?: string;
};

export type PublishEngine = {
  id: string;
  name: string;
  status(env?: NodeJS.ProcessEnv): PublishEngineStatus;
  publishPaused(request: PublishPausedRequest): Promise<PublishEngineResult>;
};

export function metaPublishEngine(): PublishEngine {
  return {
    id: "meta",
    name: "Meta Ads Paused Publisher",
    status() {
      // The token is the one stored for the workspace, and this check has no workspace in scope. An environment token is not
      // read, so this never claims a connection. The publish itself reports the real state.
      return {
        status: "NOT_CONNECTED",
        provider: "meta",
        detail: "Meta Ads publishing needs the access token stored for this workspace. The environment is not checked.",
      };
    },
    async publishPaused(request: PublishPausedRequest): Promise<PublishEngineResult> {
      try {
        const stages = await publishPausedStages({
          provider: "meta",
          name: request.name,
          dailyBudgetCents: request.dailyBudgetCents,
          countries: request.countries,
          pageId: request.pageId,
          link: request.link,
          message: request.message,
          videoId: request.videoId,
          imageIds: request.imageIds,
          accessToken: request.accessToken,
          adAccountId: request.adAccountId,
          env: request.env,
          transport: request.transport,
        });
        const ok = stages.length > 0 && stages.every((s) => s.status === "stored");
        return { engineId: "meta", ok, stages };
      } catch (err) {
        return {
          engineId: "meta",
          ok: false,
          stages: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

/**
 * The fixture paid publisher for the testing runtime. It makes no request. Its four stages have the names and the order the Meta
 * publisher returns (`publishMetaPaused` in providers/meta.ts): a campaign, an ad set, an ad creative and an ad. Each is created
 * with status PAUSED, as the Meta Marketing API documents for campaigns, ad sets and ads
 * (https://developers.facebook.com/docs/marketing-api/reference/ad-account/campaigns/,
 * https://developers.facebook.com/docs/marketing-api/reference/ad-campaign/,
 * https://developers.facebook.com/docs/marketing-api/reference/ad-account/ads/). An ad creative has no status. Its ids are a digest
 * of the request name and the stage, so a repeated publish names the same objects. The ids are not Meta ids.
 */
export function testPublishEngine(): PublishEngine {
  return {
    id: "test",
    name: "Test / Sandbox Publisher",
    status() {
      return { status: "CONFIGURED", provider: "test", detail: "Test publisher is always ready for sandbox verification." };
    },
    async publishPaused(request: PublishPausedRequest): Promise<PublishEngineResult> {
      const stages: PausedStage[] = PAUSED_STAGE_ORDER.map((objectType) => ({
        objectType,
        status: "stored",
        externalId: `test_${objectType}_${fixtureDigest(`${request.name}|${objectType}`)}`,
        reused: false,
        error: "",
      }));
      return { engineId: "test", ok: true, stages };
    },
  };
}

/** The stages a paused paid publish creates, in the order Meta creates them. */
export const PAUSED_STAGE_ORDER = ["campaign", "ad_set", "creative", "ad"] as const;

function fixtureDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

const customPublishEngines = new Map<string, PublishEngine>();

export function registerPublishEngine(engine: PublishEngine): void {
  customPublishEngines.set(engine.id, engine);
}

export function publishEngineById(id: string): PublishEngine {
  if (customPublishEngines.has(id)) {
    return customPublishEngines.get(id)!;
  }
  if (id === "meta") return metaPublishEngine();
  if (id === "test") return testPublishEngine();
  throw new Error(`Unknown publish engine "${id}". Supported: meta, test.`);
}
