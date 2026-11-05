import assert from "node:assert/strict";
import test from "node:test";
import { bradleyTerry, pairSchedule, ranked, ratingOf, reliability, resolvePair, showingsOf, type PairResult, type Showing } from "./tournament.ts";

test("the schedule pairs each id with several others, never itself, never the same pair twice, and replays from its seed", () => {
  const ids = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"];
  const pairs = pairSchedule(ids, 2, "run");
  assert.deepEqual(pairs, pairSchedule(ids, 2, "run"));
  assert.equal(pairs.length, 16, "8 ids x 2 offsets");
  const keys = pairs.map((pair) => [pair.a, pair.b].sort().join("|"));
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(pairs.every((pair) => pair.a !== pair.b));
  for (const id of ids) assert.equal(pairs.filter((pair) => pair.a === id || pair.b === id).length, 4);
  assert.deepEqual(pairSchedule(["c1"], 2, "run"), []);
  assert.equal(pairSchedule(["c1", "c2", "c3"], 5, "run").length, 3, "with few ids every pair is played once");
});

const showing = (a: string, b: string, first: string, verdict: Showing["verdict"]): Showing => ({
  pair: { a, b },
  first,
  second: first === a ? b : a,
  verdict,
});

test("a pair is won only when both showings agree; a flip with the order is a tie and inconsistent", () => {
  const pair = { a: "c1", b: "c2" };
  const [forward, swapped] = showingsOf(pair);
  assert.deepEqual(forward, { first: "c1", second: "c2" });
  assert.deepEqual(swapped, { first: "c2", second: "c1" });
  assert.deepEqual(resolvePair(showing("c1", "c2", "c1", "first"), showing("c1", "c2", "c2", "second")), { pair, winner: "c1", consistent: true });
  assert.deepEqual(resolvePair(showing("c1", "c2", "c1", "first"), showing("c1", "c2", "c2", "first")), { pair, winner: null, consistent: false }, "a judge that always picks the first shown");
  assert.deepEqual(resolvePair(showing("c1", "c2", "c1", "tie"), showing("c1", "c2", "c2", "tie")), { pair, winner: null, consistent: true });
});

test("Bradley-Terry ranks a clear winner first, keeps every strength finite, and centres the ratings on 1500", () => {
  const ids = ["a", "b", "c", "d"];
  const results: PairResult[] = [
    { pair: { a: "a", b: "b" }, winner: "a", consistent: true },
    { pair: { a: "a", b: "c" }, winner: "a", consistent: true },
    { pair: { a: "a", b: "d" }, winner: "a", consistent: true },
    { pair: { a: "b", b: "c" }, winner: "b", consistent: true },
    { pair: { a: "b", b: "d" }, winner: "b", consistent: true },
    { pair: { a: "c", b: "d" }, winner: null, consistent: true },
  ];
  const strengths = bradleyTerry(ids, results);
  const order = ranked(ids, strengths);
  assert.deepEqual(order.map((entry) => entry.id).slice(0, 2), ["a", "b"]);
  assert.ok(order.every((entry) => Number.isFinite(entry.strength) && entry.strength > 0), "the prior keeps a winless item finite");
  const meanLog = order.reduce((total, entry) => total + Math.log(entry.strength), 0) / order.length;
  assert.ok(Math.abs(meanLog) < 1e-9);
  assert.equal(ratingOf(1), 1500);
  assert.ok(ratingOf(strengths.get("a")!) > 1500);
});

test("with no games everyone is equal, and equal strengths keep the input order", () => {
  const order = ranked(["x", "y"], bradleyTerry(["x", "y"], []));
  assert.deepEqual(order.map((entry) => [entry.id, entry.rating]), [["x", 1500], ["y", 1500]]);
});

test("a judge with a pure position bias is caught: every pair a tie, consistency 0, first-shown win rate 1, unreliable", () => {
  const pairs = pairSchedule(["c1", "c2", "c3", "c4"], 1, "bias");
  const showings: Showing[] = [];
  const results: PairResult[] = [];
  for (const pair of pairs) {
    const forward = showing(pair.a, pair.b, pair.a, "first");
    const swapped = showing(pair.a, pair.b, pair.b, "first");
    showings.push(forward, swapped);
    results.push(resolvePair(forward, swapped));
  }
  assert.ok(results.every((result) => result.winner === null));
  const report = reliability(showings, results);
  assert.equal(report.consistency, 0);
  assert.equal(report.firstShownWinRate, 1);
  assert.equal(report.unreliable, true);
});

test("a consistent judge is reliable, and an empty tournament never is", () => {
  const forward = showing("c1", "c2", "c1", "first");
  const swapped = showing("c1", "c2", "c2", "second");
  const report = reliability([forward, swapped], [resolvePair(forward, swapped)]);
  assert.equal(report.consistency, 1);
  assert.equal(report.firstShownWinRate, 0.5);
  assert.equal(report.unreliable, false);
  assert.equal(reliability([], []).unreliable, true);
});
