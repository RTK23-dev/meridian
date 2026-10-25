// The remaining disabled paths, each called through its production default. The gated call has no transport or fetch injected, so the
// gate is what refuses it. Where the entry point reads a credential, the test supplies one through that module's own credential seam,
// so the refusal is the gate's and not a missing key. A counting fetch stands in for the network, and each test asserts that it was
// never called. No test reaches the network, and no test calls a provider.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";
import { contractRequest } from "../decisions/contract-fixtures.ts";
import { sealSecret } from "../oauth/flow.server.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { OpenAiDecisionsEngine } from "../decisions/openai-engine.ts";
import { TypeSafeDirectJevProvider } from "../jev/router.ts";
import type { JevDecisionRequest } from "../jev/types.ts";
import { GeminiPerceptionProvider } from "../perception/multimodal.ts";
import type { PerceptionMedia } from "../perception/types.ts";
import { HiggsfieldProvider } from "../production/providers/higgsfield.ts";
import { GeminiOmniVideoProvider } from "../production/providers/omni.ts";
import type { CreativeSpec } from "../production/types.ts";
import type { CredentialResolution } from "../credentials/contract.ts";
import { solidFrame } from "../video/inspect.ts";
import { AD_ACCOUNT_PLATFORM } from "./ad-account.ts";
import { publishPausedStages } from "./live.ts";
import { enableAppAliases } from "../testing/module-aliases.ts";

// The brand-level publish imports modules under the "@/" alias, so the alias hook is registered before it is loaded.
enableAppAliases();
const { publishPausedForBrand } = await import("./publish-action.ts");

const GATE_MESSAGE = /off in this build, so nothing was sent/;
const KEY = "fixture-key-not-real";
const ORG = "org-disabled-default";

let requests = 0;

beforeEach(() => {
  requests = 0;
  mock.method(globalThis, "fetch", async () => {
    requests += 1;
    throw new Error("A disabled production default reached the network.");
  });
});

afterEach(() => {
  mock.restoreAll();
});

/** A credential the workspace holds: the module reads it through its seam, and no key is sent anywhere by this test. */
const ready = async (): Promise<CredentialResolution> => ({ status: "ready", source: "workspace", secret: KEY, fingerprint: "...real" }) as never;

const spec: CreativeSpec = {
  id: "spec-disabled-default",
  organizationId: ORG,
  brandId: "brand-disabled-default",
  title: "Disabled default",
  modality: "video",
  format: "reel",
  aspectRatio: "9:16",
  durationTargetSeconds: 5,
  hookLine: "Stop",
  script: "Proof.",
  scenes: [{ index: 0, description: "Opening shot", durationSeconds: 5 }],
};

const jevRequest: JevDecisionRequest = {
  organizationId: ORG,
  brandId: "brand-disabled-default",
  state: { description: "A creative under test" },
  questions: {
    "test.hook": {
      id: "test.hook",
      version: "1.0",
      type: "noul",
      instructions: "Is this a scroll stopper?",
      criteria: { true: "yes", false: "no" },
      evidenceRequirements: [],
    },
  },
} as never;

// A real PNG, so the media passes the provider's own validation and the request reaches its fetch.
const frame = solidFrame(16, 16, [255, 0, 0]);
const media: PerceptionMedia = {
  id: "frame-disabled-default",
  bytes: frame,
  mimeType: "image/png",
  sha256: createHash("sha256").update(frame).digest("hex"),
  timestampMs: 0,
};

describe("the remaining disabled production defaults send nothing and name the gate", () => {
  test("decision.openai: the OpenAI decisions engine, with its key, refuses through its default fetch and sends no request", async () => {
    const engine = new OpenAiDecisionsEngine({ config: { apiKey: KEY, maxRetries: 2 }, sleep: async () => {} });
    const result = await engine.decide(contractRequest());
    assert.match(result.failure?.message ?? "", GATE_MESSAGE, "the failure names the gate");
    assert.equal(requests, 0, "no request is sent to OpenAI");
  });

  test("decision.typesafe_jev: the TypeSafe direct provider, with a workspace key, refuses through its default fetch and reports the gate in each answer", async () => {
    const provider = new TypeSafeDirectJevProvider({ lookup: ready });
    const response = await provider.decide(jevRequest);
    const answers = Object.values(response.answers);
    assert.ok(answers.length > 0, "every question has an answer");
    for (const answer of answers) assert.match(answer.abstainReason ?? "", GATE_MESSAGE, `${answer.questionId} names the gate`);
    assert.equal(requests, 0, "no request is sent to TypeSafe");
  });

  test("perception.gemini: the Gemini perception provider refuses through its default fetch and sends no request", async () => {
    const provider = new GeminiPerceptionProvider("gemini-disabled-default");
    const result = await provider.perceive({ kind: "video_frames", media: [media] }, { apiKey: KEY });
    assert.match(JSON.stringify(result), GATE_MESSAGE, "the result names the gate");
    assert.equal(requests, 0, "no request is sent to Gemini");
  });

  test("generation.higgsfield_video: the Higgsfield provider, with a workspace key, refuses a submission through its default fetch", async () => {
    const provider = new HiggsfieldProvider({ lookup: ready });
    const job = await provider.submitJob(spec);
    assert.equal(job.status, "FAILED", "a refused submission is a failed job, not one of unknown outcome");
    assert.match(job.error ?? "", GATE_MESSAGE, "the job names the gate");
    assert.equal(requests, 0, "no submission is sent to Higgsfield");
  });

  test("generation.gemini_omni: the Gemini Omni provider, with a workspace key, refuses a submission through its default fetch", async () => {
    const provider = new GeminiOmniVideoProvider({ lookup: ready });
    const job = await provider.submitJob(spec);
    assert.equal(job.status, "FAILED", "a refused submission is a failed job, not one of unknown outcome");
    assert.match(job.error ?? "", GATE_MESSAGE, "the job names the gate");
    assert.equal(requests, 0, "no submission is sent to Gemini Omni");
  });

  test("ads.google_ads_write: a paused Google Ads publish refuses through its default transport and reports no created stage", async () => {
    const stages = await publishPausedStages({
      provider: "google",
      name: "Disabled default campaign",
      dailyBudgetCents: 500,
      countries: ["US"],
      pageId: "",
      link: "https://example.test/offer",
      message: "Proof",
      headlines: ["Stop"],
      descriptions: ["Proof"],
      cpcBidCents: 50,
      adAccountId: "1234567890",
      accessToken: KEY,
      // The developer token is a deployment key, read only when its shared-default switch is set. Both are fixtures here.
      env: { GOOGLE_ADS_DEVELOPER_TOKEN_SHARED_DEFAULT: "deployment", GOOGLE_ADS_DEVELOPER_TOKEN: "fixture-developer-token-not-real" },
    } as never);
    assert.ok(stages.length > 0, "the paused chain reports its stages");
    for (const stage of stages) {
      assert.notEqual(stage.status, "created", `${stage.objectType} is not reported as created`);
      assert.match(stage.error, GATE_MESSAGE, `${stage.objectType} is refused by the gate`);
    }
    assert.equal(requests, 0, "no Google Ads request is sent");
  });

  test("ads.tiktok_write: a paused TikTok publish refuses through its default transport and reports no created stage", async () => {
    const stages = await publishPausedStages({
      provider: "tiktok",
      name: "Disabled default campaign",
      dailyBudgetCents: 2000,
      countries: [],
      locationIds: ["6252001"],
      pageId: "",
      link: "https://example.test/offer",
      message: "Proof",
      scheduleStart: "2026-01-02 00:00:00",
      imageIds: ["img-disabled-default"],
      adAccountId: "7000000000001",
      accessToken: KEY,
      env: {},
    } as never);
    assert.ok(stages.length > 0, "the paused chain reports its stages");
    for (const stage of stages) {
      assert.notEqual(stage.status, "created", `${stage.objectType} is not reported as created`);
      assert.match(stage.error, GATE_MESSAGE, `${stage.objectType} is refused by the gate`);
    }
    assert.equal(requests, 0, "no TikTok request is sent");
  });
});

// The brand-level paused publish. It reads the workspace's sealed token and its saved ad account from the database, then runs the paused
// chain through publish.paused_action. These two platforms need no Hypit video, so the chain starts at once.
const WS = "ws_disabled_default";
const BRAND = "brand_disabled_default";
const AD_ACCOUNT_ID: Record<"google" | "tiktok", string> = { google: "1234567890", tiktok: "7000000000001" };
const DEPLOYMENT_ENV = {
  TOKEN_ENCRYPTION_KEY: KEY,
  GOOGLE_ADS_DEVELOPER_TOKEN_SHARED_DEFAULT: "deployment",
  GOOGLE_ADS_DEVELOPER_TOKEN: "fixture-developer-token-not-real",
};

describe("publish.paused_action: a brand's paused publish refuses through its production default", () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
    await seedWorkspace(db.sql, WS, BRAND);
    for (const provider of ["google", "tiktok"] as const) {
      await db.sql`
        insert into platform_accounts (id, organization_id, brand_id, platform, account_type, external_account_id, name)
        values (${`pa_${provider}_disabled`}, ${WS}, ${BRAND}, ${AD_ACCOUNT_PLATFORM[provider]}, 'ad_account', ${AD_ACCOUNT_ID[provider]}, ${`Fixture ${provider}`})
      `;
      const sealed = sealSecret(`${provider}-token-not-real`, KEY);
      assert.equal(typeof sealed, "string", "the fixture token must seal");
      await db.sql`insert into provider_secrets (id, organization_id, provider, sealed_token) values (${`ps_${provider}_disabled`}, ${WS}, ${provider}, ${sealed as string})`;
    }
  });

  after(async () => {
    await db.close();
  });

  for (const provider of ["google", "tiktok"] as const) {
    test(`${provider}: the paused chain stops at the gate, reports no created stage, and sends no request`, async () => {
      const view = await publishPausedForBrand(db.sql, {
        organizationId: WS,
        brandId: BRAND,
        actorId: "user_disabled_default",
        provider,
        creativeId: "creative_disabled_default",
        name: "Disabled brand campaign",
        dailyBudgetCents: 500,
        countries: ["US"],
        locationIds: ["6252001"],
        pageId: "",
        link: "https://example.test/offer",
        message: "Proof",
        scheduleStart: "2026-01-02 00:00:00",
        imageIds: ["img-disabled-default"],
        videoId: "vid-disabled-default",
        headlines: ["Stop"],
        descriptions: ["Proof"],
        cpcBidCents: 50,
        env: DEPLOYMENT_ENV,
      });
      assert.ok(view.stages.length > 0, "the paused chain reports its stages");
      for (const stage of view.stages) {
        assert.notEqual(stage.status, "created", `${stage.objectType} is not reported as created`);
        // The brand-level view names the failure in `detail`. The gate's reason is the one publish.paused_action gives.
        assert.match(stage.detail, GATE_MESSAGE, `${stage.objectType} is refused by the gate`);
      }
      assert.equal(requests, 0, "no request reaches the provider");
    });
  }
});
