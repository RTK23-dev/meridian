// The hook history of a brand's started videos (portfolio): repeats are found by wording, a missing hook is never invented, and the
// similarity rule is the one the module states.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hookHistoryOf, hookOfBeats, hookSimilarity, normalizeHook, repeatedHooks, type HookRecord } from "./hook-history.ts";

function record(sessionId: string, hook: string, startedAt: string | null = "2026-10-01T10:00:00Z"): HookRecord {
  return { sessionId, title: `Video ${sessionId}`, startedAt, hook };
}

describe("normalising a hook", () => {
  it("lower-cases and drops punctuation, so wording differences that are only punctuation are the same", () => {
    assert.equal(normalizeHook("  Stop scrolling! Try THIS, now.  "), "stop scrolling try this now");
    assert.equal(hookSimilarity("Stop scrolling!", "stop   scrolling"), 1);
  });
});

describe("similarity", () => {
  it("is 1 for the same wording and 0 when nothing is shared", () => {
    assert.equal(hookSimilarity("Lather like this", "lather like this"), 1);
    assert.equal(hookSimilarity("Lather like this", "Zebra crossing"), 0);
  });

  it("is the share of words the two hooks have in common", () => {
    // words: {show, the, lather, in, one, minute} and {show, the, lather, in, ten, seconds}: 4 shared of 8 distinct.
    assert.equal(hookSimilarity("show the lather in one minute", "show the lather in ten seconds"), 4 / 8);
  });

  it("treats an empty hook as no similarity, never as a match", () => {
    assert.equal(hookSimilarity("", ""), 0);
    assert.equal(hookSimilarity("  ", "Lather"), 0);
  });
});

describe("the hook of a script", () => {
  it("is the first beat with role hook and some words", () => {
    assert.equal(hookOfBeats([{ role: "setup", text: "Bars on a sink" }, { role: "hook", text: " Stop scrolling " }, { role: "hook", text: "Later" }]), "Stop scrolling");
  });

  it("is null when the script has no hook beat, or only an empty one", () => {
    assert.equal(hookOfBeats([{ role: "setup", text: "Bars on a sink" }]), null);
    assert.equal(hookOfBeats([{ role: "hook", text: "   " }]), null);
  });
});

describe("repeated hooks", () => {
  it("groups records with the same wording as same, newest first", () => {
    const repeats = repeatedHooks([record("a", "Stop scrolling", "2026-10-01T10:00:00Z"), record("b", "stop scrolling!", "2026-10-03T10:00:00Z")]);
    assert.equal(repeats.length, 1);
    assert.equal(repeats[0]?.kind, "same");
    assert.equal(repeats[0]?.hook, "stop scrolling!", "the newest record's hook is shown");
    assert.deepEqual(repeats[0]?.records.map((item) => item.sessionId), ["b", "a"]);
  });

  it("groups hooks that share most of their words as similar, and says so", () => {
    // 6 of 7 distinct words are shared: 0.857, above the 0.6 threshold.
    const repeats = repeatedHooks([record("a", "Show the lather in one minute"), record("b", "Show the lather in one minute today")]);
    assert.equal(repeats.length, 1);
    assert.equal(repeats[0]?.kind, "similar");
  });

  it("does not group hooks that share only half their words, which is below the threshold", () => {
    // "Show the lather in one minute" and "Show the lather in ten seconds" share 4 of 8 distinct words: 0.5.
    assert.deepEqual(repeatedHooks([record("a", "Show the lather in one minute"), record("b", "Show the lather in ten seconds")]), []);
  });

  it("does not group hooks below the similarity threshold, and returns nothing for a single record", () => {
    assert.deepEqual(repeatedHooks([record("a", "Stop scrolling"), record("b", "A lather that lasts")]), []);
    assert.deepEqual(repeatedHooks([record("a", "Stop scrolling")]), []);
  });

  it("links a chain of similar hooks into one group, marked similar because the first and last are not alike", () => {
    // a~b (4 of 6 words shared) and b~c (4 of 5), but a and c share only 3 of 6, so they are linked only through b.
    const a = "one two three four five";
    const b = "two three four five six";
    const c = "three four five six";
    assert.ok(hookSimilarity(a, b) >= 0.6 && hookSimilarity(b, c) >= 0.6 && hookSimilarity(a, c) < 0.6, "the chain is set up as the test says");
    const repeats = repeatedHooks([record("a", a), record("b", b), record("c", c)]);
    assert.equal(repeats.length, 1, "a, b and c are one group, linked through b");
    assert.equal(repeats[0]?.records.length, 3);
    assert.equal(repeats[0]?.kind, "similar");
  });

  it("orders groups by size, largest first", () => {
    const repeats = repeatedHooks([
      record("a", "Stop scrolling"),
      record("b", "Stop scrolling"),
      record("c", "Lather like a pro"),
      record("d", "Lather like a pro"),
      record("e", "Lather like a pro"),
    ]);
    assert.deepEqual(repeats.map((group) => group.records.length), [3, 2]);
  });
});

describe("the hook history a person reads", () => {
  it("counts started videos and those with a recorded hook, and never counts a missing hook as a hook", () => {
    const history = hookHistoryOf([
      { sessionId: "a", title: "A", startedAt: "2026-10-01T10:00:00Z", hook: "Stop scrolling" },
      { sessionId: "b", title: "B", startedAt: "2026-10-02T10:00:00Z", hook: null },
      { sessionId: "c", title: "C", startedAt: "2026-10-03T10:00:00Z", hook: "stop scrolling" },
    ]);
    assert.equal(history.started, 3);
    assert.equal(history.hooked, 2);
    assert.equal(history.repeats.length, 1);
    assert.equal(history.repeats[0]?.records.length, 2, "the video with no hook is not in the repeat");
  });

  it("reports no repeats for a brand whose hooks are all worded differently", () => {
    const history = hookHistoryOf([
      { sessionId: "a", title: "A", startedAt: null, hook: "Stop scrolling" },
      { sessionId: "b", title: "B", startedAt: null, hook: "A lather that lasts" },
    ]);
    assert.deepEqual(history, { started: 2, hooked: 2, repeats: [] });
  });
});
