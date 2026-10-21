import assert from "node:assert/strict";
import test from "node:test";
import { CONNECT_ROUTE, connectionState, type ConnectionLabel, type ConnectionRow, type ConnectionTone } from "./connection-state.ts";

const SUCCESS_AT = "2026-03-01T10:00:00.000Z";
const TEST = { label: "Test connection", to: null };
const NO_STATE = "No connection state was reported for this provider.";
const NO_REASON = "No reason was recorded.";

function row(overrides: ConnectionRow): ConnectionRow {
  return { provider: "meta", detail: "", lastError: "", lastSuccessAt: null, ...overrides };
}

const LABEL_TONE: Record<ConnectionLabel, ConnectionTone> = {
  Connected: "success",
  "NOT CONNECTED": "neutral",
  Error: "danger",
  Checking: "info",
};

const ALL_STATUSES = [
  "NOT_CONFIGURED", "CONNECTING", "CONNECTED", "SYNCING", "HEALTHY", "DEGRADED", "FAILED", "DISCONNECTED",
  "NOT_CONNECTED", "not connected", "not-connected", "disconnected", "healthy", "connected", "failed", "error",
  "FAILURE", "UNHEALTHY", "SUPPORTED", "AVAILABLE", "CONFIGURED", "SOMETHING_NEW", "",
];

test("every server phase maps to the label and tone the row shows", () => {
  const cases: Array<[string, ConnectionLabel, ConnectionTone]> = [
    ["NOT_CONFIGURED", "NOT CONNECTED", "neutral"],
    ["CONNECTING", "Checking", "info"],
    ["CONNECTED", "Connected", "success"],
    ["SYNCING", "Checking", "info"],
    ["HEALTHY", "Connected", "success"],
    ["DEGRADED", "NOT CONNECTED", "neutral"],
    ["FAILED", "Error", "danger"],
    ["DISCONNECTED", "NOT CONNECTED", "neutral"],
  ];
  for (const [status, label, tone] of cases) {
    const state = connectionState(row({ status, detail: "Server sentence.", lastError: "Last error.", lastSuccessAt: SUCCESS_AT }));
    assert.equal(state.label, label, status);
    assert.equal(state.tone, tone, status);
  }
});

test("the other status words the app uses read the same way, whatever their case or separators", () => {
  const withEvidence = { detail: "", lastError: "", lastSuccessAt: SUCCESS_AT };
  assert.equal(connectionState(row({ ...withEvidence, status: "healthy" })).label, "Connected");
  assert.equal(connectionState(row({ ...withEvidence, status: "connected" })).label, "Connected");
  assert.equal(connectionState(row({ status: "NOT_CONNECTED" })).label, "NOT CONNECTED");
  assert.equal(connectionState(row({ status: "not connected" })).label, "NOT CONNECTED");
  assert.equal(connectionState(row({ status: "not-connected" })).label, "NOT CONNECTED");
  assert.equal(connectionState(row({ status: "disconnected" })).label, "NOT CONNECTED");
  assert.equal(connectionState(row({ status: "SUPPORTED" })).label, "NOT CONNECTED");
  for (const status of ["failed", "failure", "error", "unhealthy", "ERROR"]) {
    assert.equal(connectionState(row({ status, lastError: "Reason." })).label, "Error", status);
  }
});

test("Connected needs positive evidence: a HEALTHY or CONNECTED status and a readable success time", () => {
  for (const status of ["HEALTHY", "CONNECTED"]) {
    const state = connectionState(row({ status, lastSuccessAt: SUCCESS_AT }));
    assert.deepEqual(state, { label: "Connected", tone: "success", reason: null, action: TEST }, status);
  }
});

test("a healthy status without a recorded success time is not Connected", () => {
  for (const status of ["HEALTHY", "CONNECTED"]) {
    const state = connectionState(row({ status, detail: "The last provider request succeeded.", lastSuccessAt: null }));
    assert.equal(state.label, "NOT CONNECTED", status);
    assert.equal(state.reason, "No successful request is recorded yet.", "the success line is not repeated from the server");
    assert.deepEqual(state.action, TEST);
  }
});

test("a success time that cannot be read is not evidence, and the reason says so", () => {
  const state = connectionState(row({ status: "HEALTHY", lastSuccessAt: "not a time" }));
  assert.equal(state.label, "NOT CONNECTED");
  assert.equal(state.reason, "Last successful request: time not readable.");
});

test("no status other than HEALTHY or CONNECTED is Connected, even with a recorded success time", () => {
  for (const status of ALL_STATUSES.filter((value) => !["HEALTHY", "CONNECTED", "healthy", "connected"].includes(value))) {
    assert.notEqual(connectionState(row({ status, lastSuccessAt: SUCCESS_AT })).label, "Connected", `status "${status}"`);
  }
});

test("Error always carries the recorded error", () => {
  const state = connectionState(row({ status: "FAILED", detail: "A sentence from the server.", lastError: "The token was revoked." }));
  assert.deepEqual(state, { label: "Error", tone: "danger", reason: "The token was revoked.", action: TEST });
});

test("Error falls back to the server's detail when no error text was stored", () => {
  const state = connectionState(row({ status: "FAILED", detail: "The sealed token could not be opened.", lastError: "" }));
  assert.equal(state.reason, "The sealed token could not be opened.");
});

test("Error says no reason was recorded when the input holds none, including blank text", () => {
  assert.equal(connectionState(row({ status: "FAILED", detail: "", lastError: "" })).reason, NO_REASON);
  assert.equal(connectionState(row({ status: "FAILED", detail: "   ", lastError: "   " })).reason, NO_REASON);
  assert.equal(connectionState({ status: "ERROR" }).reason, NO_REASON);
  for (const status of ["FAILED", "FAILURE", "ERROR", "UNHEALTHY"]) {
    assert.equal(connectionState({ status }).reason, NO_REASON, status);
  }
});

test("missing data is shown as not connected, never as a success", () => {
  for (const input of [undefined, null, {}, { status: "" }, { status: "   " }, { status: null, lastSuccessAt: SUCCESS_AT }]) {
    const state = connectionState(input as ConnectionRow | null | undefined);
    assert.deepEqual(state, { label: "NOT CONNECTED", tone: "neutral", reason: NO_STATE, action: TEST }, JSON.stringify(input));
  }
});

test("an unknown status keeps the server's sentence as the reason, or says no state was reported", () => {
  assert.equal(connectionState(row({ status: "SOMETHING_NEW", detail: "Server sentence." })).reason, "Server sentence.");
  assert.equal(connectionState(row({ status: "SOMETHING_NEW", detail: "" })).reason, NO_STATE);
});

test("a not-connected row keeps the server's sentence, and names the default when there is none", () => {
  assert.equal(connectionState(row({ status: "NOT_CONFIGURED", detail: "Server sentence." })).reason, "Server sentence.");
  assert.equal(connectionState(row({ status: "NOT_CONFIGURED", detail: "" })).reason, "No credentials are configured. No request was sent.");
  assert.equal(connectionState(row({ status: "NOT_CONNECTED", detail: "" })).reason, "Not connected. Connect it in Settings or Integrations.");
  assert.equal(connectionState(row({ status: "DISCONNECTED", detail: "" })).reason, "Disconnected in Meridian. No further requests are sent until someone reconnects.");
  assert.equal(connectionState(row({ status: "DEGRADED", detail: "" })).reason, "The last successful request is stale.");
  assert.equal(connectionState(row({ status: "SUPPORTED", detail: "" })).reason, "Credentials are present, but no successful request is recorded. This is not connected.");
});

test("a checking row says what is running, and has no reason when the server says nothing", () => {
  assert.deepEqual(connectionState(row({ status: "CONNECTING", detail: "A connection request is in progress." })), {
    label: "Checking", tone: "info", reason: "A connection request is in progress.", action: { label: "Refresh status", to: null },
  });
  assert.equal(connectionState(row({ status: "SYNCING", detail: "" })).reason, null);
});

test("Connected has no reason, and the row shows its action in place", () => {
  assert.deepEqual(connectionState(row({ status: "HEALTHY", detail: "The last provider request succeeded.", lastSuccessAt: SUCCESS_AT })), {
    label: "Connected", tone: "success", reason: null, action: TEST,
  });
});

test("a provider with an OAuth consent screen offers Connect when it is not connected", () => {
  for (const provider of ["meta", "tiktok", "google"]) {
    assert.deepEqual(connectionState(row({ provider, status: "NOT_CONFIGURED" })).action, { label: "Connect", to: CONNECT_ROUTE }, provider);
  }
  assert.equal(CONNECT_ROUTE, "/integrations");
});

test("a provider without a consent screen, or with no provider named, offers a test rather than Connect", () => {
  assert.deepEqual(connectionState(row({ provider: "ad_library", status: "NOT_CONFIGURED" })).action, TEST);
  assert.deepEqual(connectionState({ status: "NOT_CONFIGURED" }).action, TEST);
});

test("a disconnected row offers Reconnect in place, and a failed row offers a test", () => {
  assert.deepEqual(connectionState(row({ provider: "ad_library", status: "DISCONNECTED" })).action, { label: "Reconnect", to: null });
  assert.deepEqual(connectionState(row({ status: "FAILED", lastError: "Reason." })).action, TEST);
  assert.deepEqual(connectionState(row({ status: "DEGRADED" })).action, TEST);
});

test("every action label is a verb of at most three words", () => {
  for (const status of ALL_STATUSES) {
    for (const provider of ["meta", "ad_library", undefined]) {
      const { action } = connectionState({ provider, status, lastError: "Reason.", lastSuccessAt: SUCCESS_AT });
      assert.ok(action.label.split(" ").length <= 3, `${status} ${provider}: ${action.label}`);
    }
  }
});

test("every input gives a label, tone and reason that agree with each other", () => {
  for (const status of ALL_STATUSES) {
    for (const lastSuccessAt of [null, SUCCESS_AT, "not a time"]) {
      for (const lastError of ["", "Reason."]) {
        const state = connectionState({ provider: "google", status, detail: "Sentence.", lastError, lastSuccessAt });
        assert.equal(state.tone, LABEL_TONE[state.label], `${status} ${state.label}`);
        if (state.label === "Error") assert.notEqual(state.reason, null, status);
        if (state.label === "Connected") assert.equal(state.reason, null, status);
      }
    }
  }
});
