# Engine contracts (W1)

Implements Video Engine Bible **section 4** (data contracts 4.1 to 4.4, including the "v1 additions"), **section 13**
(consistency kits), the **section 10.1** adapter types, and the artifact envelope of **section 5.2**.

These zod schemas are the only interface between engine workstreams. Only eng-contracts changes them. A change needs a
version bump, a note in Bible section 4 and the lead's approval.

## Files

- `request.ts`, `analysis.ts`, `voice.ts`, `plan.ts`, `take.ts`, `edl.ts`, `gate.ts`, `render.ts`, `manifest.ts`,
  `ledger.ts`, `kits.ts`, `assets.ts`: one file per area of section 4, with exact field names.
- `envelope.ts`: `envelopeSchema(body)` and the `ArtifactEnvelope` type.
- `ids.ts`: prefixed ULIDs (`newId`, `idSchema`, `encodeUlid`).
- `hash.ts`: `canonicalJson` and `contentHash` (sha256, `sha256:<hex>`).
- `money.ts`: `usdSchema` (finite, >= 0, at most 4 decimals), `roundUsd`, `sumUsd`.
- `primitives.ts`: time helpers (integer ms), span checks, and the check-result rule.
- `errors.ts`: `EngineError` with `kind`, `retryable` and `stage`.
- `fixtures/`: one consistent chain (request, DNA, voice, plan, takes, EDL, composition, render, review, manifest,
  reservation, ledger) and one valid fixture per kit. Import from `fixtures/index.ts`.

## Rules the schemas enforce (v1)

- Each top-level artifact carries its `schema` literal. Literal fields stay literal: `fps 30`, `width 1080`,
  `height 1920`, `masterLufs -14`, `aspect '9:16'`.
- `ShotSpec.source` is a discriminated union on `kind`.
- Time fields are non-negative integer ms. Spans run forward (`endMs > startMs`).
- Id prefixes are checked where the Bible names one. Other ids (plan, voice track, segment, word, beat, clip, kit ids)
  are non-empty strings.
- A gate or take verdict passes only with at least one check and every check passing.
- A passing review has no failures. A paused reservation names its reason.
- A composition's `contentHash` is the hash of its files, and its `rootFile` is one of them.
- A manifest's `cost.total` is the sum of its four parts.
- A manifest's role calls (v2, optional `roleCalls`) name a Bible 11.1 role. Each call's prompt version is the one `promptVersions`
  records for its role. An unknown cost, and an invalid answer, are held as the estimate (`actualIsEstimate: true`).

## Contract v3 (`CONTRACTS_VERSION`, see Bible section 4 "v3 changes and migration")

- `Manifest` is `meridian.manifest/v2`. It takes an optional `roleCalls` array of `ManifestRoleCall` (exported from `manifest.ts`):
  the Claude role calls of the video, from the role-call journal. Without it a v2 manifest is valid.

## Contract v2 (`CONTRACTS_VERSION`, see Bible section 4 "v2 changes and migration")

- `LedgerEntry` takes optional `role` (one of the ten Claude roles of Bible 11.1, `CLAUDE_ROLES`) and `promptVersion`
  (`<role>@<n>`). They are set together, and the prompt version must be a version of the role. Rows from v1 have neither.
- `VoiceKit` takes optional `wordsPerMinute` (positive, finite), used at intake when no persona loads.
- Both are additive. Types with a `schema` literal keep their `/v1` literals.

## Using it

```ts
import { scenePlanSchema, type ScenePlan, newId, contentHash } from "../contracts/index.ts";
```

Tests live next to the code (`*.test.ts`, `node:test`). `invalid.test.ts` shows each rejection case.
