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
    status(env = process.env) {
      const hasToken = Boolean(env.META_ACCESS_TOKEN?.trim());
      const hasAccount = Boolean(env.META_AD_ACCOUNT_ID?.trim());
      if (hasToken && hasAccount) {
        return { status: "CONFIGURED", provider: "meta", detail: "Meta Ads credentials configured." };
      }
      return { status: "NOT_CONNECTED", provider: "meta", detail: "Meta Ads credentials (token/account) missing." };
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

export function testPublishEngine(): PublishEngine {
  return {
    id: "test",
    name: "Test / Sandbox Publisher",
    status() {
      return { status: "CONFIGURED", provider: "test", detail: "Test publisher is always ready for sandbox verification." };
    },
    async publishPaused(request: PublishPausedRequest): Promise<PublishEngineResult> {
      const stages: PausedStage[] = [
        { objectType: "campaign", status: "stored", externalId: `test_camp_${Date.now()}`, reused: false, error: "" },
        { objectType: "adset", status: "stored", externalId: `test_set_${Date.now()}`, reused: false, error: "" },
        { objectType: "adcreative", status: "stored", externalId: `test_creative_${Date.now()}`, reused: false, error: "" },
        { objectType: "ad", status: "stored", externalId: `test_ad_${Date.now()}`, reused: false, error: "" },
      ];
      return { engineId: "test", ok: true, stages };
    },
  };
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
