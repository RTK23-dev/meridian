import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { thresholds } from "../../config/thresholds.ts";
import { EngineError } from "../../contracts/errors.ts";
import {
  NOT_CONNECTED_REASON,
  notConnectedScorer,
  requiredSimilarityKinds,
  scoreSimilarity,
  similarityRows,
  type SimilarityScorer,
} from "./similarity.ts";
import type { SimilarityOutcome, TakeShot } from "./types.ts";
import {
  FRAME_IMAGE_URL,
  PALETTE,
  presenterShot,
  productShot,
  recordedScorer,
  recordedScores,
} from "../test/helpers.ts";

const frames = [FRAME_IMAGE_URL, FRAME_IMAGE_URL];
const TAKE = "take_01JABCDEFGHJKMNPQRSTVWXYZ1";

describe("similarity scorer interface (Bible 6.7 step 2, 20.2)", () => {
  it("the default scorer is not connected, with the reason, and never returns a score", async () => {
    const scorer = notConnectedScorer();
    const outcome = await scorer.score({ kind: "product_vs_hero", takeId: TAKE, frames, heroUris: ["asset://hero"] });
    assert.deepEqual(outcome, { status: "not_connected", reason: NOT_CONNECTED_REASON });
    assert.match(NOT_CONNECTED_REASON, /Bible 20\.2/);
  });

  it("the kinds a shot needs: product and palette for a product shot, persona and palette for a presenter shot", () => {
    assert.deepEqual(requiredSimilarityKinds(productShot()), ["product_vs_hero", "palette_vs_style_kit"]);
    assert.deepEqual(requiredSimilarityKinds(presenterShot()), ["face_vs_persona", "palette_vs_style_kit"]);
    const both: TakeShot = { ...productShot(), persona: { portraitUris: ["asset://persona/p1"] } };
    assert.deepEqual(requiredSimilarityKinds(both), ["product_vs_hero", "face_vs_persona", "palette_vs_style_kit"]);
  });
});

describe("scoreSimilarity", () => {
  it("with the default scorer, every required check is not connected and nothing is scored", async () => {
    const outcomes = await scoreSimilarity(notConnectedScorer(), { takeId: TAKE, frames, shot: productShot(), paletteHex: PALETTE });
    assert.equal(outcomes.product_vs_hero?.status, "not_connected");
    assert.equal(outcomes.palette_vs_style_kit?.status, "not_connected");
    assert.equal(outcomes.face_vs_persona, undefined);
  });

  it("sends the hero image and the take frames to the scorer, one request per required kind", async () => {
    const scorer = recordedScorer(recordedScores("clean"));
    await scoreSimilarity(scorer, { takeId: TAKE, frames, shot: productShot(), paletteHex: PALETTE });
    const kinds = scorer.requests.map((request) => request.kind);
    assert.deepEqual(kinds, ["product_vs_hero", "palette_vs_style_kit"]);
    const product = scorer.requests[0];
    assert.ok(product && product.kind === "product_vs_hero");
    assert.deepEqual(product.heroUris, ["asset://product/hero-1"]);
    assert.deepEqual(product.frames, frames);
  });

  it("a shot with no frames is not evaluated, and the scorer is not called", async () => {
    const scorer = recordedScorer(recordedScores("clean"));
    const outcomes = await scoreSimilarity(scorer, { takeId: TAKE, frames: null, shot: productShot(), paletteHex: PALETTE });
    assert.equal(scorer.requests.length, 0);
    assert.equal(outcomes.product_vs_hero?.status, "not_evaluated");
  });

  it("a product shot with no hero image is not evaluated, and only that check is skipped", async () => {
    const scorer = recordedScorer(recordedScores("clean"));
    const shot = productShot({ product: { heroUris: [] } });
    const outcomes = await scoreSimilarity(scorer, { takeId: TAKE, frames, shot, paletteHex: PALETTE });
    assert.equal(outcomes.product_vs_hero?.status, "not_evaluated");
    assert.deepEqual(scorer.requests.map((request) => request.kind), ["palette_vs_style_kit"]);
  });

  it("an empty style-kit palette is not evaluated for the palette check", async () => {
    const outcomes = await scoreSimilarity(recordedScorer(recordedScores("clean")), { takeId: TAKE, frames, shot: productShot(), paletteHex: [] });
    assert.equal(outcomes.palette_vs_style_kit?.status, "not_evaluated");
  });

  it("a scorer that answers a score outside 0 to 1 has failed: the call throws a provider error", async () => {
    const liar: SimilarityScorer = {
      id: "similarity:liar",
      async score(): Promise<SimilarityOutcome> {
        return { status: "scored", score: 1.4, scorer: "similarity:liar" };
      },
    };
    await assert.rejects(
      scoreSimilarity(liar, { takeId: TAKE, frames, shot: productShot(), paletteHex: PALETTE }),
      (error: unknown) => error instanceof EngineError && error.kind === "provider",
    );
  });

  it("a scorer that throws is not swallowed: the error reaches the caller, so the stage can retry", async () => {
    const broken: SimilarityScorer = {
      id: "similarity:broken",
      async score(): Promise<SimilarityOutcome> {
        throw new EngineError("provider", "timeout", { retryable: true });
      },
    };
    await assert.rejects(
      scoreSimilarity(broken, { takeId: TAKE, frames, shot: productShot(), paletteHex: PALETTE }),
      (error: unknown) => error instanceof EngineError && error.retryable === true,
    );
  });
});

describe("similarity rows (Bible 12.2 thresholds)", () => {
  it("a clean take's scores pass every check, at the configured limits", () => {
    const rows = similarityRows(productShot(), recordedOutcomes("clean"));
    assert.deepEqual(rows.map((row) => [row.check.rule, row.check.pass]), [
      ["product_match", true],
      ["palette_match", true],
    ]);
    assert.ok(rows.every((row) => row.evidence === "measured"));
    assert.equal(rows[0]?.check.limit, thresholds.take.productMatchMin.value);
  });

  it("a warped product (recorded product score 0.41) fails product_match and names its gold set", () => {
    const rows = similarityRows(productShot(), recordedOutcomes("warped_product"));
    const product = rows.find((row) => row.check.rule === "product_match");
    assert.equal(product?.check.pass, false);
    assert.equal(product?.check.value, 0.41);
    assert.equal(product?.evidence, "measured");
    assert.equal(product?.gold, "take:product_match");
  });

  it("the limits are inclusive: a score equal to the limit passes, a score just below it fails", () => {
    const product = thresholds.take.productMatchMin.value;
    const at = similarityRows(productShot(), {
      product_vs_hero: { status: "scored", score: product, scorer: "s" },
      palette_vs_style_kit: { status: "scored", score: 0.9, scorer: "s" },
    });
    assert.equal(at.find((row) => row.check.rule === "product_match")?.check.pass, true);
    const below = similarityRows(productShot(), {
      product_vs_hero: { status: "scored", score: product - 0.01, scorer: "s" },
      palette_vs_style_kit: { status: "scored", score: 0.9, scorer: "s" },
    });
    assert.equal(below.find((row) => row.check.rule === "product_match")?.check.pass, false);
  });

  it("the palette check uses the palette limit from configuration", () => {
    const limit = thresholds.take.paletteShareMin.value;
    const rows = similarityRows(productShot(), {
      product_vs_hero: { status: "scored", score: 0.95, scorer: "s" },
      palette_vs_style_kit: { status: "scored", score: limit - 0.01, scorer: "s" },
    });
    assert.equal(rows.find((row) => row.check.rule === "palette_match")?.check.pass, false);
  });

  it("a scorer that is not connected is missing evidence: the row fails, and it can never be a pass", () => {
    const rows = similarityRows(productShot(), {
      product_vs_hero: { status: "not_connected", reason: NOT_CONNECTED_REASON },
      palette_vs_style_kit: { status: "scored", score: 0.95, scorer: "s" },
    });
    const product = rows.find((row) => row.check.rule === "product_match");
    assert.equal(product?.check.pass, false);
    assert.equal(product?.evidence, "missing");
    assert.match(product?.check.detail ?? "", /not evaluated: the scorer is not connected/);
  });

  it("a required kind with no recorded result is missing evidence, not a pass", () => {
    const rows = similarityRows(productShot(), { palette_vs_style_kit: { status: "scored", score: 0.95, scorer: "s" } });
    const product = rows.find((row) => row.check.rule === "product_match");
    assert.equal(product?.check.pass, false);
    assert.equal(product?.evidence, "missing");
  });

  it("a persona is checked only for a shot that shows one", () => {
    const rows = similarityRows(presenterShot(), recordedOutcomes("clean"));
    assert.equal(rows.some((row) => row.check.rule === "product_match"), false);
    assert.equal(rows.find((row) => row.check.rule === "persona_match")?.check.pass, true);
  });

  it("a scored result outside 0 to 1 in the table is missing evidence, not a number to compare", () => {
    const rows = similarityRows(productShot(), {
      product_vs_hero: { status: "scored", score: Number.NaN, scorer: "s" },
      palette_vs_style_kit: { status: "scored", score: 0.9, scorer: "s" },
    });
    assert.equal(rows.find((row) => row.check.rule === "product_match")?.evidence, "missing");
  });
});

/** The recorded fixture as outcomes, one per kind. */
function recordedOutcomes(name: "clean" | "warped_product") {
  const scores = recordedScores(name);
  const outcomes: Partial<Record<"product_vs_hero" | "face_vs_persona" | "palette_vs_style_kit", SimilarityOutcome>> = {};
  for (const [kind, score] of Object.entries(scores)) {
    if (typeof score === "number") {
      outcomes[kind as "product_vs_hero" | "face_vs_persona" | "palette_vs_style_kit"] = { status: "scored", score, scorer: `recorded:${name}` };
    }
  }
  return outcomes;
}
