import assert from "node:assert/strict";
import test from "node:test";
import { createDebouncer, DRAFT_SAVE_DELAY_MS } from "./debounce.ts";

/** Fake timers: nothing runs until the test fires them. */
function fakeTimers() {
  const live = new Map<number, { run: () => void; ms: number }>();
  let nextId = 1;
  return {
    live,
    timers: {
      setTimer: (run: () => void, ms: number) => {
        const id = nextId;
        nextId += 1;
        live.set(id, { run, ms });
        return id;
      },
      clearTimer: (id: number) => {
        live.delete(id);
      },
    },
    fireAll() {
      for (const [id, timer] of [...live]) {
        live.delete(id);
        timer.run();
      }
    },
  };
}

test("a draft waits 600 ms after the last change", () => {
  assert.equal(DRAFT_SAVE_DELAY_MS, 600);
  const clock = fakeTimers();
  createDebouncer(DRAFT_SAVE_DELAY_MS, clock.timers).call(() => {});
  assert.deepEqual([...clock.live.values()].map((timer) => timer.ms), [600]);
});

test("a burst of calls runs only the last call, once", () => {
  const clock = fakeTimers();
  const debouncer = createDebouncer(600, clock.timers);
  const ran: string[] = [];
  debouncer.call(() => ran.push("a"));
  debouncer.call(() => ran.push("b"));
  debouncer.call(() => ran.push("c"));
  assert.equal(clock.live.size, 1);
  clock.fireAll();
  clock.fireAll();
  assert.deepEqual(ran, ["c"]);
});

test("flush runs the waiting call now, once, and does nothing when no call waits", () => {
  const clock = fakeTimers();
  const debouncer = createDebouncer(600, clock.timers);
  const ran: string[] = [];
  debouncer.flush();
  debouncer.call(() => ran.push("a"));
  debouncer.flush();
  debouncer.flush();
  clock.fireAll();
  assert.deepEqual(ran, ["a"]);
  assert.equal(clock.live.size, 0);
});

test("cancel drops the waiting call, so nothing runs", () => {
  const clock = fakeTimers();
  const debouncer = createDebouncer(600, clock.timers);
  const ran: string[] = [];
  debouncer.call(() => ran.push("a"));
  debouncer.cancel();
  clock.fireAll();
  debouncer.flush();
  assert.deepEqual(ran, []);
});

test("a call made while a run is in progress waits for its own timer", () => {
  const clock = fakeTimers();
  const debouncer = createDebouncer(600, clock.timers);
  const ran: string[] = [];
  debouncer.call(() => {
    ran.push("a");
    debouncer.call(() => ran.push("b"));
  });
  clock.fireAll();
  assert.deepEqual(ran, ["a"]);
  assert.equal(clock.live.size, 1);
  clock.fireAll();
  assert.deepEqual(ran, ["a", "b"]);
});
