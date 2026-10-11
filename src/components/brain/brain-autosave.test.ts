import assert from "node:assert/strict";
import test from "node:test";
import { emptyBrain } from "../../lib/meridian/brain.ts";
import { brainChanged, readBrain } from "./brain-autosave.ts";

const saved = { ...emptyBrain(), targetCustomers: "Busy parents", automationLevel: "assisted" as const };

test("the brain is read with trimmed text", () => {
  const read = readBrain({ ...saved, targetCustomers: "  Busy parents  " });
  assert.equal(read.ok, true);
  if (read.ok) assert.equal(read.values.targetCustomers, "Busy parents");
});

test("a brain field of exactly 4000 characters is accepted, and 4001 is refused", () => {
  const ok = readBrain({ ...saved, problems: "a".repeat(4000) });
  assert.equal(ok.ok, true);
  const tooLong = readBrain({ ...saved, problems: "a".repeat(4001) });
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.equal(tooLong.message, "This field must be 4000 characters or fewer.");
});

test("trailing spaces do not count toward the 4000 limit, because the text is trimmed first", () => {
  const read = readBrain({ ...saved, problems: `${"a".repeat(4000)}   ` });
  assert.equal(read.ok, true);
});

test("an unknown automation level is refused with a message, not a crash", () => {
  const read = readBrain({ ...saved, automationLevel: "reckless" });
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(typeof read.message, "string");
  assert.equal(readBrain(null).ok, false);
});

test("a trailing space is not a change, and a real edit is", () => {
  assert.equal(brainChanged({ ...saved, targetCustomers: "Busy parents " }, saved), false);
  assert.equal(brainChanged({ ...saved, targetCustomers: "Busy parents and students" }, saved), true);
});

test("a saved value with a stray space is not reported as a change by an identical form", () => {
  assert.equal(brainChanged({ ...saved, targetCustomers: "Busy parents" }, { ...saved, targetCustomers: "Busy parents " }), false);
});

test("an invalid form counts as changed, so the autosave reports it", () => {
  assert.equal(brainChanged({ ...saved, automationLevel: "reckless" }, saved), true);
});

test("with no saved brain yet, any form counts as changed", () => {
  assert.equal(brainChanged({ ...saved }, null), true);
});
