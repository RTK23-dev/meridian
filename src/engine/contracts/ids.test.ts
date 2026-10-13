import assert from "node:assert/strict";
import test from "node:test";
import { EngineError, ID_PREFIXES, ULID_PATTERN, encodeUlid, idSchema, newId } from "./index.ts";
import { FIXTURE_IDS, fixtureId } from "./fixtures/index.ts";

test("the id prefixes include the six named in the Bible and the v1 additions", () => {
  for (const prefix of ["req_", "dna_", "shot_", "take_", "edl_", "vid_", "art_", "asp_", "res_", "cmp_", "led_"]) {
    assert.ok((ID_PREFIXES as readonly string[]).includes(prefix), `missing prefix ${prefix}`);
  }
});

test("newId returns the prefix followed by a 26-character ULID", () => {
  for (const prefix of ID_PREFIXES) {
    const id = newId(prefix);
    assert.ok(id.startsWith(prefix), `${id} does not start with ${prefix}`);
    assert.equal(id.length, prefix.length + 26);
    assert.ok(ULID_PATTERN.test(id.slice(prefix.length)), `${id} body is not a ULID`);
    assert.equal(idSchema(prefix).safeParse(id).success, true);
  }
});

test("ids created later sort later, including ids created within one millisecond", () => {
  const ids = Array.from({ length: 200 }, () => newId("req_"));
  const sorted = [...ids].sort();
  assert.deepEqual(ids, sorted);
  assert.equal(new Set(ids).size, ids.length);
});

test("encoded ULIDs sort by time whatever the randomness", () => {
  const earlier = encodeUlid(1_760_000_000_000, (1n << 80n) - 1n);
  const later = encodeUlid(1_760_000_000_001, 0n);
  assert.ok(earlier < later);
  assert.ok(encodeUlid(1_000, 5n) < encodeUlid(2_000, 0n));
});

test("the ULID encoding uses Crockford base32 and matches the known zero and maximum vectors", () => {
  assert.equal(encodeUlid(0, 0n), "00000000000000000000000000");
  const maxTime = encodeUlid(2 ** 48 - 1, 0n);
  assert.equal(maxTime.slice(0, 1), "7");
  assert.equal(maxTime.slice(1), "ZZZZZZZZZ0000000000000000");
  assert.ok(ULID_PATTERN.test(maxTime));
  assert.equal(ULID_PATTERN.test(encodeUlid(1_000, 1n)), true);
});

test("encodeUlid refuses times and randomness outside the ULID range", () => {
  assert.throws(() => encodeUlid(-1, 0n), EngineError);
  assert.throws(() => encodeUlid(2 ** 48, 0n), EngineError);
  assert.throws(() => encodeUlid(1.5, 0n), EngineError);
  assert.throws(() => encodeUlid(1, 1n << 80n), EngineError);
  assert.throws(() => encodeUlid(1, -1n), EngineError);
});

test("idSchema rejects a wrong prefix, a short or long body, and characters Crockford leaves out", () => {
  const schema = idSchema("req_");
  const valid = newId("req_");
  assert.equal(schema.safeParse(valid).success, true);
  assert.equal(schema.safeParse(valid.replace("req_", "dna_")).success, false);
  assert.equal(schema.safeParse(valid.slice(0, -1)).success, false);
  assert.equal(schema.safeParse(`${valid}0`).success, false);
  assert.equal(schema.safeParse(`req_${"I".repeat(26)}`).success, false);
  assert.equal(schema.safeParse(`req_${"L".repeat(26)}`).success, false);
  assert.equal(schema.safeParse(`req_${"O".repeat(26)}`).success, false);
  assert.equal(schema.safeParse(`req_${"U".repeat(26)}`).success, false);
  assert.equal(schema.safeParse(`req_8${"0".repeat(25)}`).success, false, "a first character above 7 overflows 48 bits");
  assert.equal(schema.safeParse(`req_0${"a".repeat(25)}`).success, false, "lower-case letters are not Crockford");
});

test("fixture ids are valid, distinct, and stable between calls", () => {
  const values = Object.values(FIXTURE_IDS);
  assert.equal(new Set(values).size, values.length, "fixture ids collide");
  for (const id of values) {
    const prefix = id.slice(0, id.indexOf("_") + 1) as (typeof ID_PREFIXES)[number];
    assert.equal(idSchema(prefix).safeParse(id).success, true, `${id} is not a valid ${prefix} id`);
  }
  assert.equal(fixtureId("req_", 1), fixtureId("req_", 1));
});
