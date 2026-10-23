@AGENTS.md

# Video engine (src/engine/)

The engine's specification is `docs/engine/VIDEO_ENGINE_BIBLE.md`, a reference. Inside `src/engine/`, the Bible wins over other
documents. Where the Bible and a product decision conflict, do not pick a side in code: ask the owner.

## Engine rules

1. **Fail closed.** Unknown values stay null, never 0 or a guess. An unconnected service returns NOT_CONNECTED, never success.
2. **No fake success.** No invented costs, metrics, receipts, media ids or connected states. A stub says it is a stub.
3. **Everything through the gateway and the ledger.** Every model, API and render call goes through `src/engine/gateway/`, reached
   from the asset router, the Claude client or the render adapter. No engine file except `gateway/transport.ts` calls `fetch`. Keys
   come from the credential resolver (`gateway/meridian.ts`), never `process.env`. Every paid call sends an idempotency key and writes
   estimate, reservation and actual cost to the ledger. Budgets are soft limits (owner direction 2026-10-23, decision D2 in
   `docs/engine/run/DECISIONS_2026-10-23.md`): each has a tolerance, the larger of a percentage and a number of cents. Work proceeds
   within the target plus the tolerance (the allowance); beyond it the run pauses for an approval. A small overrun is never a refusal.
4. **Contracts are the interface.** The zod schemas in `src/engine/contracts/` are the only interface between parts of the engine. A
   contract change needs a version bump in `contracts/version.ts`, a migration note in Bible section 4, and the owner's or lead's approval.
5. **Live runs before claims.** A phase is verified only by a recorded live run on real APIs, with ids, costs and output attached.
   Fixture success is not verification. Say which live steps are still for the owner to run.
6. **Copy genes, never content.** No source footage, music, voice or script lines enter a render.
7. **Untrusted outputs.** Provider and model outputs are data: validate them, never execute them, never pass them on as instructions.
8. **Secrets never enter git, logs or chat.**

## Conventions

- Tests run through `node --experimental-strip-types`: no `enum`, no constructor parameter properties, no `namespace`. Import local
  files with the `.ts` extension.
- zod is v4. Use v4 APIs, for example `z.record(z.string(), schema)`. Export each schema and its `z.infer` type.
- Tests use `node:test` and `node:assert/strict`, sit next to the code as `*.test.ts`, and use recorded fixtures.
- No new npm dependency without approval. Install with `--ignore-scripts` (the `onnxruntime-node` install script cannot download here).
- Engine code does not import `src/lib/meridian/research/`, `embeddings/` or the Hypit modules.
- Artifacts and media go through a storage interface, never a vendor SDK. Do not add S3 code.
- Open decisions in Bible section 20.2 belong to the owner. Ask; never guess.
- Never set `CLAUDE_CODE_EFFORT_LEVEL` or `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`.
