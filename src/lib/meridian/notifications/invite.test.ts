// Invitation delivery states, on fixture transports and a recording sql stub. No test reaches the network.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Sql } from "../learning/store.ts";
import type { Transport, TransportRequest } from "../providers/http.ts";
import { realEmailProvider } from "./email.ts";
import { createInvitation, type InviteOutcome } from "./invite.ts";

const ENV = { url: "https://email.example.test/send", key: "fixture-key-not-real" };

/** Records each status the invite row goes through, in order. */
function stubSql() {
  const row = { status: "pending", send_count: 0, last_error: "" };
  const history: string[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("insert into invites")) return [];
    if (text.includes("set status = 'sending'")) {
      row.status = "sending";
      row.send_count += 1;
      history.push("sending");
      return [{ send_count: row.send_count }];
    }
    if (text.includes("set status = 'sent'")) {
      assert.ok(history.at(-1) === "sending", "sent follows sending");
      row.status = "sent";
      history.push("sent");
      return [];
    }
    if (text.includes("set status = ?")) {
      row.status = String(values[0]);
      row.last_error = String(values[1]);
      history.push(row.status);
      return [];
    }
    return [];
  }) as Sql;
  sql.query = async () => [];
  return { sql, row, history };
}

function transportAnswering(answer: () => { status: number; body?: string } | Error) {
  const calls: TransportRequest[] = [];
  const transport: Transport = async (request) => {
    calls.push(request);
    const out = answer();
    if (out instanceof Error) throw out;
    return { status: out.status, body: out.body ?? "{}", headers: {} };
  };
  return { transport, calls };
}

async function invite(sql: Sql, provider: ReturnType<typeof realEmailProvider>): Promise<InviteOutcome> {
  return createInvitation(sql, {
    id: "inv-7",
    organizationId: "org",
    email: "a@example.test",
    role: "member",
    createdBy: "owner",
    workspaceName: "Soap",
    origin: "https://app.example.test",
    provider,
  });
}

describe("invitation delivery", () => {
  test("a 2xx marks the invite sent and returns no link", async () => {
    const { sql, row, history } = stubSql();
    const { transport, calls } = transportAnswering(() => ({ status: 200, body: JSON.stringify({ id: "m1" }) }));
    const outcome = await invite(sql, realEmailProvider(ENV, transport));
    assert.equal(outcome.status, "sent");
    assert.equal(outcome.link, null);
    assert.deepEqual(history, ["sending", "sent"]);
    assert.equal(row.send_count, 1);
    assert.equal(calls[0]?.headers["idempotency-key"], "inv-7:1");
  });

  test("a 4xx leaves the invite pending with the reason, and returns the link", async () => {
    const { sql, row, history } = stubSql();
    const { transport } = transportAnswering(() => ({ status: 400 }));
    const outcome = await invite(sql, realEmailProvider(ENV, transport));
    assert.equal(outcome.status, "pending");
    assert.match(outcome.link ?? "", /^https:\/\/app\.example\.test\/invite\?token=/);
    assert.deepEqual(history, ["sending", "pending"]);
    assert.match(row.last_error, /400/);
  });

  test("a timeout marks the invite uncertain, says the email may have arrived, returns the link, and sent the idempotency key", async () => {
    const { sql, row, history } = stubSql();
    const { transport, calls } = transportAnswering(() => new Error("Provider request timed out after 30 seconds."));
    const outcome = await invite(sql, realEmailProvider(ENV, transport));
    assert.equal(outcome.status, "uncertain");
    assert.match(outcome.message, /may or may not have arrived/);
    assert.match(outcome.link ?? "", /\/invite\?token=/);
    assert.deepEqual(history, ["sending", "uncertain"]);
    assert.equal(row.status, "uncertain");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.headers["idempotency-key"], "inv-7:1");
  });

  test("a 5xx is also uncertain", async () => {
    const { sql } = stubSql();
    const { transport } = transportAnswering(() => ({ status: 502 }));
    const outcome = await invite(sql, realEmailProvider(ENV, transport));
    assert.equal(outcome.status, "uncertain");
  });

  test("with email not configured the invite stays pending, the link is returned, and nothing is sent", async () => {
    const { sql, history } = stubSql();
    const { transport, calls } = transportAnswering(() => ({ status: 200 }));
    const outcome = await invite(sql, realEmailProvider({ url: "", key: "" }, transport));
    assert.equal(outcome.status, "pending");
    assert.match(outcome.message, /No email was sent/);
    assert.ok(outcome.link);
    assert.equal(calls.length, 0);
    assert.deepEqual(history, ["sending", "pending"]);
  });
});
