// The request's model choice (Bible 10.5, contract v8) on recorded answers: no test here calls a live API.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { modelChoicesSchema } from "../contracts/model-choices.ts";
import { decisionSchema, type ScenePlan, type ShotSpec } from "../contracts/plan.ts";
import { fixtureId } from "../contracts/fixtures/index.ts";
import { parseModelsCatalog, parseVideoCatalog, type CatalogRead, type ModelCatalogSource } from "../gateway/catalog.ts";
import { deps, fixture, gatewayFor, json, ledgerWith, REQUEST_ID, RESERVATION_ID, sentMessages, textOf, WORKSPACE } from "../claude/test/helpers.ts";
import { chooseModels, plannedCallsOf } from "./model-choices.ts";

const READ_AT = "2026-10-16T09:00:00.000Z";
const gatewayFixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../gateway/test/fixtures/${name}.json`, import.meta.url), "utf8"));
const entries = [
  ...parseVideoCatalog(gatewayFixture("openrouter-catalog-videos"), READ_AT).entries,
  ...parseModelsCatalog("image", gatewayFixture("openrouter-catalog-image"), READ_AT).entries,
];

function source(read: CatalogRead = { status: "read", catalog: { readAt: READ_AT, entries, dropped: [], failed: [], videoListing: null } }): ModelCatalogSource & { reads: number } {
  const counted = { reads: 0, async read() { counted.reads += 1; return read; } };
  return counted;
}

const SHOT_1 = fixtureId("shot_", 1);
const SHOT_2 = fixtureId("shot_", 2);
const SHOT_3 = fixtureId("shot_", 3);
const SHOT_4 = fixtureId("shot_", 4);

/** Four shots: a 5 s cinematic clip, a keyframe-then-clip chain of 6 s, a 12 s clip no model lists, and a stock shot (no call). */
function plan(): ScenePlan {
  const shots: ShotSpec[] = [
    {
      shotId: SHOT_1,
      beatId: "b1",
      startMs: 0,
      endMs: 5000,
      visualType: "cinematic",
      layer: "base",
      source: { kind: "generate", modelClass: "video.cinematic", prompt: "Slow push-in on a kitchen counter.", refs: [], takes: 1 },
    },
    {
      shotId: SHOT_2,
      beatId: "b2",
      startMs: 5000,
      endMs: 11000,
      visualType: "cartoon_generated",
      layer: "base",
      source: {
        kind: "chain",
        calls: [
          { output: "keyframe", modelClass: "image.keyframe", prompt: "A flat cartoon kitchen.", refs: [], takes: 1 },
          { output: "clip", modelClass: "video.budget", prompt: "The kitchen comes alive.", refs: [], firstFrame: { kind: "output", output: "keyframe" }, takes: 1 },
        ],
      },
    },
    {
      shotId: SHOT_3,
      beatId: "b3",
      startMs: 11000,
      endMs: 23000,
      visualType: "cinematic",
      layer: "base",
      source: { kind: "generate", modelClass: "video.cinematic", prompt: "A long dolly across the room.", refs: [], takes: 1 },
    },
    { shotId: SHOT_4, beatId: "b4", startMs: 23000, endMs: 28000, visualType: "stock_footage", layer: "cutaway", source: { kind: "stock", query: "blender", minMs: 4000 } },
  ];
  return { schema: "meridian.scene_plan/v1", planId: "plan_choice", requestId: REQUEST_ID, videoDnaId: "dna_x", voiceTrackId: "vt_x", shots, estimatedUsd: 1, decisions: [] };
}

async function run(answers: ReturnType<typeof json>[], options: { reservedUsd?: number; catalog?: ModelCatalogSource } = {}) {
  const { gateway, requests } = gatewayFor(answers);
  const ledger = await ledgerWith(options.reservedUsd ?? 1);
  const result = await chooseModels({
    deps: deps(gateway, ledger),
    catalog: options.catalog ?? source(),
    requestId: REQUEST_ID,
    workspaceId: WORKSPACE,
    reservationId: RESERVATION_ID,
    attempt: 1,
    plan: plan(),
  });
  return { result, requests, ledger };
}

const byCall = (choices: NonNullable<Awaited<ReturnType<typeof chooseModels>>["choices"]>) =>
  Object.fromEntries(choices.choices.map((entry) => [`${entry.shotId}:${entry.output}`, [entry.modelChoice.modelId, entry.modelChoice.source]]));

describe("plannedCallsOf", () => {
  it("names a generate shot's call 'shot' and each chain call by its output, and skips shots with no paid call", () => {
    assert.deepEqual(
      plannedCallsOf(plan()).map((call) => [call.shotId, call.output, call.modelClass, call.durationMs, call.firstFrame]),
      [
        [SHOT_1, "shot", "video.cinematic", 5000, false],
        [SHOT_2, "keyframe", "image.keyframe", 6000, false],
        [SHOT_2, "clip", "video.budget", 6000, true],
        [SHOT_3, "shot", "video.cinematic", 12000, false],
      ],
    );
  });
});

describe("chooseModels", () => {
  it("makes one model_chooser call for the request: a valid pick is kept, an id outside the candidates and a missing pick fall back", async () => {
    const { result, requests, ledger } = await run([json(200, fixture("openrouter-model-chooser-ok"))]);
    assert.equal(requests.length, 1, "one call for the whole request, not one per shot");
    assert.equal(result.roleCalled, true);

    // What the role was shown: the three calls that have candidates, with id, capabilities and price. The 6 s clip's one candidate is
    // Veo 3.1 Lite, which lists 6 s and a first frame (Kling lists 5 and 10 s, Wan 2.6 lists 5 s). Nothing is shown for the 12 s shot.
    const sent = JSON.parse(String(requests[0]?.body)) as { model: string };
    assert.equal(sent.model, "anthropic/claude-haiku-5.5", "model_chooser runs on llm.check");
    const block = textOf(sentMessages(requests[0]?.body)[1]?.content);
    assert.match(block, /<untrusted-data name="calls">/);
    const calls = JSON.parse(block.split("\n")[2] ?? "[]") as Array<{ callId: string; shotId: string; output: string; candidates: Array<{ id: string; price: unknown }> }>;
    assert.deepEqual(calls.map((call) => [call.callId, call.shotId, call.output, call.candidates.map((candidate) => candidate.id)]), [
      ["c1", SHOT_1, "shot", ["kwaivgi/kling-v3.0-std", "alibaba/wan-2.6"]],
      ["c2", SHOT_2, "keyframe", ["vendor/text-to-image-flat"]],
      ["c3", SHOT_2, "clip", ["google/veo-3.1-lite"]],
    ]);

    assert.ok(result.choices !== null);
    assert.ok(modelChoicesSchema.safeParse(result.choices).success, "the artifact body fits contract v8");
    assert.equal(result.choices.catalogReadAt, READ_AT);
    assert.deepEqual(byCall(result.choices), {
      [`${SHOT_1}:shot`]: ["alibaba/wan-2.6", "orchestrator"],
      // c2's pick is not a candidate. Seedream 4.5 is not one: its image output is priced per token, so no per-call price can be reserved.
      // The only reservable keyframe candidate is text-to-image-flat.
      [`${SHOT_2}:keyframe`]: ["vendor/text-to-image-flat", "fallback"],
      // c3 has no pick: the first eligible catalog candidate for the clip (Veo 3.1 Lite, the only one that lists 6 s).
      [`${SHOT_2}:clip`]: ["google/veo-3.1-lite", "fallback"],
    });
    const choices = result.choices.choices;
    assert.match(choices[1]?.modelChoice.reason ?? "", /not one of this call's eligible candidates/);
    assert.ok(!choices.some((entry) => /Ignore the candidates/.test(entry.modelChoice.reason)), "a refused pick's text is not kept as a reason");

    // One decision per call, each naming its shot; the 12 s shot has no candidate, so no model is chosen for it.
    assert.equal(result.decisions.length, 4);
    assert.equal(result.decisions[2]?.chose, "openrouter:google/veo-3.1-lite", "the 6 s clip: its first eligible candidate");
    for (const decision of result.decisions) assert.ok(decisionSchema.safeParse(decision).success);
    assert.equal(result.decisions[0]?.by, "director");
    assert.match(result.decisions[3]?.reason ?? "", new RegExp(`^${SHOT_3} shot: no catalog candidate fits this call`));
    assert.equal(result.decisions[3]?.chose, "no model for video.cinematic");

    // The call is on the ledger, as a model_chooser call, billed at the answer's usage.cost.
    const rows = await ledger.listEntries(RESERVATION_ID);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.role, "model_chooser");
    assert.equal(rows[0]?.promptVersion, "model_chooser@1");
    assert.equal(rows[0]?.actualUsd, 0.0036);
  });

  it("falls back on every call when the role's answer fails its contract twice", async () => {
    const prose = fixture("openrouter-segmenter-prose");
    const { result, requests } = await run([json(200, prose), json(200, prose)]);
    assert.equal(requests.length, 2, "the call and its one retry");
    assert.ok(result.choices !== null);
    assert.deepEqual(byCall(result.choices), {
      [`${SHOT_1}:shot`]: ["kwaivgi/kling-v3.0-std", "fallback"],
      [`${SHOT_2}:keyframe`]: ["vendor/text-to-image-flat", "fallback"],
      [`${SHOT_2}:clip`]: ["google/veo-3.1-lite", "fallback"],
    });
    assert.match(result.choices.choices[0]?.modelChoice.reason ?? "", /model_chooser call failed/);
  });

  it("falls back when the reservation refuses the call, and sends nothing", async () => {
    const { result, requests } = await run([], { reservedUsd: 0.0001 });
    assert.equal(requests.length, 0);
    assert.ok(result.choices !== null);
    assert.ok(result.choices.choices.every((entry) => entry.modelChoice.source === "fallback"));
    assert.match(result.choices.choices[0]?.modelChoice.reason ?? "", /refused/);
  });

  it("makes no role call when no call has a candidate, and no choice", async () => {
    const catalog = source({ status: "read", catalog: { readAt: READ_AT, entries: [], dropped: [], failed: [], videoListing: null } });
    const { result, requests } = await run([], { catalog });
    assert.equal(requests.length, 0);
    assert.equal(result.roleCalled, false);
    assert.deepEqual(result.choices?.choices, []);
    assert.equal(result.decisions.length, 4);
    assert.ok(result.decisions.every((decision) => decision.chose.startsWith("no model for")));
  });

  it("makes no role call and no artifact when the catalog is not connected, and says why", async () => {
    const catalog = source({ status: "not_connected", reason: "NOT_CONNECTED: OpenRouter's catalog cannot be read: no openrouter key" });
    const { result, requests } = await run([], { catalog });
    assert.equal(requests.length, 0);
    assert.equal(result.choices, null);
    assert.equal(result.decisions.length, 1);
    assert.match(result.decisions[0]?.reason ?? "", /NOT_CONNECTED/);
  });
});
