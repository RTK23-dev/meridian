import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError } from "../../contracts/errors.ts";
import { assetSpec, gatewayFor, routesWith, scripted } from "../test/recorded.ts";
import { routes } from "../../config/routes.ts";
import { AVATAR_NOT_CONNECTED, avatarIvAdapter } from "./avatarIv.ts";

describe("avatar (HeyGen Avatar IV via OpenRouter)", () => {
  it("reports NOT_CONNECTED with the reason and sends nothing", async () => {
    const script = scripted({});
    const table = routesWith("avatar", [{ provider: "openrouter", model: "heygen/avatar-iv", priceKey: "heygen_avatar_iv", verified: false }], routes.table);
    const gateway = gatewayFor(script.transport, { routes: table });
    const route = gateway.routes("avatar")[0];
    if (!route) throw new Error("no avatar route");
    const adapter = avatarIvAdapter(route);

    const connection = await adapter.connection(null);
    assert.equal(connection.connected, false);
    assert.match(connection.connected ? "" : connection.reason, /NOT_CONNECTED/);
    await assert.rejects(adapter.submit(assetSpec({ modelClass: "avatar" }), "k"), (error: unknown) => {
      assert.ok(error instanceof EngineError);
      assert.equal(error.message, AVATAR_NOT_CONNECTED);
      return true;
    });
    const poll = await adapter.poll("x");
    assert.equal(poll.state, "failed");
    assert.equal(poll.error?.message, AVATAR_NOT_CONNECTED);
    assert.equal(script.requests.length, 0);
  });

  it("prices per second from the table, even though it is not connected", () => {
    const gateway = gatewayFor(scripted({}).transport, {
      routes: routesWith("avatar", [{ provider: "openrouter", model: "heygen/avatar-iv", priceKey: "heygen_avatar_iv", verified: false }], routes.table),
    });
    const route = gateway.routes("avatar")[0];
    if (!route) throw new Error("no avatar route");
    assert.equal(avatarIvAdapter(route).price(assetSpec({ modelClass: "avatar", durationMs: 4000 })).estimateUsd, 0.2);
  });
});
