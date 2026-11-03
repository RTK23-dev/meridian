import assert from "node:assert/strict";
import test from "node:test";
import { frameAncestorsPolicy } from "./frame-policy.mjs";

test("unset or blank means only Meridian's own pages may frame it", () => {
  assert.deepEqual(frameAncestorsPolicy(undefined), { value: "'self'", problems: [] });
  assert.deepEqual(frameAncestorsPolicy("  , "), { value: "'self'", problems: [] });
});

test("plain https origins are listed, trimmed and de-duplicated", () => {
  assert.deepEqual(frameAncestorsPolicy("https://victor.ceo"), { value: "https://victor.ceo", problems: [] });
  assert.deepEqual(frameAncestorsPolicy(" https://victor.ceo/ , https://www.victor.ceo,https://victor.ceo "), {
    value: "https://victor.ceo https://www.victor.ceo",
    problems: [],
  });
});

test("'self' may be listed beside an origin", () => {
  assert.deepEqual(frameAncestorsPolicy("'self',https://victor.ceo"), { value: "'self' https://victor.ceo", problems: [] });
});

test("an entry that is not a plain https origin is a problem, and the whole policy falls back to 'self'", () => {
  for (const bad of ["http://victor.ceo", "https://victor.ceo/meridian", "https://victor.ceo?x=1", "https://*.victor.ceo", "victor.ceo", "https://user:pw@victor.ceo"]) {
    const result = frameAncestorsPolicy(`https://good.example,${bad}`);
    assert.equal(result.value, "'self'", `${bad} must not widen the policy`);
    assert.equal(result.problems.length, 1, `${bad} is reported once`);
    assert.ok(result.problems[0].includes(bad));
  }
});
