# STATUS: storage (engine shot ports, production)

**Videos without a brand, and files without Drive (owner direction 2026-11-09, migration 0158).** A video does not have to belong to a
brand, and making one does not need Google Drive.

- `meridian-store.ts`: the one store the engine (`engineObjectStore`), Create (`content-factory/files.ts`, `meridianFileStore`) and the
  chat connector (`mcp/files.ts`, `meridianMcpFileStore`) use. A new file goes to Drive when the workspace has Drive set up, else to
  Meridian's database. A Drive that is set up but failing is still Drive: its error is reported, and the file is not moved elsewhere.
  A file is read from where its record says it is (`storage_objects.provider`).
- `database-store.ts`: the bytes in `storage_blobs`, the record in `storage_objects` with provider `database`. At most 50 MB a file;
  larger is refused before anything is written, with a reason that says to connect Drive. Immutable: the same bytes again are a retry,
  different bytes under a taken name are refused.
- brandId null is the workspace's own space. `storage_objects.brand_id` and `artifact_upload_sessions.brand_id` may be null, and null
  counts as one value in their keys (NULLS NOT DISTINCT). In Drive, a workspace file sits under `tenants/<org>/workspace/`, next to
  `brands/`, and its brandId property is `workspace`.
- The engine's shot connection no longer requires Drive (`engine/jobs/production-ports.ts`).
- Tests: `meridian-store.db.test.ts` (11, PGlite). Not verified live: a database-kept render served through the media link route on the
  hosting (a response of several MB), and a Drive upload into the workspace folder.

**Engine reference store (this branch, `engine-reference-store.ts`).** The engine's reference video, uploaded to Meridian's store as
store://<key>, is read under its request's brand and released when the analysis ends: the Drive file the index names is deleted, then the
storage_objects row. The object store is a parameter (a test passes a fake), and production passes the Drive store (`engineObjectStore`).
Tests: `engine-reference-store.test.ts` (3, PGlite). Not verified live: the Drive delete and the upload's key format (`../../../engine/jobs/STATUS.md`).
No other storage file changed.

Added for the production shot ports (src/engine/jobs/runtime.ts, production-ports.ts). The engine reaches these only through its
composition root, never by importing them into a stage.

## engine-asset-media.ts (new)

- `engineAssetMediaFor({ objects, brandOf }, { organizationId, requestId })`: the asset router's image store, bound to one request.
  It satisfies the engine's MediaStore shape structurally (src/engine/assets/adapter.ts), so the engine never imports this file.
- Keys: `engine/{organizationId}/{requestId}/assets/{sha256 hex}.{png|mp4|wav|mp3}`, the engine's key rule. `isEngineMediaKey`
  (engine-media-link.ts) accepts them, so the signer links them for the organization only, and the route reads the brand from the request.
- Round 2 (lead decision, 2026-10-17): the speech output, `audio/mpeg`, is stored as `mp3` (EXTENSION_BY_MEDIA_TYPE). The link route's key
  pattern and its MIME map (`mp3` to `audio/mpeg`) carry it too. A key whose stored type is not its extension's type is not served (a test).
  Not verified live: the Drive upload and the signed link of an mp3 object.
- Refused before the object store is touched: a write for another workspace, a content hash that does not match the bytes, an empty file,
  a media type other than image/png, video/mp4, audio/wav or audio/mpeg (for example image/gif), a request with no brand (the `brandOf`
  lookup throws), and a read of a key outside the workspace.
- No S3 and no vendor SDK. The bytes go to the object store passed in (Meridian's Drive-backed `engineObjectStore` in production).

## engine-media-functions.ts (new)

- `engineMediaFunctionsBaseUrl(env)`: reads `MEDIA_FUNCTIONS_BASE_URL`. It returns the https origin (a path is kept, a trailing slash is
  removed), or null when the setting is unset or is not https, or carries a query, a fragment or credentials. Null leaves the media
  functions NOT_CONNECTED.
- The setting is new. It is not in `.env.example`; the owner or the lead adds it with the other deployment settings.

## Owner must do before a live run

- Restrict the media functions' host to Meridian. The functions carry no credential (scripts/engine/STATUS.md, finding 3), so setting the
  base URL alone does not protect them.
