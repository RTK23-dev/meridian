import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { EngineError, canonicalJson, contentHash, contentHashSchema, roundUsd, sumUsd, usdSchema } from "./index.ts";

test("canonicalJson sorts keys at every depth and has no whitespace", () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: [3, { z: true, y: null }], c: "x" } }),
    '{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}',
  );
});

test("canonicalJson omits undefined object members and writes undefined array slots as null", () => {
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(canonicalJson([1, undefined, 2]), "[1,null,2]");
});

test("canonicalJson refuses values that have no JSON form", () => {
  assert.throws(() => canonicalJson(Number.NaN), EngineError);
  assert.throws(() => canonicalJson(Number.POSITIVE_INFINITY), EngineError);
  assert.throws(() => canonicalJson(() => 1), EngineError);
  assert.throws(() => canonicalJson(new Date(0)), EngineError);
  assert.throws(() => canonicalJson(undefined), EngineError);
  assert.throws(() => canonicalJson(1n), EngineError);
});

test("contentHash is sha256 of the canonical JSON, the same for equal values with different key order", () => {
  const a = contentHash({ x: 1, y: [1, 2] });
  const b = contentHash({ y: [1, 2], x: 1 });
  assert.equal(a, b);
  const expected = createHash("sha256").update('{"x":1,"y":[1,2]}').digest("hex");
  assert.equal(a, `sha256:${expected}`);
  assert.equal(contentHashSchema.safeParse(a).success, true);
});

test("contentHash changes when any value changes", () => {
  assert.notEqual(contentHash({ x: 1 }), contentHash({ x: 2 }));
  assert.notEqual(contentHash({ x: [1, 2] }), contentHash({ x: [2, 1] }));
});

test("contentHash of bytes is sha256 of the bytes themselves", () => {
  const bytes = new TextEncoder().encode("<html></html>");
  assert.equal(contentHash(bytes), `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
});

test("contentHashSchema accepts only sha256 followed by 64 lower-case hex digits", () => {
  assert.equal(contentHashSchema.safeParse(`sha256:${"a".repeat(64)}`).success, true);
  assert.equal(contentHashSchema.safeParse(`sha256:${"A".repeat(64)}`).success, false);
  assert.equal(contentHashSchema.safeParse(`sha256:${"a".repeat(63)}`).success, false);
  assert.equal(contentHashSchema.safeParse(`sha1:${"a".repeat(40)}`).success, false);
});

test("usdSchema accepts finite amounts from 0 to any size with at most 4 decimals", () => {
  for (const value of [0, 0.0001, 0.1234, 12.3456, 1000]) {
    assert.equal(usdSchema.safeParse(value).success, true, `${value} should be accepted`);
  }
});

test("usdSchema refuses negative, non-finite and over-precise amounts", () => {
  for (const value of [-0.01, Number.NaN, Number.POSITIVE_INFINITY, 0.12345, 0.30001]) {
    assert.equal(usdSchema.safeParse(value).success, false, `${value} should be refused`);
  }
});

test("roundUsd rounds to 4 decimals and refuses negative or non-finite amounts", () => {
  assert.equal(roundUsd(0.123456), 0.1235);
  assert.equal(roundUsd(0.1), 0.1);
  assert.equal(roundUsd(0), 0);
  assert.throws(() => roundUsd(-0.0001), EngineError);
  assert.throws(() => roundUsd(Number.NaN), EngineError);
});

test("sumUsd adds in exact ten-thousandths, so 0.1 + 0.2 is 0.3", () => {
  assert.equal(sumUsd([0.1, 0.2]), 0.3);
  assert.equal(sumUsd(Array.from({ length: 10000 }, () => 0.0001)), 1);
  assert.equal(sumUsd([0.44, 0.5532, 0.047, 0.02]), 1.0602);
});

test("EngineError carries its kind, retry flag, stage and cause, and sets its fields in the constructor", () => {
  const cause = new Error("socket reset");
  const error = new EngineError("provider", "submit failed", { retryable: true, stage: "produce_shot", cause });
  assert.ok(error instanceof Error);
  assert.ok(error instanceof EngineError);
  assert.equal(error.name, "EngineError");
  assert.equal(error.kind, "provider");
  assert.equal(error.retryable, true);
  assert.equal(error.stage, "produce_shot");
  assert.equal(error.message, "submit failed");
  assert.equal(error.cause, cause);

  const plain = new EngineError("invalid_input", "bad");
  assert.equal(plain.retryable, false);
  assert.equal(plain.stage, undefined);
});
