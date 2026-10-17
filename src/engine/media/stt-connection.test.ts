import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { routes, type RouteTable } from "../config/routes.ts";
import { gatewayFor, scripted } from "../assets/test/recorded.ts";
import { routesWith } from "../assets/test/recorded.ts";
import { NOT_CONNECTED, speechPortsOf, speechToTextConnection } from "./stt-connection.ts";
import { recordedSpeechToText, type RecordedSttFixture } from "./stt.ts";

const fixture: RecordedSttFixture = {
  provider: "test-stt",
  model: "test-model",
  source: "synthetic",
  recordedAt: "2026-10-14T10:00:00.000Z",
  responses: [],
};

describe("speech-to-text connection (Bible 20.2: the vendor is Deepgram, owner decision 2026-10-16)", () => {
  it("is not connected while no adapter is resolved for the stt route, and says so with NOT_CONNECTED, sending nothing", () => {
    // The stt route names deepgram:nova-3 and the gateway lists deepgram. No resolver is passed, so nothing is ready.
    const script = scripted({});
    const connection = speechToTextConnection(gatewayFor(script.transport));
    assert.equal(connection.status, "not_connected");
    if (connection.status !== "not_connected") return;
    assert.match(connection.reason, new RegExp(`^${NOT_CONNECTED}:`));
    assert.match(connection.reason, /deepgram:nova-3/);
    assert.equal(script.requests.length, 0);
  });

  it("is ready with the resolver's adapter for the stt route, and the speech ports carry the route's list price", () => {
    const stt = recordedSpeechToText(fixture);
    const script = scripted({});
    const gateway = gatewayFor(script.transport);
    const connection = speechToTextConnection(gateway, { resolve: (route) => (route.provider.id === "deepgram" ? stt : null) });
    assert.equal(connection.status, "ready");
    if (connection.status === "ready") assert.equal(connection.stt, stt);
    const ports = speechPortsOf(gateway, { resolve: () => stt });
    assert.equal(ports.connection.status, "ready");
    assert.equal(ports.sttPricePerMinuteUsd, 0.0043, "the list price of the stt route (config/prices.ts)");
    assert.equal(script.requests.length, 0, "connecting sends nothing");
  });

  it("the speech ports are not connected, and carry no price, for a route the gateway cannot resolve", () => {
    const table: RouteTable = routesWith("stt", [], routes.table);
    const ports = speechPortsOf(gatewayFor(scripted({}).transport, { routes: table }));
    assert.equal(ports.connection.status, "not_connected");
    assert.equal(ports.sttPricePerMinuteUsd, null, "no route, no price: a call is refused, never estimated as zero");
  });

  it("is not connected when a route names a model but no adapter is resolved for it", () => {
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
    assert.match(connection.reason, /no speech-to-text adapter is resolved/);
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
