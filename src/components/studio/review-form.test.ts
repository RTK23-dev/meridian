import assert from "node:assert/strict";
import test from "node:test";
import { reviewFormSchema, type ReviewFormInput } from "./review-form.ts";

const CODES = ["too_similar", "off_brand"];
const schema = reviewFormSchema(CODES);

/** The first issue's message and the field it is placed on, or null when the form is valid. */
function firstIssue(input: ReviewFormInput): { message: string; field: string } | null {
  const result = schema.safeParse(input);
  if (result.success) return null;
  const issue = result.error.issues[0];
  return { message: issue?.message ?? "", field: String(issue?.path[0] ?? "") };
}

test("an approval needs no reason and may carry no note", () => {
  assert.equal(firstIssue({ action: "approve", reasonCode: "", note: "" }), null);
});

test("a rejection without a reason places the message on the reason", () => {
  assert.deepEqual(firstIssue({ action: "reject", reasonCode: "", note: "Too close to a competitor." }), { message: "Choose a rejection reason.", field: "reasonCode" });
});

test("a reason outside the server's list places its message on the reason", () => {
  assert.deepEqual(firstIssue({ action: "reject", reasonCode: "made_up", note: "x" }), { message: "Choose one of the listed reasons.", field: "reasonCode" });
});

test("a rejection without a note places its message on the note", () => {
  assert.deepEqual(firstIssue({ action: "reject", reasonCode: "off_brand", note: "   " }), { message: "Write a note that says why this variant is rejected.", field: "note" });
});

test("a revision request without a note places its message on the note", () => {
  assert.deepEqual(firstIssue({ action: "revision", reasonCode: "", note: "" }), { message: "Write a note that says what to change.", field: "note" });
});

test("a note over the limit places its message on the note, with the length", () => {
  assert.deepEqual(firstIssue({ action: "approve", reasonCode: "", note: "x".repeat(401) }), { message: "The note is 401 characters. The limit is 400.", field: "note" });
  assert.equal(firstIssue({ action: "approve", reasonCode: "", note: "x".repeat(400) }), null, "exactly the limit is allowed");
});

test("every refusal message lands on the field it is about", () => {
  const cases: Array<[ReviewFormInput, "reasonCode" | "note"]> = [
    [{ action: "reject", reasonCode: "", note: "" }, "reasonCode"],
    [{ action: "reject", reasonCode: "nope", note: "x" }, "reasonCode"],
    [{ action: "reject", reasonCode: "too_similar", note: "" }, "note"],
    [{ action: "revision", reasonCode: "", note: "" }, "note"],
    [{ action: "approve", reasonCode: "", note: "y".repeat(401) }, "note"],
  ];
  for (const [input, field] of cases) assert.equal(firstIssue(input)?.field, field, JSON.stringify(input));
});
