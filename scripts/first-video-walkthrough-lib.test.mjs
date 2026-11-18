import assert from "node:assert/strict";
import test from "node:test";
import { WALKTHROUGH_LIMIT_MS, stepTimer, walkthroughAccount, walkthroughBase, walkthroughReport, walkthroughVerdict } from "./first-video-walkthrough-lib.mjs";

test("the base is an http(s) origin, and anything with a path, query or credentials is refused", () => {
  assert.equal(walkthroughBase(), "http://127.0.0.1:8080");
  assert.equal(walkthroughBase("https://staging.example.com/"), "https://staging.example.com");
  assert.throws(() => walkthroughBase("http://127.0.0.1:8080/app"), /no credentials, path/);
  assert.throws(() => walkthroughBase("http://user:pw@127.0.0.1:8080"), /no credentials/);
  assert.throws(() => walkthroughBase("ftp://127.0.0.1"), /http\(s\) origin/);
  assert.throws(() => walkthroughBase("not a url"), /not a URL/);
});

test("each run signs up with its own account on example.com", () => {
  const one = walkthroughAccount(1_700_000_000_000, () => 0.1);
  const two = walkthroughAccount(1_700_000_000_001, () => 0.1);
  assert.match(one.email, /^first-video-[a-z0-9]+@example\.com$/);
  assert.notEqual(one.email, two.email);
  assert.ok(one.password.length >= 12);
});

test("the timer records each step's time, and a failed step is recorded with its reason and rethrown", async () => {
  let clock = 0;
  const timer = stepTimer(() => clock);
  await timer.run("sign up", async () => {
    clock += 1500;
  });
  await assert.rejects(
    timer.run("open Create", async () => {
      clock += 200;
      throw new Error("no heading\nstack");
    }),
    /no heading/,
  );
  assert.deepEqual(timer.steps, [
    { name: "sign up", ms: 1500, ok: true },
    { name: "open Create", ms: 200, ok: false, error: "no heading" },
  ]);
  assert.equal(timer.elapsed(), 1700);
});

test("the verdict passes only with every step done, within the limit and with no page error", () => {
  const steps = [{ name: "a", ms: 10, ok: true }, { name: "b", ms: 10, ok: true }];
  assert.deepEqual(walkthroughVerdict({ steps, expected: ["a", "b"], totalMs: 20, pageErrors: [] }), { pass: true, reasons: [] });

  const slow = walkthroughVerdict({ steps, expected: ["a", "b"], totalMs: WALKTHROUGH_LIMIT_MS + 1, pageErrors: [] });
  assert.equal(slow.pass, false);
  assert.match(slow.reasons[0], /over the 600\.0 s limit/);

  const errored = walkthroughVerdict({ steps, expected: ["a", "b"], totalMs: 20, pageErrors: ["TypeError: x is undefined"] });
  assert.match(errored.reasons[0], /1 page error/);

  const short = walkthroughVerdict({ steps: [steps[0]], expected: ["a", "b"], totalMs: 20, pageErrors: [] });
  assert.match(short.reasons[0], /did not run: b/);
});

test("the report lists each step and ends with a SUMMARY line and the reasons", () => {
  const steps = [{ name: "sign up", ms: 1234, ok: true }, { name: "open Create", ms: 50, ok: false, error: "timeout" }];
  const verdict = walkthroughVerdict({ steps, expected: ["sign up", "open Create"], totalMs: 1284, pageErrors: [] });
  const report = walkthroughReport({ steps, totalMs: 1284, verdict });
  assert.match(report, /^PASS sign up\s+1\.2 s$/m);
  assert.match(report, /^FAIL open Create\s+0\.1 s {2}timeout$/m);
  assert.match(report, /^SUMMARY first-video walkthrough FAILED in 1\.3 s \(1\/2 steps\)$/m);
});
