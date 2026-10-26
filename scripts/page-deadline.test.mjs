import { test } from "node:test";
import assert from "node:assert/strict";
import { withDeadline } from "./page-deadline.mjs";

test("a call that finishes in time returns its value", async () => {
  assert.equal(await withDeadline("the check", 60_000, Promise.resolve(7)), 7);
});

test("a call that fails keeps its own error", async () => {
  await assert.rejects(withDeadline("the check", 60_000, Promise.reject(new Error("own error"))), { message: "own error" });
});

test("a call that never answers fails with its label and the wait", async () => {
  await assert.rejects(withDeadline("/brands/x/content at 1440px: the overflow check", 20, new Promise(() => {})), {
    message: "/brands/x/content at 1440px: the overflow check did not finish within 20 ms",
  });
});

test("the wait is reported in seconds for a longer deadline", async () => {
  await assert.rejects(withDeadline("the scan", 1_500, new Promise(() => {})), {
    message: "the scan did not finish within 2 seconds",
  });
});

test("the detail from onExpire is added to the failure", async () => {
  await assert.rejects(withDeadline("the check", 20, new Promise(() => {}), { onExpire: async () => "The page had no crash." }), {
    message: "the check did not finish within 20 ms. The page had no crash.",
  });
});

test("a failing onExpire is reported in the failure and does not replace it", async () => {
  await assert.rejects(
    withDeadline("the check", 20, new Promise(() => {}), {
      onExpire: () => {
        throw new Error("screenshot broke");
      },
    }),
    { message: "the check did not finish within 20 ms. The diagnostic failed: screenshot broke" },
  );
});
