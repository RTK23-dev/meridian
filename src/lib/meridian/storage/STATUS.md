# STATUS: storage (engine shot ports, production)

Added for the production shot ports (src/engine/jobs/runtime.ts, production-ports.ts). The engine reaches these only through its
composition root, never by importing them into a stage.

## engine-asset-media.ts (new)

- `engineAssetMediaFor({ objects, brandOf }, { organizationId, requestId })`: the asset router's image store, bound to one request.
  It satisfies the engine's MediaStore shape structurally (src/engine/assets/adapter.ts), so the engine never imports this file.
- Keys: `engine/{organizationId}/{requestId}/assets/{sha256 hex}.{png|mp4|wav}`, the engine's key rule. `isEngineMediaKey` (engine-media-link.ts)
  accepts them, so the signer links them for the organization only, and the route reads the brand from the request.
- Refused before the object store is touched: a write for another workspace, a content hash that does not match the bytes, an empty file,
  a media type other than image/png, video/mp4 or audio/wav (speech's audio/mpeg has no engine extension), a request with no brand (the
  `brandOf` lookup throws), and a read of a key outside the workspace.
- No S3 and no vendor SDK. The bytes go to the object store passed in (Meridian's Drive-backed `engineObjectStore` in production).

## engine-media-functions.ts (new)

- `engineMediaFunctionsBaseUrl(env)`: reads `MEDIA_FUNCTIONS_BASE_URL`. It returns the https origin (a path is kept, a trailing slash is
  removed), or null when the setting is unset or is not https, or carries a query, a fragment or credentials. Null leaves the media
  functions NOT_CONNECTED.
- The setting is new. It is not in `.env.example`; the owner or the lead adds it with the other deployment settings.

## Owner must do before a live run

- Restrict the media functions' host to Meridian. The functions carry no credential (scripts/engine/STATUS.md, finding 3), so setting the
  base URL alone does not protect them.
