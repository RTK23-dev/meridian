# API gateway

The engine's one way to the network (owner decision 2026-10-14, `docs/engine/PHASE_LOG.md`). Every model, media and render
call goes through it. It owns four things, and nothing else in `src/engine/` does:

1. **Where a call goes.** `gateway.route(capability)` reads `src/engine/config/routes.ts`. OpenRouter is the default for
   every model API (Claude roles, video, avatar, image, speech). To change a model or a provider, edit that table.
2. **Which credential it carries.** A `CredentialSource` supplies keys. In Meridian it is `meridianCredentialSource()`
   (`meridian.ts`), which asks Meridian's credential resolver at the moment of each call.
3. **How it is authenticated.** Each provider in `providers.ts` declares `api_key` (header and scheme), `oauth` (bearer
   token, refreshed once on a 401 through `CredentialSource.refresh`) or `none`. Keys are attached only to requests for
   the provider's own host, so a key never follows a URL a provider sent back.
4. **The network.** `transport.ts` holds the only `fetch` in the engine. `boundaries.test.ts` fails the build if another
   production file calls `fetch`, reads Meridian's credentials, or names a model platform's host.

## Using it

```ts
const gateway = createGateway({ transport: fetchHttpTransport, credentials: meridianCredentialSource() });

// Claude roles: structured output, validated with zod.
const { value, usage } = await structuredChat(gateway, { organizationId, capability: "llm.check", messages, schema, schemaName, maxTokens });

// Paid calls go through the ledger: authorize, call, reconcile with OpenRouter's usage.cost.
await paidCall({ ledger, reservationId, stage, route: gateway.route("llm.check"), estimateUsd, idempotencyKey, at }, async () => {
  const result = await structuredChat(gateway, input);
  return { value: result.value, actualUsd: result.usage.costUsd };
});

// Adapters that build their own URLs get an authenticated transport.
new HyperframesCloudAdapter({ transport: gateway.transportFor("heygen", orgId), credential: gateway.secretFor("heygen", orgId) });
httpMediaFunctions(gateway.baseUrlFor("media_functions"), textTransport(gateway.transportFor("media_functions", orgId)));
```

## Switching

- **Another model:** change `model` in the capability's route.
- **Another provider:** add it to `providers.ts` (base URL, auth, credential id), point the route at it, and add its
  client next to `openrouter.ts` if its API differs.
- **OAuth instead of a key:** set the provider's `auth` to `{ kind: "oauth", header: "Authorization" }` and give the
  credential source a `refresh`. Callers do not change.
