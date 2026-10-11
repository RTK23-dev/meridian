import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import {
  BRAIN,
  BRIEF,
  CLAIM_QUESTION,
  answeredProbability,
  approvesBrief,
  approvesBriefCalibrated,
  calibratedProbability,
  createBrief,
  registryWith,
  stubEngine,
} from "../testing/brief-fixtures.ts";
import {
  addMember,
  failingSql,
  seedBrandBrain,
  seedCompetitorCreative,
  seedOpportunity,
} from "../testing/opportunity-fixtures.ts";
import { enableAppAliases } from "../testing/module-aliases.ts";
import { briefGateJudge, createGatedBrief, type BriefGateOptions } from "./brief-service.server.ts";
import type { BriefRecord } from "./brief-service.contract.ts";
import { briefStatusFor, loadBriefReviewDisclosure } from "./brief-review.server.ts";
import { judgeBriefFit } from "./brief-gate.server.ts";

// The paths under test import modules that use the "@/" alias, so the alias hook is registered before they are loaded.
enableAppAliases();
const { createBriefFromOpportunityFor } = await import("./opportunity-brief.server.ts");
const { generateCreativeFor } = await import("./creative-generation.server.ts");
const { openStudioBriefFor } = await import("./brief-open.server.ts");
const { reviewBriefForUser } = await import("./brief-review-access.server.ts");
const { recordOpportunityDirection } = await import("../opportunity/actions.ts");

/** The studio's open-brief action, run against the test database. */
async function openStudioBrief(
  userId: string,
  data: { brandId: string; forceNew: boolean; reason: string; opportunityId?: string },
  gate: BriefGateOptions = {},
): Promise<void> {
  await openStudioBriefFor(await getSql(), userId, data, gate);
}

const OUTCOMES = ["AUTO_APPROVE", "HUMAN_REVIEW", "REJECT"] as const;
type Outcome = (typeof OUTCOMES)[number];
const DISCOVERED_ANGLE = "quiet_dinner_speed";
const REASON = "The stored competitor evidence supports this direction for the brief.";
const REVIEW_REASON = "Reviewed the disclosed failure. The brand fit is clear from the positioning and the copy.";

/**
 * The gate setup that produces each outcome. The engines are stubs; the gate, its policy and the writer are the real ones.
 * AUTO_APPROVE and REJECT are calibrated answers: an uncalibrated probability can only go to review (contract section 6), so
 * a test about approval or rejection must report calibrated values. HUMAN_REVIEW is a provider failure on the selected engine.
 */
function gateFor(outcome: Outcome): BriefGateOptions {
  if (outcome === "AUTO_APPROVE") {
    return {
      engines: registryWith(stubEngine("jev", { respond: approvesBriefCalibrated }), stubEngine("openai-decisions")),
      selection: { engineId: "jev", source: "workspace" },
    };
  }
  if (outcome === "HUMAN_REVIEW") {
    return {
      engines: registryWith(stubEngine("jev"), stubEngine("openai-decisions", { failure: true })),
      selection: { engineId: "openai-decisions", source: "workspace" },
    };
  }
  const jev = stubEngine("jev", {
    respond: (spec) => (spec.id === CLAIM_QUESTION ? calibratedProbability(spec, 0.2) : approvesBriefCalibrated(spec)),
  });
  return { engines: registryWith(jev, stubEngine("openai-decisions")), selection: { engineId: "jev", source: "workspace" } };
}

function briefRecord(opportunityId: string | null): BriefRecord {
  return {
    opportunityId,
    title: "Gate test brief",
    audience: BRIEF.audience,
    angle: BRIEF.angle,
    hook: BRIEF.hook,
    message: BRIEF.message,
    offer: "",
    cta: BRIEF.cta,
    format: BRIEF.format,
    proofType: "",
    constraints: "",
    context: {},
    workflow: "test",
    why: [],
    learningNotes: [],
    failureNotes: [],
  };
}

function judgeFor(sql: Sql, tenant: { organizationId: string; brandId: string }, gate: BriefGateOptions) {
  return briefGateJudge(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, brief: BRIEF, brain: BRAIN, ...gate });
}

/** Counts the transactions a Sql opens, and how many are open at a given moment. */
function trackTransactions(base: Sql) {
  const state = { open: 0, begun: 0 };
  const wrap = (inner: Sql): Sql => {
    const tagged = ((strings: TemplateStringsArray, ...values: unknown[]) => inner(strings, ...values)) as unknown as Sql;
    tagged.query = ((text: string, params?: unknown[]) => inner.query(text, params)) as Sql["query"];
    if (inner.begin) {
      const begin = inner.begin.bind(inner);
      tagged.begin = (<T>(fn: (tx: Sql) => Promise<T>) => {
        state.begun += 1;
        state.open += 1;
        return begin<T>((tx) => fn(wrap(tx))).finally(() => {
          state.open -= 1;
        });
      }) as Sql["begin"];
    }
    return tagged;
  };
  return { sql: wrap(base), state };
}

async function latestOpportunityBrief(sql: Sql, brandId: string) {
  const [row] = await sql<{ id: string; status: string; decision_id: string }>`
    select id, status, decision_id from briefs
    where brand_id = ${brandId} and opportunity_id is not null
    order by created_at desc limit 1
  `;
  return row;
}

for (const outcome of OUTCOMES) {
  test(`createGatedBrief: a ${outcome} outcome stores the brief with briefStatusFor(${outcome}), and only AUTO_APPROVE is ready`, async () => {
    const sql = await getSql();
    const tenant = await studioTenant(sql, `svc-direct-${outcome}`);
    const opportunity = await seedOpportunity(sql, tenant);
    const created = await createGatedBrief(sql, {
      organizationId: tenant.organizationId,
      brandId: tenant.brandId,
      createdBy: tenant.userId,
      brief: briefRecord(opportunity.opportunityId),
      judge: judgeFor(sql, tenant, gateFor(outcome)),
    });
    assert.equal(created.action, outcome);
    assert.equal(created.status, briefStatusFor(outcome));
    const [brief] = await sql<{ status: string; decision_id: string }>`select status, decision_id from briefs where id = ${created.briefId}`;
    assert.equal(brief?.status, briefStatusFor(outcome));
    assert.equal(brief?.status === "ready", outcome === "AUTO_APPROVE", "only an automatic approval is ready");
    const [decision] = await sql<{ decision: string; reviewer_decision: string | null }>`
      select decision, reviewer_decision from jev_decisions where id = ${brief?.decision_id ?? ""}
    `;
    assert.equal(decision?.decision, outcome, "the decision row carries the gate outcome");
    assert.equal(decision?.reviewer_decision, null, "creation records no approval");
    const [opportunityRow] = await sql<{ status: string }>`select status from opportunities where id = ${opportunity.opportunityId}`;
    assert.equal(opportunityRow?.status, outcome === "REJECT" ? "open" : "briefed", "a rejected brief does not mark its opportunity briefed");
  });

  test(`createBriefFromOpportunity: a ${outcome} outcome is stored with the status its gate outcome gives`, async () => {
    const sql = await getSql();
    const tenant = await studioTenant(sql, `svc-opportunity-${outcome}`);
    await seedBrandBrain(sql, tenant);
    // A HUMAN_REVIEW opportunity is held until a person records its direction. That is the path a held brief takes.
    const opportunity = await seedOpportunity(sql, tenant, { outcome: outcome === "HUMAN_REVIEW" ? "HUMAN_REVIEW" : "AUTO_APPROVE" });
    if (outcome === "HUMAN_REVIEW") {
      await recordOpportunityDirection(sql, {
        organizationId: tenant.organizationId,
        brandId: tenant.brandId,
        opportunityId: opportunity.opportunityId,
        actorId: tenant.userId,
        actorRole: "member",
        action: "approve",
        reason: REASON,
      });
    }
    const made = await createBriefFromOpportunityFor(tenant.userId, { brandId: tenant.brandId, opportunityId: opportunity.opportunityId }, gateFor(outcome));
    assert.equal(made.decision, outcome);
    const [brief] = await sql<{ status: string }>`select status from briefs where id = ${made.id}`;
    assert.equal(brief?.status, briefStatusFor(outcome));
    const [opportunityRow] = await sql<{ status: string }>`select status from opportunities where id = ${opportunity.opportunityId}`;
    assert.equal(opportunityRow?.status === "briefed", outcome !== "REJECT");
  });

  test(`openStudioBrief: a ${outcome} outcome stores the brief with briefStatusFor(${outcome}), through the real ranking`, async () => {
    const sql = await getSql();
    const tenant = await studioTenant(sql, `svc-studio-${outcome}`);
    await seedBrandBrain(sql, tenant);
    await seedCompetitorCreative(sql, tenant, DISCOVERED_ANGLE);
    const attempt = openStudioBrief(tenant.userId, { brandId: tenant.brandId, forceNew: false, reason: REASON }, gateFor(outcome));
    if (outcome === "REJECT") {
      await assert.rejects(attempt, /brief gate rejected/, "a rejected brief is refused to the person, with its reason");
    } else {
      await attempt;
    }
    const row = await latestOpportunityBrief(sql, tenant.brandId);
    assert.ok(row, "the brief was stored");
    assert.equal(row.status, briefStatusFor(outcome));
    const [decision] = await sql<{ decision: string }>`select decision from jev_decisions where id = ${row.decision_id}`;
    assert.equal(decision?.decision, outcome);
  });
}

test("an uncalibrated approval is held for review on every creation path, and is never stored as ready", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "svc-cap-approve");
  await seedBrandBrain(sql, tenant);
  const uncalibrated: BriefGateOptions = {
    engines: registryWith(stubEngine("jev", { respond: approvesBrief }), stubEngine("openai-decisions")),
    selection: { engineId: "jev", source: "workspace" },
  };
  const first = await seedOpportunity(sql, tenant);
  const direct = await createGatedBrief(sql, {
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    createdBy: tenant.userId,
    brief: briefRecord(first.opportunityId),
    judge: judgeFor(sql, tenant, uncalibrated),
  });
  assert.equal(direct.action, "HUMAN_REVIEW", "an uncalibrated approval is capped to review");
  assert.equal(direct.status, "awaiting_review");
  const [decision] = await sql<{ reasons: string }>`select reasons from jev_decisions where id = ${direct.decisionId}`;
  assert.match(decision?.reasons ?? "", /uncalibrated/, "the recorded reason says why it was held");

  const second = await seedOpportunity(sql, tenant);
  const made = await createBriefFromOpportunityFor(tenant.userId, { brandId: tenant.brandId, opportunityId: second.opportunityId }, uncalibrated);
  assert.equal(made.decision, "HUMAN_REVIEW", "the opportunity path is capped the same way");
  const [brief] = await sql<{ status: string }>`select status from briefs where id = ${made.id}`;
  assert.equal(brief?.status, "awaiting_review");
});

test("an uncalibrated claim-compliance rejection is held for review, not rejected: only a calibrated probability rejects", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "svc-cap-reject");
  const opportunity = await seedOpportunity(sql, tenant);
  const jev = stubEngine("jev", {
    respond: (spec) => (spec.id === CLAIM_QUESTION ? answeredProbability(spec, 0.2) : approvesBriefCalibrated(spec)),
  });
  const created = await createGatedBrief(sql, {
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    createdBy: tenant.userId,
    brief: briefRecord(opportunity.opportunityId),
    judge: judgeFor(sql, tenant, { engines: registryWith(jev, stubEngine("openai-decisions")), selection: { engineId: "jev", source: "workspace" } }),
  });
  assert.equal(created.action, "HUMAN_REVIEW", "an uncalibrated low claim score is review, not a rejection");
  assert.equal(created.status, "awaiting_review");
});

test("a HUMAN_REVIEW brief from an opportunity is held, reviewable with its engine outcome, and an admin can release it", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "svc-held-review");
  await seedBrandBrain(sql, tenant);
  const opportunity = await seedOpportunity(sql, tenant, { outcome: "HUMAN_REVIEW" });
  const failing = gateFor("HUMAN_REVIEW");
  // The hold blocks the brief until a person records the direction.
  await assert.rejects(
    createBriefFromOpportunityFor(tenant.userId, { brandId: tenant.brandId, opportunityId: opportunity.opportunityId }, failing),
    /review hold/,
  );
  await recordOpportunityDirection(sql, {
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    opportunityId: opportunity.opportunityId,
    actorId: tenant.userId,
    actorRole: "member",
    action: "approve",
    reason: REASON,
  });
  const made = await createBriefFromOpportunityFor(tenant.userId, { brandId: tenant.brandId, opportunityId: opportunity.opportunityId }, failing);
  assert.equal(made.decision, "HUMAN_REVIEW");
  const [brief] = await sql<{ status: string; decision_id: string }>`select status, decision_id from briefs where id = ${made.id}`;
  assert.equal(brief?.status, "awaiting_review", "the brief is held");

  const disclosure = await loadBriefReviewDisclosure(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, briefId: made.id });
  assert.equal(disclosure.reviewable, true, "a held opportunity brief is reviewable");
  assert.equal(disclosure.decision, "HUMAN_REVIEW", "the disclosure lists the engine outcome");
  assert.equal(disclosure.engineId, "openai-decisions");
  assert.equal(disclosure.failureKind, "provider_unavailable");
  assert.notEqual(disclosure.gateRecordId, null, "the brief has its gate record");

  const adminId = await addMember(sql, tenant, "admin");
  await assert.rejects(
    reviewBriefForUser(sql, tenant.userId, { brandId: tenant.brandId, briefId: made.id, action: "approve", reason: REVIEW_REASON, acknowledged: true }),
    "the creator, as a member, cannot release the brief",
  );
  const reviewed = await reviewBriefForUser(sql, adminId, {
    brandId: tenant.brandId,
    briefId: made.id,
    action: "approve",
    reason: REVIEW_REASON,
    acknowledged: true,
  });
  assert.equal(reviewed.briefStatus, "ready", "an admin releases the held brief");
  const [released] = await sql<{ status: string }>`select status from briefs where id = ${made.id}`;
  assert.equal(released?.status, "ready");
});

test("the judge runs before any transaction opens, and the decision, the brief and the opportunity mark share one transaction", async () => {
  const base = await getSql();
  const tenant = await studioTenant(base, "svc-judge-order");
  const opportunity = await seedOpportunity(base, tenant);
  const { sql, state } = trackTransactions(base);
  const judgeGate = judgeFor(base, tenant, gateFor("AUTO_APPROVE"));
  const seen: Array<{ open: number; rowsForBrief: number }> = [];
  const created = await createGatedBrief(sql, {
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    createdBy: tenant.userId,
    brief: briefRecord(opportunity.opportunityId),
    judge: async (briefId) => {
      const [count] = await base<{ count: number }>`select count(*)::int as count from briefs where id = ${briefId}`;
      seen.push({ open: state.open, rowsForBrief: count?.count ?? -1 });
      return judgeGate(briefId);
    },
  });
  assert.deepEqual(seen, [{ open: 0, rowsForBrief: 0 }], "the engine call ran with no transaction open, before the brief existed");
  assert.equal(state.begun, 1, "the writes after the judgment share one transaction");
  assert.equal(created.status, "ready");
});

test("a failed write inside createGatedBrief rolls the whole brief back: no brief, no decision, and the opportunity is unchanged", async () => {
  for (const pattern of [/insert into briefs/, /update opportunities set status = 'briefed'/]) {
    const base = await getSql();
    const tenant = await studioTenant(base, `svc-rollback-${pattern.source.length}-${Math.random().toString(36).slice(2, 6)}`);
    const opportunity = await seedOpportunity(base, tenant);
    const judgeGate = judgeFor(base, tenant, gateFor("AUTO_APPROVE"));
    let judgedBriefId = "";
    await assert.rejects(
      createGatedBrief(failingSql(base, pattern), {
        organizationId: tenant.organizationId,
        brandId: tenant.brandId,
        createdBy: tenant.userId,
        brief: briefRecord(opportunity.opportunityId),
        judge: async (briefId) => {
          judgedBriefId = briefId;
          return judgeGate(briefId);
        },
      }),
      /injected write failure/,
      `a failure at ${pattern.source} is raised`,
    );
    assert.notEqual(judgedBriefId, "", "the judgment ran before the failed write");
    const [briefs] = await base<{ count: number }>`select count(*)::int as count from briefs where id = ${judgedBriefId}`;
    assert.equal(briefs?.count, 0, `no brief row survives a failure at ${pattern.source}`);
    const [decisions] = await base<{ count: number }>`select count(*)::int as count from jev_decisions where subject_id = ${judgedBriefId}`;
    assert.equal(decisions?.count, 0, `no decision row survives a failure at ${pattern.source}`);
    const [opportunityRow] = await base<{ status: string }>`select status from opportunities where id = ${opportunity.opportunityId}`;
    assert.equal(opportunityRow?.status, "open", `the opportunity is not marked briefed after a failure at ${pattern.source}`);
  }
});

test("openStudioBrief records the direction with who and why, and never writes the opportunity's reviewer_decision", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "svc-direction-approve");
  await seedBrandBrain(sql, tenant);
  await seedCompetitorCreative(sql, tenant, DISCOVERED_ANGLE);
  await openStudioBrief(tenant.userId, { brandId: tenant.brandId, forceNew: false, reason: REASON }, gateFor("AUTO_APPROVE"));
  const [direction] = await sql<{ actor_id: string; actor_role: string; action: string; reason: string }>`
    select actor_id, actor_role, action, reason from opportunity_direction_decisions where brand_id = ${tenant.brandId}
  `;
  assert.equal(direction?.actor_id, tenant.userId, "who");
  assert.equal(direction?.actor_role, "member");
  assert.equal(direction?.action, "approve");
  assert.equal(direction?.reason, REASON, "why");
  const [approved] = await sql<{ count: number }>`
    select count(*)::int as count from jev_decisions
    where brand_id = ${tenant.brandId} and subject_type = 'opportunity' and reviewer_decision is not null
  `;
  assert.equal(approved?.count, 0, "accepting a direction writes no reviewer_decision on any opportunity decision");
});

test("the next brief (forceNew) is written when it is given a reason, and is refused without one", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "svc-next-brief");
  await seedBrandBrain(sql, tenant);
  await seedCompetitorCreative(sql, tenant, DISCOVERED_ANGLE);
  const gate = gateFor("AUTO_APPROVE");
  await openStudioBrief(tenant.userId, { brandId: tenant.brandId, forceNew: false, reason: REASON }, gate);
  const [first] = await sql<{ count: number }>`select count(*)::int as count from briefs where brand_id = ${tenant.brandId} and opportunity_id is not null`;
  assert.equal(first?.count, 1, "the first brief is written");

  await assert.rejects(
    openStudioBrief(tenant.userId, { brandId: tenant.brandId, forceNew: true, reason: "" }, gate),
    /at least 20 characters/,
    "the next brief needs a reason, as the accept does",
  );
  await openStudioBrief(tenant.userId, { brandId: tenant.brandId, forceNew: true, reason: "Write the next brief from what the test learned." }, gate);
  const [second] = await sql<{ count: number }>`select count(*)::int as count from briefs where brand_id = ${tenant.brandId} and opportunity_id is not null`;
  assert.equal(second?.count, 2, "the next brief is written");
  const [directions] = await sql<{ count: number }>`select count(*)::int as count from opportunity_direction_decisions where brand_id = ${tenant.brandId}`;
  assert.equal(directions?.count, 2, "each brief has its own recorded direction");
});

test("openStudioBrief refuses a reason shorter than 20 characters before ranking or writing anything", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "svc-short-reason");
  await assert.rejects(
    openStudioBrief(tenant.userId, { brandId: tenant.brandId, forceNew: false, reason: "   Nineteen char reaso   " }, gateFor("AUTO_APPROVE")),
    /at least 20 characters/,
  );
  const [directions] = await sql<{ count: number }>`select count(*)::int as count from opportunity_direction_decisions where brand_id = ${tenant.brandId}`;
  const [opportunities] = await sql<{ count: number }>`select count(*)::int as count from opportunities where brand_id = ${tenant.brandId}`;
  assert.equal(directions?.count, 0, "no direction is recorded");
  assert.equal(opportunities?.count, 0, "ranking did not run, so no opportunity was written");
});

test("a viewer cannot accept a direction or write a brief from an opportunity", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "svc-viewer");
  await seedBrandBrain(sql, tenant);
  const viewerId = await addMember(sql, tenant, "viewer");
  const opportunity = await seedOpportunity(sql, tenant);
  await assert.rejects(openStudioBrief(viewerId, { brandId: tenant.brandId, forceNew: false, reason: REASON }, gateFor("AUTO_APPROVE")));
  await assert.rejects(createBriefFromOpportunityFor(viewerId, { brandId: tenant.brandId, opportunityId: opportunity.opportunityId }, gateFor("AUTO_APPROVE")));
  const [directions] = await sql<{ count: number }>`select count(*)::int as count from opportunity_direction_decisions where brand_id = ${tenant.brandId}`;
  assert.equal(directions?.count, 0);
});

/** The copy the stubbed text model answers with. Only the request count matters to the refusal tests. */
const COPY = { hook: "Dinner in ten minutes", script: "A calm dinner plan that needs no planning.", offer: "", cta: "See it in use", visualTreatment: "Kitchen counter", claims: [] };

/**
 * Replaces the text model for one test. The chat provider is OpenRouter over fetch, so the stub counts the requests the process
 * sends to it. The environment and fetch are restored afterwards.
 */
async function withTextModel<T>(run: (calls: { count: number }) => Promise<T>): Promise<T> {
  const saved = {
    fetch: globalThis.fetch,
    key: process.env.OPENROUTER_API_KEY,
    model: process.env.OPENROUTER_MODEL,
    shared: process.env.OPENROUTER_SHARED_DEFAULT,
  };
  const calls = { count: 0 };
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.OPENROUTER_MODEL = "test-model";
  // The deployment key is used only when the deployment opts in, the same as in production.
  process.env.OPENROUTER_SHARED_DEFAULT = "deployment";
  globalThis.fetch = (async () => {
    calls.count += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(COPY) } }], usage: { total_tokens: 12 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.key === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = saved.key;
    if (saved.model === undefined) delete process.env.OPENROUTER_MODEL;
    else process.env.OPENROUTER_MODEL = saved.model;
    if (saved.shared === undefined) delete process.env.OPENROUTER_SHARED_DEFAULT;
    else process.env.OPENROUTER_SHARED_DEFAULT = saved.shared;
  }
}

for (const outcome of ["HUMAN_REVIEW", "REJECT"] as const) {
  test(`generateCreative: a ${outcome} brief is refused before any text model is called, and no model run is recorded`, async () => {
    const sql = await getSql();
    const tenant = await studioTenant(sql, `svc-generate-${outcome}`);
    const made = await createBrief(sql, tenant, {
      engines: registryWith(stubEngine("jev"), stubEngine("openai-decisions", { failure: true })),
      selected: { engineId: "openai-decisions", source: "workspace" },
      // A brief with no hook is a deterministic rejection: no engine is asked, and the brief is stored as rejected.
      brief: outcome === "REJECT" ? { ...BRIEF, hook: "" } : undefined,
    });
    assert.equal(made.action, outcome);
    await withTextModel(async (calls) => {
      await assert.rejects(
        generateCreativeFor(tenant.userId, { brandId: tenant.brandId, briefId: made.briefId }),
        outcome === "HUMAN_REVIEW" ? /awaiting review/ : /did not pass the gate/,
      );
      assert.equal(calls.count, 0, "no text model was called for a brief that production refuses");
    });
    const [runs] = await sql<{ count: number }>`select count(*)::int as count from model_runs where input_ref = ${made.briefId}`;
    assert.equal(runs?.count, 0, "no model run was recorded for the refused brief");
  });
}

test("generateCreative: a ready brief calls the text model once and records the run (the control for the refusals)", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "svc-generate-ready");
  // A brief built the way the brief builder builds one: the context carries its observations, and the workflow is an object.
  const ready = await createGatedBrief(sql, {
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    createdBy: tenant.userId,
    brief: {
      ...briefRecord(null),
      context: { brandPositioning: BRAIN.positioning, untrustedObservations: [] },
      why: ["Why this brief exists."],
      workflow: { templateId: "", templateVersion: "", label: "", stages: [], variables: { product: "" } },
    },
    judge: judgeFor(sql, tenant, gateFor("AUTO_APPROVE")),
  });
  assert.equal(ready.status, "ready");
  await withTextModel(async (calls) => {
    const result = await generateCreativeFor(tenant.userId, { brandId: tenant.brandId, briefId: ready.briefId });
    assert.equal(calls.count, 1, "the text model is called for a ready brief");
    assert.equal(result.status, "completed");
  });
  const [runs] = await sql<{ count: number }>`
    select count(*)::int as count from model_runs where input_ref = ${ready.briefId} and status = 'completed'
  `;
  assert.equal(runs?.count, 1);
});

test("an engine-judged brief whose gate record cannot be written is not created: the decision could not be recorded", async () => {
  const base = await getSql();
  const tenant = await studioTenant(base, "svc-no-record");
  const opportunity = await seedOpportunity(base, tenant);
  // Only the gate record write fails. The engine is called and answers; the decision then has no record to point to.
  const recordSql = failingSql(base, /insert into decision_gate_records/);
  const engines = registryWith(stubEngine("jev", { respond: approvesBriefCalibrated }), stubEngine("openai-decisions"));
  let judgedId = "";
  await assert.rejects(
    createGatedBrief(base, {
      organizationId: tenant.organizationId,
      brandId: tenant.brandId,
      createdBy: tenant.userId,
      brief: briefRecord(opportunity.opportunityId),
      judge: async (briefId) => {
        judgedId = briefId;
        return judgeBriefFit({
          sql: recordSql,
          organizationId: tenant.organizationId,
          brandId: tenant.brandId,
          briefId,
          brief: BRIEF,
          brain: BRAIN,
          engines,
          selection: { engineId: "jev", source: "workspace" },
        });
      },
    }),
    /could not be recorded/,
  );
  const [briefs] = await base<{ count: number }>`select count(*)::int as count from briefs where id = ${judgedId}`;
  assert.equal(briefs?.count, 0, "no brief was written for the unrecorded decision");
  const [decisions] = await base<{ count: number }>`select count(*)::int as count from jev_decisions where subject_id = ${judgedId}`;
  assert.equal(decisions?.count, 0, "no decision was written for the unrecorded decision");
  const [opp] = await base<{ status: string }>`select status from opportunities where id = ${opportunity.opportunityId}`;
  assert.equal(opp?.status, "open", "the opportunity is not marked briefed");
});

test("a deterministic rejection makes no engine call, so it is still written when its gate record cannot be", async () => {
  const base = await getSql();
  const tenant = await studioTenant(base, "svc-det-record");
  const opportunity = await seedOpportunity(base, tenant);
  const recordSql = failingSql(base, /insert into decision_gate_records/);
  const jev = stubEngine("jev", { respond: approvesBriefCalibrated });
  const created = await createGatedBrief(base, {
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    createdBy: tenant.userId,
    brief: briefRecord(opportunity.opportunityId),
    judge: (briefId) =>
      judgeBriefFit({
        sql: recordSql,
        organizationId: tenant.organizationId,
        brandId: tenant.brandId,
        briefId,
        brief: { ...BRIEF, hook: "" },
        brain: BRAIN,
        engines: registryWith(jev, stubEngine("openai-decisions")),
        selection: { engineId: "jev", source: "workspace" },
      }),
  });
  assert.equal(jev.requests.length, 0, "no engine is asked about a deterministic rejection");
  assert.equal(created.action, "REJECT");
  assert.equal(created.status, "rejected", "the rejection is stored");
  const [decision] = await base<{ decision: string }>`select decision from jev_decisions where subject_id = ${created.briefId}`;
  assert.equal(decision?.decision, "REJECT");
});
