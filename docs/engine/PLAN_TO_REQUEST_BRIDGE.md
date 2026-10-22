# Plan to request bridge: design proposal (M4.4)

Status: proposed, 2026-10-22. Nothing here is built. It needs the owner's choice of option (section 5) before any code. The task it
answers is M4.4 in [CONTENT_FACTORY_PLAN.md](../CONTENT_FACTORY_PLAN.md).

## 1. The problem

The orchestrator (`src/engine/orchestrator/`) runs a plan: a graph of steps. Its kinds are `reference`, `analysis`, `script`, `visual`,
`video`, `voice`, `avatar`, `edit`, `compose` and `render` (`contracts.ts`). Its handlers for the first seven are connected
(`production.ts`). `edit`, `compose` and `render` report `not_connected`, because the engine's edit and render stages need inputs a plan
step does not carry.

The engine's own pipeline (`src/engine/jobs/`) makes a video in one request: intake, analysis, script, voice, plan, produce, check,
edit, compose, gate, render, review, variants, deliver. The brief page starts that pipeline. Two paths would make the same video, so
the bridge has to pick one.

## 2. What the engine's edit and compose stages need, and what a plan run has

| Engine input | Source in the engine | What a plan run has today | Gap |
| --- | --- | --- | --- |
| The plan (`CreativePlan`) and creative DNA | The request's planning stages | A plan graph, not a CreativePlan | Mapping, or a writer that produces one from the graph |
| Voice track with **word timings** (`contracts/voice.ts`) | Voice stage: speech, then alignment of the script's words with what speech-to-text heard (`voice/align.ts`, 3% word error rule), then beat spans (`voice/timings.ts`) | A voice step's stored output is an audio uri. No timings | Speech-to-text and alignment are not run on a plan's voice step |
| Takes, each with a **check verdict** (`check-take.ts`, `take_verdict` artifact) | Produce stage, then check stage | A visual or video step's stored output is a uri and a cache key. No verdict | Checking is not run on a plan's visual or video output |
| Style kit | The request's validated kit (`compose.ts`, `loadStyleKit`) | A plan has no kit | A kit has to be named by the plan or the brand |
| Written script (brief requests, contract v8) | The write-script stage | A script step's stored output is text | Probably fine, but the shape needs checking |

So a plan run's outputs cannot go into edit as they are. Each one needs an extra stage the plan does not run.

## 3. Options

**Option 1. The engine accepts a plan run's outputs.** The engine gets a new entry point: a request whose takes and voice track come from
a plan run, not from its own produce and voice stages. The plan's voice output goes through speech-to-text and alignment. Each take goes
through the check stage. Then the engine runs edit, compose, the gate, render, review and deliver, as it does today.

- For: one pipeline and one decision path. No output is paid for twice. Each step's cost lands in the ledger.
- Against: it changes an engine contract. The new input type needs a version bump, a note in Bible section 4, and the lead's approval
  (CLAUDE.md, "Contracts are law"). Speech-to-text and the check stage add cost per run.

**Option 2. The orchestrator writes its own EDL and calls the engine's compose and render.** The orchestrator would turn the plan into an
EDL and pass that to the engine's compose and render stages.

- For: it avoids a new engine entry point.
- Against: it copies the engine's edit stage into the orchestrator. CLAUDE.md asks for one decision path, and copying the cut rules would
  make two. It also still needs the voice timings and the verdicts, so it does not avoid the gaps in section 2.

**Option 3. The plan stays a planner, and production runs through the brief request.** The plan's visual and video steps become a preview,
and "make the video" starts an engine request.

- For: nothing new to build.
- Against: a visual or video shot is paid for twice, once in the plan and once in the request. Or the plan's shots are dropped, and the
  plan no longer makes anything. Neither matches what the plan is for.

## 4. Recommendation

Option 1, in four steps. Each step has its own fixture test and its own live run, which the owner records.

1. **Voice alignment for a plan's voice step.** Run speech-to-text on the audio and align it with the script's words, as the engine's voice
   stage does. This also gives the orchestrator's voice step real word timings. Cost: the speech-to-text bill (Deepgram; the price is
   unverified in ROADMAP), recorded in the ledger.
2. **Verdicts for a plan's takes.** Run the engine's check stage on each visual and video output. Store the verdict as a `take_verdict`.
3. **The engine entry point.** A request input for pre-made takes and a voice track, with its contract change: version bump, Bible section 4
   note, lead approval. The request skips its own produce and voice stages for those inputs.
4. **Connect the edit, compose and render steps.** They call the engine entry point with the plan run's outputs and the kit the brand
   names. Each one is recorded as a step, with its cost.

The kit (section 2) is an open question: the plan could name it, or the brand's default page kit could be used. That is a small decision for the
owner, and it can wait until step 4.

## 5. Decisions needed

- **D16. Which option.** Recommended: Option 1.
- **D17. The contract change.** Option 1 changes an engine contract. The owner has to approve the change, and eng-contracts has to make it
  (CLAUDE.md, "Contracts are law"). Approve the change before step 3.
- **D18. The style kit for a plan run.** Named by the plan, or the brand's default page kit. Needed at step 4.
- **Cost.** Speech-to-text and the check stage add a cost per run. Its price needs the owner's confirmation before step 1 runs live.

## 6. What is not in this proposal

- Changing the orchestrator's cache, its budget, or its planner (planner prompt v2 is the owner's decision, D9).
- Remake and splice (M4.2, M4.3). Those depend on the window renderer (D5), not on this bridge.
- Any live call. Steps 1 to 4 each need a live run from the owner.
