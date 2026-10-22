import { test } from "node:test";
import assert from "node:assert/strict";
import { quoteAllowsRemake, quoteSentence } from "./shot-presentation.ts";

test("a fitting quote says what is reserved, as an estimate that is released when unspent", () => {
  const text = quoteSentence({ status: "quoted", fits: true, reservedUsd: 0.1234, reasons: [] });
  assert.match(text, /holds up to \$0\.1234/);
  assert.match(text, /estimate at list prices/);
});

test("a quote that does not fit says the remake would be refused, and why", () => {
  const text = quoteSentence({ status: "quoted", fits: false, reservedUsd: 2, reasons: ["the remake would take the request over its $1.0000 budget"] });
  assert.match(text, /would be refused: the remake would take the request over its \$1\.0000 budget/);
});

test("a refused quote shows its first reason", () => {
  assert.equal(quoteSentence({ status: "refused", reasons: ["This session has no video yet."] }), "This session has no video yet.");
});

test("the remake button waits for the quote, and is off when the quote is refused or does not fit", () => {
  assert.equal(quoteAllowsRemake({ state: "loading" }), false);
  assert.equal(quoteAllowsRemake({ state: "unavailable" }), true, "the engine checks again on confirm");
  assert.equal(quoteAllowsRemake({ state: "ready", quote: { status: "quoted", fits: true, reservedUsd: 0.1, reasons: [] } }), true);
  assert.equal(quoteAllowsRemake({ state: "ready", quote: { status: "quoted", fits: false, reservedUsd: 9, reasons: ["over"] } }), false);
  assert.equal(quoteAllowsRemake({ state: "ready", quote: { status: "refused", reasons: ["no"] } }), false);
});
