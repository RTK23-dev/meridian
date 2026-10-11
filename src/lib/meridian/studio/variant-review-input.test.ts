import assert from "node:assert/strict";
import test from "node:test";
import { enableAppAliases } from "../testing/module-aliases.ts";

// The review list is read from the publishing module, which uses the "@/" alias.
enableAppAliases();
const { parseVariantReview } = await import("./variant-review-input.ts");
const { REVIEW_REASON_CODES } = await import("../publishing/actions.ts");

const base = { brandId: "brand-1", creativeId: "creative-1", note: "" };

test("a rejection with a code from the server review list is accepted", () => {
  for (const code of REVIEW_REASON_CODES) {
    const parsed = parseVariantReview({ ...base, action: "reject", reasonCode: code });
    assert.equal(parsed.reasonCode, code);
    assert.equal(parsed.action, "reject");
  }
});

test("a rejection with free text, a blank code, or a code outside the list is refused before anything is recorded", () => {
  for (const reasonCode of ["", "   ", "looks off to me", "not_a_real_code", "WRONG_LOGO!"]) {
    assert.throws(
      () => parseVariantReview({ ...base, action: "reject", reasonCode }),
      /Choose a rejection reason from the review list/,
      `"${reasonCode}" is not a reason code`,
    );
  }
});

test("an approval or a revision needs no reason code, and keeps the note it was given", () => {
  assert.equal(parseVariantReview({ ...base, action: "approve", reasonCode: "" }).action, "approve");
  const revision = parseVariantReview({ ...base, action: "revision", reasonCode: "", note: "  Tighten the claim.  " });
  assert.equal(revision.action, "revision");
  assert.equal(revision.note, "Tighten the claim.");
});

test("an unknown action, a missing brand, or a missing variant is refused", () => {
  assert.throws(() => parseVariantReview({ ...base, action: "delete", reasonCode: "" }), /Choose approve, reject, or revision/);
  assert.throws(() => parseVariantReview({ ...base, brandId: "", action: "approve" }), /Choose a variant/);
  assert.throws(() => parseVariantReview({ ...base, creativeId: "", action: "approve" }), /Choose a variant/);
});
