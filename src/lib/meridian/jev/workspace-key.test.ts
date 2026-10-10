import assert from "node:assert/strict";
import test from "node:test";
import { JevRouter, TypeSafeDirectJevProvider } from "./router.ts";
import type { JevDecisionRequest } from "./types.ts";
import { jevCallContext } from "../decisions/dispatcher.ts";
import { storeVaultCredential } from "../vault/service.ts";
import { CREDENTIAL_VAULT_TYPE } from "../credentials/contract.ts";
import { fakeVaultSql, withEnv } from "../testing/fake-vault-sql.ts";

const WORKSPACE_KEY = "workspace-typesafe-key-1234";
const DEPLOYMENT_KEY = "deployment-typesafe-key-9876";

const request: JevDecisionRequest = {
  organizationId: "org-a",
  brandId: "brand-a",
  state: { description: "A creative under review" },
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
};

/** Records the Authorization header of every TypeSafe request, and answers with no answers. */
function recordingFetch(sent: Array<Record<string, string>>): typeof fetch {
  return (async (_url, init) => {
    sent.push((init?.headers as Record<string, string>) || {});
    return new Response(JSON.stringify({ model: "typesafe/jev-1.13", answers: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function typesafeRouter(sent: Array<Record<string, string>>) {
  return new JevRouter({
    typesafeProvider: new TypeSafeDirectJevProvider({ fetchImpl: recordingFetch(sent), baseUrl: "https://typesafe.example.test/v1" }),
  });
}

test("JEV runtime: a workspace's TypeSafe key is sent only for that organization's calls", async () => {
  await withEnv({}, async () => {
    const { sql } = fakeVaultSql();
    await storeVaultCredential(sql, "org-a", CREDENTIAL_VAULT_TYPE.jev, { accessToken: "", apiKey: WORKSPACE_KEY, customFields: {} });

    const sent: Array<Record<string, string>> = [];
    const router = typesafeRouter(sent);

    const contextA = await jevCallContext(sql, "org-a");
    await router.decide(request, { mode: "typesafe_direct" }, contextA);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].Authorization, `Bearer ${WORKSPACE_KEY}`, "org A's own key is used");

    const contextB = await jevCallContext(sql, "org-b");
    assert.deepEqual(contextB, {}, "org B has no key of its own, so none is resolved");
    const otherTenant = await router.decide({ ...request, organizationId: "org-b" }, { mode: "typesafe_direct" }, contextB);
    assert.equal(sent.length, 1, "org B's call must not reach TypeSafe with org A's key");
    assert.equal(otherTenant.answers["test.hook"].status, "not_configured");
  });
});

test("JEV runtime: the deployment TypeSafe key is not used unless the operator opts in", async () => {
  await withEnv({ TYPESAFE_JEV_API_KEY: DEPLOYMENT_KEY }, async () => {
    const { sql } = fakeVaultSql();
    assert.deepEqual(await jevCallContext(sql, "org-x"), {}, "a deployment key without the opt-in is not a JEV key");
    const health = await new JevRouter({ typesafeProvider: new TypeSafeDirectJevProvider() }).health(undefined, await jevCallContext(sql, "org-x"));
    assert.equal(health.typesafe_direct.status, "NOT_CONFIGURED");
  });

  await withEnv({ TYPESAFE_JEV_API_KEY: DEPLOYMENT_KEY, JEV_SHARED_DEFAULT: "deployment" }, async () => {
    const { sql } = fakeVaultSql();
    const context = await jevCallContext(sql, "org-x");
    assert.deepEqual(context, { typesafeKey: DEPLOYMENT_KEY }, "with the opt-in the deployment key is the shared default");
  });
});

test("JEV runtime: with no database connection the TypeSafe transport is not available and sends nothing", async () => {
  await withEnv({ JEV_SHARED_DEFAULT: "deployment", TYPESAFE_JEV_API_KEY: DEPLOYMENT_KEY }, async () => {
    const sent: Array<Record<string, string>> = [];
    const context = await jevCallContext(undefined, "org-a");
    assert.deepEqual(context, {});
    const result = await typesafeRouter(sent).decide(request, { mode: "typesafe_direct" }, context);
    assert.equal(sent.length, 0, "no TypeSafe request is sent without a resolved key");
    assert.equal(result.answers["test.hook"].status, "not_configured");
  });
});

test("JEV runtime: the TypeSafe transport never reads the deployment key by itself", async () => {
  await withEnv({ JEV_SHARED_DEFAULT: "deployment", TYPESAFE_JEV_API_KEY: DEPLOYMENT_KEY }, async () => {
    const health = await new TypeSafeDirectJevProvider().health();
    assert.equal(health.status, "NOT_CONFIGURED", "a bare transport has no key, even with the opt-in set");
  });
});
