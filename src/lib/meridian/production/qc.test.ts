import assert from "node:assert/strict";
import test from "node:test";
import { carouselQcVerdict, qcVerdictForStatus } from "./qc.ts";

test("a creative's QC is its review status, and an absent or unknown status is PENDING, never PASS", () => {
  assert.equal(qcVerdictForStatus("approved"), "PASS");
  assert.equal(qcVerdictForStatus("in_review"), "REVIEW");
  assert.equal(qcVerdictForStatus("rejected"), "REJECT");
  assert.equal(qcVerdictForStatus(null), "PENDING");
  assert.equal(qcVerdictForStatus(undefined), "PENDING");
  assert.equal(qcVerdictForStatus("draft"), "PENDING");
});

test("a carousel with a rejected slide is rejected, whatever the other slides say", () => {
  assert.equal(
    carouselQcVerdict([{ index: 0, verdict: "PASS" }, { index: 1, verdict: "REJECT" }, { index: 2, verdict: "REVIEW" }], "rejected"),
    "REJECT",
  );
});

test("a carousel with a pending slide is pending, not a pass, even when every judged slide passed", () => {
  assert.equal(carouselQcVerdict([{ index: 0, verdict: "PASS" }, { index: 1, verdict: "PENDING" }], "in_review"), "PENDING");
});

test("a carousel with no slides at all is pending: there is nothing to pass", () => {
  assert.equal(carouselQcVerdict([], "in_review"), "PENDING");
});

test("a complete carousel is judged by its own status, so one that is in review stays in review", () => {
  assert.equal(carouselQcVerdict([{ index: 0, verdict: "PASS" }, { index: 1, verdict: "PASS" }], "in_review"), "REVIEW");
  assert.equal(carouselQcVerdict([{ index: 0, verdict: "REVIEW" }, { index: 1, verdict: "REVIEW" }], "in_review"), "REVIEW");
});
