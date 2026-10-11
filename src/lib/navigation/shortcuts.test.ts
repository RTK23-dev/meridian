import assert from "node:assert/strict";
import test from "node:test";
import { CHORD_WINDOW_MS, INITIAL_SHORTCUT_STATE, chordPath, isTypingTarget, nextShortcutState, type ShortcutState } from "./shortcuts.ts";

/** Feeds key presses through the state machine, one after another, and returns each action in order. */
function press(keys: Array<{ key: string; at: number; ignore?: boolean }>): Array<ReturnType<typeof nextShortcutState>["action"]> {
  let state: ShortcutState = INITIAL_SHORTCUT_STATE;
  const actions: Array<ReturnType<typeof nextShortcutState>["action"]> = [];
  for (const press of keys) {
    const next = nextShortcutState(state, { key: press.key, now: press.at, ignore: press.ignore ?? false });
    state = next.state;
    actions.push(next.action);
  }
  return actions;
}

test("g followed by a chord letter navigates to that screen", () => {
  assert.deepEqual(press([{ key: "g", at: 0 }, { key: "o", at: 100 }]), [null, { kind: "navigate", target: "overview" }]);
  assert.deepEqual(press([{ key: "g", at: 0 }, { key: "s", at: 100 }]), [null, { kind: "navigate", target: "studio" }]);
  assert.deepEqual(press([{ key: "g", at: 0 }, { key: "r", at: 100 }]), [null, { kind: "navigate", target: "reviews" }]);
  assert.deepEqual(press([{ key: "g", at: 0 }, { key: "i", at: 100 }]), [null, { kind: "navigate", target: "intelligence" }]);
  assert.deepEqual(press([{ key: "g", at: 0 }, { key: "l", at: 100 }]), [null, { kind: "navigate", target: "learning" }]);
  assert.deepEqual(press([{ key: "g", at: 0 }, { key: "f", at: 100 }]), [null, { kind: "navigate", target: "factory" }]);
  assert.deepEqual(press([{ key: "g", at: 0 }, { key: "a", at: 100 }]), [null, { kind: "navigate", target: "accounts" }]);
});

test("the chord window closes after 900 ms", () => {
  assert.equal(CHORD_WINDOW_MS, 900);
  assert.deepEqual(press([{ key: "g", at: 0 }, { key: "o", at: 899 }])[1], { kind: "navigate", target: "overview" });
  assert.deepEqual(press([{ key: "g", at: 0 }, { key: "o", at: 900 }])[1], null, "exactly 900 ms is too late");
});

test("a chord ends after it fires, so a lone letter does nothing", () => {
  assert.deepEqual(press([{ key: "g", at: 0 }, { key: "o", at: 10 }, { key: "s", at: 20 }]), [null, { kind: "navigate", target: "overview" }, null]);
});

test("an unknown key after g cancels the chord", () => {
  assert.deepEqual(press([{ key: "g", at: 0 }, { key: "x", at: 10 }, { key: "o", at: 20 }]), [null, null, null]);
});

test("a second g restarts the chord window", () => {
  assert.deepEqual(press([{ key: "g", at: 0 }, { key: "g", at: 800 }, { key: "o", at: 1500 }])[2], { kind: "navigate", target: "overview" });
});

test("a key in an ignored context resets the chord, so the next letter does nothing", () => {
  assert.deepEqual(press([{ key: "g", at: 0 }, { key: "o", at: 10, ignore: true }, { key: "s", at: 20 }]), [null, null, null]);
});

test("slash opens the palette and question mark opens help, with or without a chord", () => {
  assert.deepEqual(press([{ key: "/", at: 0 }]), [{ kind: "palette" }]);
  assert.deepEqual(press([{ key: "?", at: 0 }]), [{ kind: "help" }]);
  assert.deepEqual(press([{ key: "g", at: 0 }, { key: "/", at: 10 }]), [null, { kind: "palette" }]);
});

test("the chord letter is matched without regard to case", () => {
  assert.deepEqual(press([{ key: "G", at: 0 }, { key: "S", at: 10 }]), [null, { kind: "navigate", target: "studio" }]);
});

test("nothing happens for an ordinary key", () => {
  assert.deepEqual(press([{ key: "j", at: 0 }, { key: "Enter", at: 10 }]), [null, null]);
});

test("a brand chord goes to the brand screen, and needs a brand", () => {
  assert.equal(chordPath("studio", "brand-1"), "/brands/brand-1/studio");
  assert.equal(chordPath("reviews", "brand-1"), "/brands/brand-1/reviews");
  assert.equal(chordPath("factory", "brand-1"), "/brands/brand-1/factory");
  assert.equal(chordPath("accounts", "brand-1"), "/brands/brand-1/accounts");
  assert.equal(chordPath("studio"), null, "a brand chord without a brand does nothing");
  assert.equal(chordPath("intelligence"), null);
  assert.equal(chordPath("learning", ""), null);
});

test("g o goes to the brand overview on a brand, and to the workspace overview elsewhere", () => {
  assert.equal(chordPath("overview", "brand-1"), "/brands/brand-1");
  assert.equal(chordPath("overview"), "/");
});

test("typing targets block shortcuts: text fields, selects and content-editable regions", () => {
  assert.equal(isTypingTarget({ tagName: "INPUT" }), true);
  assert.equal(isTypingTarget({ tagName: "textarea" }), true);
  assert.equal(isTypingTarget({ tagName: "SELECT" }), true);
  assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: true }), true);
});

test("other targets do not block shortcuts, including no target at all", () => {
  assert.equal(isTypingTarget({ tagName: "BUTTON" }), false);
  assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: false }), false);
  assert.equal(isTypingTarget({}), false);
  assert.equal(isTypingTarget(null), false);
  assert.equal(isTypingTarget(undefined), false);
  assert.equal(isTypingTarget("INPUT"), false, "only element-shaped targets count");
});
