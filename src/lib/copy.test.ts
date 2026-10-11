import assert from "node:assert/strict";
import test from "node:test";
import { CONNECTION_MESSAGES, copy, decisionEngineLine, decisionOutcome, percentOrUnknown, plainError, providerLabel, serverCodeMessage, statusLabel } from "./copy.ts";

test("user-facing status and provider labels keep internal values readable", () => {
  assert.equal(statusLabel("NOT_CONNECTED"), "Not connected");
  assert.equal(statusLabel("in_review"), "Needs review");
  assert.equal(providerLabel("test:image"), "Test image");
  assert.equal(providerLabel("google:nano-banana"), "Google Nano Banana");
});

test("a server code that names a missing connection gets its fixed sentence", () => {
  assert.equal(serverCodeMessage("HYPIT_NOT_CONNECTED: no key"), CONNECTION_MESSAGES.hypitNotConnected);
  assert.equal(serverCodeMessage("NOT_CONNECTED"), CONNECTION_MESSAGES.notConnected);
  assert.equal(serverCodeMessage("provider said NOT_CONNECTED for meta"), CONNECTION_MESSAGES.notConnected);
});

test("HYPIT_NOT_CONNECTED is checked before NOT_CONNECTED, because it contains it", () => {
  assert.equal(serverCodeMessage("HYPIT_NOT_CONNECTED"), CONNECTION_MESSAGES.hypitNotConnected);
  assert.notEqual(serverCodeMessage("HYPIT_NOT_CONNECTED"), CONNECTION_MESSAGES.notConnected);
});

test("text with no known server code maps to null", () => {
  assert.equal(serverCodeMessage("something unexpected"), null);
  assert.equal(serverCodeMessage(""), null);
  assert.equal(serverCodeMessage("not_connected"), null, "codes are matched as the server sends them");
});

test("a known server code shows its sentence and keeps the raw text for Details", () => {
  const error = plainError(new Error("HYPIT_NOT_CONNECTED: key missing for workspace"));
  assert.equal(error.message, CONNECTION_MESSAGES.hypitNotConnected);
  assert.equal(error.raw, "HYPIT_NOT_CONNECTED: key missing for workspace");
});

test("the raw text is never placed in the message shown above the disclosure", () => {
  const secret = "token sk_live_123 leaked in stack";
  const error = plainError(new Error(secret));
  assert.equal(error.raw, secret);
  assert.equal(error.message.includes("sk_live_123"), false);
  assert.equal(error.message, "The request did not finish. Try again. Open Details for the exact message.");
});

test("a network failure gets the unreachable sentence, whatever the browser's wording", () => {
  for (const text of ["Failed to fetch", "NetworkError when attempting to fetch resource.", "Network request failed", "Load failed", "fetch failed"]) {
    const error = plainError(new Error(text));
    assert.equal(error.message, "Meridian could not be reached. Check your connection and try again.", text);
    assert.equal(error.raw, text);
  }
});

test("an error with no text gets the plain generic sentence, with no Details hint", () => {
  for (const input of ["", "   ", null, undefined, 42, {}]) {
    const error = plainError(input);
    assert.equal(error.message, "The request did not finish. Try again.");
    assert.equal(error.raw, "");
  }
});

test("a plain-object error with a message is read the same as an Error", () => {
  assert.equal(plainError({ message: "HYPIT_NOT_CONNECTED" }).message, CONNECTION_MESSAGES.hypitNotConnected);
  assert.equal(plainError("  padded text  ").raw, "padded text");
});

test("a whole value shows as a whole percentage, and a real zero stays 0%", () => {
  assert.equal(percentOrUnknown(0.824), "82%");
  assert.equal(percentOrUnknown(0), "0%");
  assert.equal(percentOrUnknown(1), "100%");
});

test("a missing or non-finite value shows as unknown, never as 0%", () => {
  for (const value of [Number.NaN, null, undefined, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "0.5", {}]) {
    assert.equal(percentOrUnknown(value), "unknown", String(value));
  }
});

test("decision codes read as words, and an unset or unlisted decision is said plainly", () => {
  assert.equal(decisionOutcome("AUTO_APPROVE"), "Approved");
  assert.equal(decisionOutcome("HUMAN_REVIEW"), "Needs a person");
  assert.equal(decisionOutcome("REJECT"), "Rejected");
  assert.equal(decisionOutcome(""), "No decision yet");
  assert.equal(decisionOutcome("SOMETHING_NEW"), "Unknown decision");
});

test("the decision engine line labels the number as a probability and shows unknown when it is missing", () => {
  assert.equal(decisionEngineLine({ decision: "AUTO_APPROVE", probability: 0.82 }), "Decision engine: approved (probability 82%)");
  assert.equal(decisionEngineLine({ decision: "HUMAN_REVIEW", probability: Number.NaN }), "Decision engine: needs a person (probability unknown)");
  assert.equal(decisionEngineLine({ decision: "", probability: 0.5 }), "Decision engine: no decision yet", "no decision means no probability is shown");
});

test("status and provider names read as words and never show a raw code", () => {
  assert.equal(statusLabel("in_review"), "Needs review");
  assert.equal(statusLabel("NOT-CONNECTED"), "Not connected");
  assert.equal(statusLabel("awaiting_upload"), "Awaiting upload");
  assert.equal(statusLabel("  "), "Unknown");
  assert.equal(providerLabel("google"), "Google Ads");
  assert.equal(providerLabel("test:image"), "Test image");
  assert.equal(providerLabel("new_provider"), "New provider");
});

test("pluralised copy reads correctly for one and for many", () => {
  assert.equal(copy.opportunities.rankedNote(1).startsWith("1 candidate ranked."), true);
  assert.equal(copy.opportunities.rankedNote(2).startsWith("2 candidates ranked."), true);
  assert.equal(copy.learning.patternsStored(1).startsWith("1 pattern stored."), true);
  assert.equal(copy.learning.patternsStored(3).startsWith("3 patterns stored."), true);
});
