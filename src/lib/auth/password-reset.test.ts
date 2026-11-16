// Password reset: the email, and the answers. Fixtures only; no network, no auth server.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  PASSWORD_RESET_NOT_SET_UP,
  PASSWORD_RESET_REQUESTED,
  RESET_TOKEN_TTL_SECONDS,
  answerResetRequest,
  passwordResetEmailConfigured,
  resetPasswordEmail,
  resetPasswordLink,
} from "./password-reset.ts";
import { plainResetError } from "../../components/settings/form-model.ts";

describe("the reset email", () => {
  const message = resetPasswordEmail({ email: "a@example.test", token: "tok/en+1", origin: "https://app.example.test/" });

  test("goes to the account's address with a one-time link on this app's origin", () => {
    assert.equal(message.to, "a@example.test");
    assert.ok(message.text.includes("https://app.example.test/reset-password?token=tok%2Fen%2B1"));
    assert.equal(resetPasswordLink("https://app.example.test", "x"), "https://app.example.test/reset-password?token=x");
  });

  test("says it works once and when it expires", () => {
    assert.equal(RESET_TOKEN_TTL_SECONDS, 3600);
    assert.match(message.text, /works once and expires in 1 hour/);
    assert.match(message.text, /did not ask for this/);
  });
});

describe("the request answer", () => {
  test("not configured: says so, and requests nothing", async () => {
    let requested = 0;
    const answer = await answerResetRequest({ email: "a@example.test", configured: false, requestReset: async () => { requested += 1; } });
    assert.deepEqual(answer, { status: "not_set_up", message: PASSWORD_RESET_NOT_SET_UP });
    assert.match(answer.message, /not set up on this server/);
    assert.match(answer.message, /Ask whoever runs this server/);
    assert.equal(requested, 0);
  });

  test("configured: the same answer for a known and an unknown address", async () => {
    const asked: string[] = [];
    const known = await answerResetRequest({ email: "known@example.test", configured: true, requestReset: async (email) => { asked.push(email); } });
    const unknown = await answerResetRequest({ email: "nobody@example.test", configured: true, requestReset: async (email) => { asked.push(email); } });
    assert.deepEqual(known, unknown);
    assert.equal(known.message, PASSWORD_RESET_REQUESTED);
    assert.deepEqual(asked, ["known@example.test", "nobody@example.test"]);
  });

  test("configured means both the URL and the key are set", () => {
    assert.equal(passwordResetEmailConfigured({ EMAIL_API_URL: "https://e.test/send", EMAIL_API_KEY: "k" } as NodeJS.ProcessEnv), true);
    assert.equal(passwordResetEmailConfigured({ EMAIL_API_URL: "https://e.test/send" } as NodeJS.ProcessEnv), false);
    assert.equal(passwordResetEmailConfigured({ EMAIL_API_KEY: "k" } as NodeJS.ProcessEnv), false);
    assert.equal(passwordResetEmailConfigured({} as NodeJS.ProcessEnv), false);
  });
});

describe("a failed reset", () => {
  test("an expired or used link reads as a dead link", () => {
    assert.match(plainResetError({ code: "INVALID_TOKEN", status: 400, message: "Invalid token" }), /expired or was already used/);
    assert.match(plainResetError({ status: 400, message: "bad" }), /expired or was already used/);
  });
  test("a too-short password keeps its own sentence", () => {
    assert.equal(plainResetError({ code: "PASSWORD_TOO_SHORT", status: 400 }), "Use at least 8 characters.");
  });
});
