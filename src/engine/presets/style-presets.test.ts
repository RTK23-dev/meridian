// The style presets: each one passes its contracts, its kit injects into the compiler's CSS, its format id follows the Content
// Factory rule, and installing it writes one kit row that the request's kit loader then finds.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { geneIdSchema, styleKitSchema } from "../contracts/index.ts";
import { styleKitCss } from "../compose/styleKit.ts";
import { readKit } from "../jobs/kit-store.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { installStylePreset, presetProblems, STYLE_PRESETS, stylePreset, type StylePreset } from "./style-presets.ts";
import { REFERENCE_SHA256, threeDDataExplainer } from "./three-d-data-explainer.ts";

const WS = "ws_style_presets";
const OTHER_WS = "ws_style_presets_other";
let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS);
  await seedWorkspace(db.sql, OTHER_WS);
});

after(async () => {
  await db.close();
});

test("every preset passes its contracts, with unique ids", () => {
  const ids = STYLE_PRESETS.map((preset) => preset.presetId);
  assert.equal(new Set(ids).size, ids.length);
  for (const preset of STYLE_PRESETS) {
    assert.deepEqual(presetProblems(preset), [], preset.presetId);
    assert.ok(styleKitSchema.safeParse(preset.styleKit).success);
    for (const gene of preset.genes.keep) assert.ok(geneIdSchema.safeParse(gene).success, gene);
  }
});

test("the 3D data explainer kit injects as CSS variables", () => {
  const css = styleKitCss(threeDDataExplainer.styleKit);
  assert.match(css, /--kit-caption-highlight: #F0E860;/);
  assert.match(css, /--kit-background: #000010;/);
  assert.match(css, /--kit-font-captions: "Inter";/);
});

test("the format id is the one the Content Factory gives the same reference file", () => {
  assert.equal(threeDDataExplainer.reference.formatId, `ref_${REFERENCE_SHA256.slice(0, 24)}`);
  assert.equal(threeDDataExplainer.reference.formatId, "ref_98053a5a224b3833a3ed4421");
});

test("the measured grammar is consistent and nothing unknown is filled in", () => {
  const measured = threeDDataExplainer.grammar.measured as {
    cutsMs: number[];
    hookFirstCutMs: number;
    shotLengthMs: { p25: number; p50: number; p75: number };
    endsOnLoop: boolean;
    loopDistance: number;
  };
  assert.equal(measured.hookFirstCutMs, measured.cutsMs[0]);
  assert.ok(measured.shotLengthMs.p25 <= measured.shotLengthMs.p50 && measured.shotLengthMs.p50 <= measured.shotLengthMs.p75);
  assert.equal(measured.endsOnLoop, measured.loopDistance <= 0.04);
  assert.deepEqual(threeDDataExplainer.styleKit.musicGenres, [], "music was not measured, so no genre is named");
  assert.ok(threeDDataExplainer.grammar.unknown.length > 0);
});

test("a preset whose beats leave a gap, or whose shot uses a banned type, has problems", () => {
  const broken: StylePreset = {
    ...threeDDataExplainer,
    structure: [{ ...threeDDataExplainer.structure[0]!, fromMs: 100 }],
    shots: [{ id: "presenter", visualType: "ugc_presenter", want: "a presenter" }],
  };
  const problems = presetProblems(broken);
  assert.ok(problems.some((problem) => problem.includes("starts at 100 ms")));
  assert.ok(problems.some((problem) => problem.includes("banned type ugc_presenter")));
});

test("an unknown preset id is refused", async () => {
  assert.throws(() => stylePreset("no_such_preset"), /no style preset/);
  await assert.rejects(installStylePreset(db.sql, { organizationId: WS, presetId: "no_such_preset" }), /no style preset/);
});

test("installing writes one kit row per workspace, and the kit loader finds it", async () => {
  const first = await installStylePreset(db.sql, { organizationId: WS, presetId: "3d_data_explainer" });
  const second = await installStylePreset(db.sql, { organizationId: WS, presetId: "3d_data_explainer" });
  assert.equal(first.kitId, "sk_3d_data_explainer");
  assert.equal(first.contentHash, second.contentHash);
  const rows = await db.sql<{ count: number }>`
    select count(*)::int as count from engine_kits where organization_id = ${WS} and kit_id = 'sk_3d_data_explainer'
  `;
  assert.equal(rows[0]?.count, 1);

  const found = await readKit(db.sql, { organizationId: WS, kind: "style", kitId: "sk_3d_data_explainer" });
  assert.deepEqual(found?.body, threeDDataExplainer.styleKit);
  const elsewhere = await readKit(db.sql, { organizationId: OTHER_WS, kind: "style", kitId: "sk_3d_data_explainer" });
  assert.equal(elsewhere, null, "a kit installed in one workspace is not visible in another");
});
