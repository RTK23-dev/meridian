// The unsent draft of a cookbook's settings (K17): a stored value is restored only when it fits its control; a change is saved after the pause,
// once; a draft equal to the defaults is not kept; discard drops the draft and any waiting save. Storage and timers are fakes.

import assert from "node:assert/strict";
import { test } from "node:test";
import { builtinCookbook } from "../../lib/meridian/cookbooks/builtin/index.ts";
import type { DebounceTimers } from "../../lib/progress/debounce.ts";
import type { DraftStorage } from "../../lib/progress/draft-store.ts";
import { createSettingsDraft, restoredValues } from "./settings-draft.ts";

const EXPLAINER = builtinCookbook("ck_3d_data_explainer");
if (EXPLAINER === undefined) throw new Error("the explainer is built in");
const SCOPE = { userId: "user_1", workspaceId: "org_1", screen: "cookbook-settings:ck_3d_data_explainer" };
const DEFAULT_PACE = EXPLAINER.controls.find((control) => control.id === "pace")?.default;

function fakeStorage() {
  const items = new Map<string, string>();
  const storage: DraftStorage = {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
  return { items, storage };
}

function fakeTimers() {
  const pending: Array<{ run: () => void; cancelled: boolean }> = [];
  const timers: DebounceTimers<{ run: () => void; cancelled: boolean }> = {
    setTimer: (run) => {
      const handle = { run, cancelled: false };
      pending.push(handle);
      return handle;
    },
    clearTimer: (handle) => {
      handle.cancelled = true;
    },
  };
  return {
    timers,
    fire() {
      for (const handle of pending.splice(0)) if (!handle.cancelled) handle.run();
    },
    count: () => pending.filter((handle) => !handle.cancelled).length,
  };
}

test("a stored value that fits its control is restored, and one that does not is replaced by the default (K17)", () => {
  const restored = restoredValues(EXPLAINER, { pace: 1.2, data_panels: "yes", not_a_control: 9 });
  assert.equal(restored.pace, 1.2, "a number inside the slider's bounds is kept");
  assert.equal(restored.data_panels, EXPLAINER.controls.find((control) => control.id === "data_panels")?.default, "a word is not a toggle value");
  assert.equal(Object.keys(restored).includes("not_a_control"), false, "an unknown control is ignored");
});

test("a saved draft that is not an object, or is not a list of values, restores the defaults", () => {
  for (const saved of [null, "text", 42, ["pace"]]) {
    assert.equal(restoredValues(EXPLAINER, saved).pace, DEFAULT_PACE);
  }
  const out_of_range = restoredValues(EXPLAINER, { pace: 999 });
  assert.equal(out_of_range.pace, DEFAULT_PACE, "a stored number outside its bounds is not used");
});

test("a change is saved once, after the pause, and a reload restores it (K17)", () => {
  const { items, storage } = fakeStorage();
  const clock = fakeTimers();
  const draft = createSettingsDraft({ cookbook: EXPLAINER, scope: SCOPE, storage, timers: clock.timers });
  draft.change("pace", 1.2);
  draft.change("pace", 1.4);
  assert.equal(items.size, 0, "nothing is saved before the pause");
  clock.fire();
  assert.equal(items.size, 1, "one save after the pause, for the last change");
  const reloaded = createSettingsDraft({ cookbook: EXPLAINER, scope: SCOPE, storage, timers: fakeTimers().timers });
  assert.equal(reloaded.values().pace, 1.4, "the reload shows the draft");
});

test("a change that does not fit its control is ignored and nothing is saved for it (K17)", () => {
  const { items, storage } = fakeStorage();
  const clock = fakeTimers();
  const draft = createSettingsDraft({ cookbook: EXPLAINER, scope: SCOPE, storage, timers: clock.timers });
  draft.change("pace", 999);
  draft.change("no_such_control", 1);
  assert.equal(clock.count(), 0, "no save is scheduled for a refused change");
  assert.equal(draft.values().pace, DEFAULT_PACE);
  assert.equal(items.size, 0);
});

test("a draft equal to the defaults is not kept: the stored draft is removed", () => {
  const { items, storage } = fakeStorage();
  const clock = fakeTimers();
  const draft = createSettingsDraft({ cookbook: EXPLAINER, scope: SCOPE, storage, timers: clock.timers });
  draft.change("pace", 1.2);
  clock.fire();
  assert.equal(items.size, 1);
  draft.change("pace", DEFAULT_PACE ?? 1);
  clock.fire();
  assert.equal(items.size, 0, "back at the default, nothing is kept");
});

test("flush saves now, and discard drops the draft and any waiting save, and returns the defaults (K17)", () => {
  const { items, storage } = fakeStorage();
  const clock = fakeTimers();
  const draft = createSettingsDraft({ cookbook: EXPLAINER, scope: SCOPE, storage, timers: clock.timers });
  draft.change("pace", 1.2);
  draft.flush();
  assert.equal(items.size, 1, "flush saves without waiting");
  draft.change("pace", 1.4);
  draft.discard();
  clock.fire();
  assert.equal(items.size, 0, "discard removes the draft and the waiting save never runs");
  assert.equal(draft.values().pace, DEFAULT_PACE);
});

test("the pick's resolved values are the starting point, a saved draft still wins, and a draft equal to them is not kept (K18d2)", () => {
  const { items, storage } = fakeStorage();
  const clock = fakeTimers();
  const base = { pace: 1.2 };
  const draft = createSettingsDraft({ cookbook: EXPLAINER, base, scope: SCOPE, storage, timers: clock.timers });
  assert.equal(draft.values().pace, 1.2, "the selector's value is the start, not the default");
  draft.change("pace", 1.4);
  clock.fire();
  assert.equal(items.size, 1, "a change from the start is saved");
  const reloaded = createSettingsDraft({ cookbook: EXPLAINER, base, scope: SCOPE, storage, timers: clock.timers });
  assert.equal(reloaded.values().pace, 1.4, "the saved draft wins over the start");
  reloaded.change("pace", 1.2);
  clock.fire();
  assert.equal(items.size, 0, "back at the start, nothing is kept");
});

