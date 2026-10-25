import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { captureStall, describeStall, recordPage } from "./page-diagnostics.mjs";

function fakePage() {
  const page = new EventEmitter();
  page.frame = { url: () => "https://app.example/brands/1/calibration" };
  page.mainFrame = () => page.frame;
  return page;
}

function fakeRequest(url) {
  return { url: () => url };
}

test("an empty record says nothing happened", () => {
  const page = fakePage();
  const state = recordPage(page);
  assert.equal(describeStall(state, 0), "no renderer crash; no request in flight; no page errors or warnings");
});

test("a crash, a navigation, a request still in flight and a page error are all named", () => {
  const page = fakePage();
  let clock = 10_000;
  const state = recordPage(page, () => clock);
  page.emit("framenavigated", page.frame);
  const pending = fakeRequest("https://app.example/api/slow");
  page.emit("request", pending);
  page.emit("pageerror", new Error("boom"));
  page.emit("crash");
  clock = 70_000;
  const text = describeStall(state, clock);
  assert.match(text, /renderer crashed 1 time\(s\)/);
  assert.match(text, /last navigation to https:\/\/app\.example\/brands\/1\/calibration, 60 s before/);
  assert.match(text, /1 request\(s\) in flight, the oldest https:\/\/app\.example\/api\/slow for 60 s/);
  assert.match(text, /uncaught: boom \(60 s before\)/);
});

test("a request that finishes or fails is no longer in flight", () => {
  const page = fakePage();
  const state = recordPage(page);
  const done = fakeRequest("https://app.example/api/done");
  const failed = fakeRequest("https://app.example/api/failed");
  page.emit("request", done);
  page.emit("request", failed);
  page.emit("requestfinished", done);
  page.emit("requestfailed", failed);
  assert.match(describeStall(state, 0), /no request in flight/);
});

test("console errors and warnings are kept, capped at the last five shown, and trimmed", () => {
  const page = fakePage();
  const state = recordPage(page, () => 0);
  const consoleMessage = (type, text) => ({ type: () => type, text: () => text });
  for (let index = 0; index < 25; index += 1) {
    page.emit("console", consoleMessage("error", `message ${index} ${"x".repeat(300)}`));
  }
  page.emit("console", consoleMessage("log", "ordinary log line"));
  const text = describeStall(state, 0);
  assert.match(text, /message 24 /);
  assert.match(text, /message 20 /);
  assert.doesNotMatch(text, /message 19 /);
  assert.doesNotMatch(text, /ordinary log line/);
  assert.doesNotMatch(text, /x{250}/);
  assert.match(text, /\.\.\. \(0 s before\)/);
});

test("a dialog is recorded and dismissed, so the page is not left blocked", async () => {
  const page = fakePage();
  const state = recordPage(page);
  let dismissed = false;
  page.emit("dialog", { type: () => "confirm", message: () => "Leave this page?", dismiss: async () => { dismissed = true; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dismissed, true);
  assert.match(describeStall(state, 0), /dialogs: confirm: Leave this page\?/);
});

test("a screenshot that succeeds is named with its path", async () => {
  const page = fakePage();
  let received;
  page.screenshot = async (options) => {
    received = options;
  };
  const text = await captureStall(page, "/tmp/shot.png");
  assert.equal(text, "Screenshot of the stalled page: /tmp/shot.png.");
  assert.equal(received.path, "/tmp/shot.png");
  assert.equal(received.timeout, 15_000);
});

test("a screenshot that fails is reported with its first line, and does not throw", async () => {
  const page = fakePage();
  page.screenshot = async () => {
    throw new Error("Timeout 15000ms exceeded.\nCall log: waiting for frame");
  };
  const text = await captureStall(page, "/tmp/shot.png");
  assert.equal(text, "No screenshot of the stalled page: Timeout 15000ms exceeded..");
});
