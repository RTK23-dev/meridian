# STATUS: the script resolver (contract v8), `src/engine/script/`

Implements Video Engine Bible section 4 (v8 note: a request's script, or the written script of a brief) and section 6 (write_script). Built on
branch worktree-agent-a16624873a0973b89; not merged (the lead merges).

- `resolve.ts`: `scriptOf(request, written)` is the one way a consumer reads the words a video speaks. A script request returns its own
  script (a written script given with it is an internal error). A brief returns its written script, and a brief with none yet is an internal
  error, never an empty or guessed script. `writtenScriptOf(inputs, requestId)` finds the written_script among a job's inputs (a foreign or
  non-parsing one is refused). `isBriefRequest` names the case.
- Consumers: `jobs/handlers/{edit,plan,pre-render-gate,variants,voice,write-script}.ts`, `plan/build.ts`, `review/gates/preRender.ts`,
  `variants/{expand,work,writer,speak}.ts`, `voice/voice.ts`.
- Tests: `resolve.test.ts` (10).
- Open: none in this module. The brief's own language is the writer's choice (contract v8, open point 3), and the reference's speech
  language is not in this module (`../jobs/STATUS.md`, decision 1).
