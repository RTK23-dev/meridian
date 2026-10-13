import assert from "node:assert/strict";
import test from "node:test";
import { createLocalJobRunner, localJobsEnabled } from "./local-jobs.mjs";

/** Timers the test controls: a scheduled pass is recorded and only runs when the test calls runOnce. */
function fakeTimers() {
  const scheduled = [];
  return {
    scheduled,
    setTimer(fn, ms) {
      const handle = {
        fn,
        ms,
        cleared: false,
        unrefed: false,
        unref() {
          this.unrefed = true;
        },
      };
      scheduled.push(handle);
      return handle;
    },
    clearTimer(handle) {
      handle.cleared = true;
    },
  };
}

function recorder() {
  const lines = { info: [], error: [] };
  return {
    lines,
    log: (message) => lines.info.push(message),
    logError: (message) => lines.error.push(message),
  };
}

test("the job loop runs only when DATABASE_URL is unset or blank", () => {
  assert.equal(localJobsEnabled({}), true);
  assert.equal(localJobsEnabled({ DATABASE_URL: "" }), true);
  assert.equal(localJobsEnabled({ DATABASE_URL: "   " }), true);
  assert.equal(localJobsEnabled({ DATABASE_URL: "postgres://db.internal:5432/meridian" }), false);
});

test("start says that the dev server runs the jobs, and runs the first pass at once", async () => {
  const timers = fakeTimers();
  const out = recorder();
  let ticks = 0;
  const runner = createLocalJobRunner({
    runTick: async () => {
      ticks += 1;
      return { claimed: 0, stopped: false };
    },
    log: out.log,
    logError: out.logError,
    intervalMs: 5000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  runner.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ticks, 1);
  assert.match(out.lines.info[0], /Running queued jobs inside this dev server, every 5 s/);
  assert.match(out.lines.info[0], /no worker process is needed/);
  assert.deepEqual(out.lines.error, []);
});

test("a pass logs the jobs it ran, and schedules the next pass at the interval, unref'd", async () => {
  const timers = fakeTimers();
  const out = recorder();
  let ticks = 0;
  const runner = createLocalJobRunner({
    runTick: async () => {
      ticks += 1;
      return { claimed: 2, stopped: false };
    },
    log: out.log,
    logError: out.logError,
    intervalMs: 5000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  await runner.runOnce();
  assert.equal(ticks, 1);
  assert.deepEqual(out.lines.info, ["[jobs] Ran 2 jobs."]);
  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0].ms, 5000);
  assert.equal(
    timers.scheduled[0].unrefed,
    true,
    "the timer must not keep a process alive on its own",
  );
  assert.deepEqual(out.lines.error, []);
});

test("one job is logged in the singular, and an idle pass logs nothing", async () => {
  const timers = fakeTimers();
  const out = recorder();
  let claimed = 1;
  const runner = createLocalJobRunner({
    runTick: async () => ({ claimed, stopped: false }),
    log: out.log,
    logError: out.logError,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  await runner.runOnce();
  claimed = 0;
  await runner.runOnce();
  assert.deepEqual(out.lines.info, ["[jobs] Ran 1 job."]);
});

test("a failed pass is logged, never throws, and retries with a back-off capped at the maximum, which resets after a success", async () => {
  const timers = fakeTimers();
  const out = recorder();
  let failing = true;
  const runner = createLocalJobRunner({
    runTick: async () => {
      if (failing) throw new Error('relation "jobs" does not exist');
      return { claimed: 0, stopped: false };
    },
    log: out.log,
    logError: out.logError,
    intervalMs: 5000,
    maxBackoffMs: 60000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  await runner.runOnce();
  assert.match(
    out.lines.error[0],
    /A job pass failed \(1 in a row\): relation "jobs" does not exist/,
  );
  assert.match(
    out.lines.error.at(-1),
    /The dev server keeps running\. The next pass runs in 10 s\./,
  );
  assert.equal(timers.scheduled.at(-1).ms, 10000);

  await runner.runOnce();
  assert.equal(timers.scheduled.at(-1).ms, 20000);
  await runner.runOnce();
  assert.equal(timers.scheduled.at(-1).ms, 40000);
  await runner.runOnce();
  assert.equal(timers.scheduled.at(-1).ms, 60000, "the back-off stops at the maximum");
  await runner.runOnce();
  assert.equal(timers.scheduled.at(-1).ms, 60000);

  failing = false;
  await runner.runOnce();
  assert.equal(
    timers.scheduled.at(-1).ms,
    5000,
    "a successful pass returns to the normal interval",
  );
  assert.deepEqual(out.lines.info, ["[jobs] The job pass works again."]);
});

test("a thrown value that is not an Error is logged as text, and the loop goes on", async () => {
  const timers = fakeTimers();
  const out = recorder();
  const runner = createLocalJobRunner({
    runTick: async () => {
      throw "disk full";
    },
    log: out.log,
    logError: out.logError,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  await runner.runOnce();
  assert.match(out.lines.error[0], /disk full/);
  assert.equal(timers.scheduled.length, 1, "the next pass is still scheduled");
});

test("stop clears the scheduled pass, and a stopped loop never ticks again", async () => {
  const timers = fakeTimers();
  const out = recorder();
  let ticks = 0;
  const runner = createLocalJobRunner({
    runTick: async () => {
      ticks += 1;
      return { claimed: 0, stopped: false };
    },
    log: out.log,
    logError: out.logError,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  await runner.runOnce();
  assert.equal(timers.scheduled.length, 1);
  runner.stop();
  assert.equal(timers.scheduled[0].cleared, true);
  await runner.runOnce();
  assert.equal(ticks, 1);
  assert.equal(timers.scheduled.length, 1, "nothing is scheduled after a stop");
});

test("a pass that is running when the loop stops schedules nothing after it finishes", async () => {
  const timers = fakeTimers();
  const out = recorder();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const runner = createLocalJobRunner({
    runTick: async () => {
      await gate;
      return { claimed: 0, stopped: false };
    },
    log: out.log,
    logError: out.logError,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const running = runner.runOnce();
  runner.stop();
  release();
  await running;
  assert.equal(timers.scheduled.length, 0);
  assert.deepEqual(out.lines.error, []);
});
