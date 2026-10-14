import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { routes, type RouteTable } from "../config/routes.ts";
import { gatewayFor, scripted } from "../assets/test/recorded.ts";
import { routesWith } from "../assets/test/recorded.ts";
import { NOT_CONNECTED, speechToTextConnection } from "./stt-connection.ts";
import { recordedSpeechToText, type RecordedSttFixture } from "./stt.ts";

const fixture: RecordedSttFixture = {
  provider: "test-stt",
  model: "test-model",
  source: "synthetic",
  recordedAt: "2026-10-14T10:00:00.000Z",
  responses: [],
};

describe("speech-to-text connection (Bible 20.2: the vendor is an owner decision)", () => {
  it("is not connected while the stt route has no vendor, and says so with NOT_CONNECTED, sending nothing", () => {
    const script = scripted({});
    const connection = speechToTextConnection(gatewayFor(script.transport));
    assert.equal(connection.status, "not_connected");
    if (connection.status !== "not_connected") return;
    assert.match(connection.reason, new RegExp(`^${NOT_CONNECTED}:`));
    assert.match(connection.reason, /Bible 20\.2/);
    assert.equal(script.requests.length, 0);
  });

  it("is not connected when a route names a model but no adapter is wired for it", () => {
    const table: RouteTable = routesWith(
      "stt",
      [{ provider: "openrouter", model: "test/stt", priceKey: null, verified: false }],
      routes.table,
    );
    const connection = speechToTextConnection(
      gatewayFor(scripted({}).transport, { routes: table }),
    );
    assert.equal(connection.status, "not_connected");
    if (connection.status !== "not_connected") return;
    assert.match(connection.reason, /no speech-to-text adapter is wired/);
  });

  it("is ready when a wired adapter is supplied for the routed target", () => {
    const table: RouteTable = routesWith(
      "stt",
      [{ provider: "openrouter", model: "test/stt", priceKey: null, verified: false }],
      routes.table,
    );
    const stt = recordedSpeechToText(fixture);
    const connection = speechToTextConnection(
      gatewayFor(scripted({}).transport, { routes: table }),
      { resolve: () => stt },
    );
    assert.equal(connection.status, "ready");
    if (connection.status === "ready") assert.equal(connection.stt, stt);
  });
});
