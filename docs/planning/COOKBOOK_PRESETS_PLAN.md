# Cookbook presets: coding plan

Status: plan, written 2026-10-31 at the owner's request. Nothing in it is built yet. The owner decisions it needs are in section 10 and
in `.claude/loop/OPEN_QUESTIONS.md` (Q31). The coding loop runs it as round 3 of `.claude/loop/RUN_PLAN.md` once they are answered.

## 1. The idea in one paragraph

A cookbook is a saved, versioned recipe for one kind of video. It holds everything Meridian needs to make that kind of video again: the
style (colours, fonts, captions, layout), the structure (beats, timing, cut rhythm), the steps (which production parts run, in which order),
the special instructions for each step (what the script writer, the planner, the editor and the critic must do differently), what the
recipe needs (a voice-over, music, a presenter or UGC footage, generated video, or nothing paid at all), and a set of options (toggles,
sliders, selects) that the cookbook itself defines. A person picks a cookbook, moves its options, sees at once what it needs and what it
costs, and runs it in the Content Factory. They can save their own settings and changes as a custom cookbook.

Example, the 3D data explainer made today:

| Part | Content |
| --- | --- |
| Needs | No presenter. Voice-over: optional. Music: optional. 3D scenes: coded (free) or generated (paid) |
| Runs as | Agent mode (a Claude Code session renders it locally, no provider spend) or engine mode (Meridian's pipeline, paid providers) |
| Options | Voice-over (none, AI voice, my recording); Music (none, library, generated); Pace (slider); Camera energy (slider); Data panels (on, off); Hook counter (on, off); Length (30, 45, 60 s); Caption highlight (box, colour) |
| Instructions | Script: "a surprising claim with a live count in the first 2 s; three cases, each with a place, a number and a move; end on the opening scene". Planner: "aerial and data-room shots only; cut only on a change of place, scale or set". Critic: "check the cut rhythm against the targets" |
| Checks | The measured grammar of the output against the cookbook's targets (the comparison `compare.ts` ran today) |

## 2. What exists today, and what each becomes

| Today | Where | Becomes |
| --- | --- | --- |
| Style presets (kit, look, layout, grammar, structure, shots, gaps) | `src/engine/presets/` | The style and grammar sections of a cookbook. The 3D data explainer is the first built-in cookbook |
| Factory pipeline presets (stages, four prompt texts, generation params, thresholds). The file says no job reads them | `src/lib/meridian/factory/pipeline-config*.ts`, table `factory_pipeline_configs` | Folded in: stages become cookbook steps, the prompt texts become step instructions. The table is migrated, then retired (D4) |
| Repurpose catalog: options with availability and one intensity; `packs` marked unavailable ("Packs will be Meridian-owned presets") | `src/engine/repurpose/catalog.ts` | Kept for repurposing. A cookbook can bind its options to catalog options. `packs` becomes "available: cookbooks" |
| Component variables (`data-composition-variables`: enum, number with min, max, step; string), with no shared type | `src/engine/compose/components/*/component.html` | One shared control schema (C1) used by components and cookbooks alike |
| Content hub start modes (brief, reference, studio) | `src/components/content-factory/content-hub-model.ts` | The start screen lists cookbooks; the three modes stay as the "blank" cookbooks |
| Orchestrator plan nodes (reference, analysis, script, visual, video, voice, avatar, edit, compose, render) with params and estimates | `src/engine/orchestrator/contracts.ts` | The step kinds of a cookbook. A resolved cookbook is a plan template for the orchestrator |
| Free or paid per visual type (`RECIPES`: generate, stock, component) and prices | `src/engine/plan/tables.ts`, `plan/cost.ts`, `config/prices.ts` | The source of a cookbook's cost class. Nothing is typed in by hand |
| UI controls: `Switch`, `Slider`, `SelectInput`, `RadioGroup`, `Checkbox` | `src/components/ui/controls.tsx` | Rendered from the control schema, so no cookbook needs its own screen code |
| `flow/nodes.ts`, `flow/connector.ts`: imported by tests only | `src/lib/meridian/flow/` | Deleted (Q21 already proposes it); the orchestrator is the one node graph |

No parallel pipeline (AGENTS.md): a cookbook only fills in what the existing Factory, orchestrator and engine already run.

## 3. The data model

All shapes are zod v4 schemas with exported `z.infer` types, in `src/lib/meridian/cookbooks/schema.ts`. They are product-side data, not
engine contracts: the engine sees a resolved cookbook only through fields it already has (phase A), or through one approved contract field
(phase B).

```
Cookbook = {
  schema: "meridian.cookbook/v1"
  cookbookId: string            // stable, never reused; "ck_" prefix
  version: int >= 1             // immutable: a change is a new version
  label, summary, family        // family: explainer | ugc | product | listicle | story | other
  scope: "builtin" | "workspace"
  parent?: { cookbookId, version }   // set when saved from another cookbook
  modes: Array<"agent" | "engine">   // which ways it can run (section 5)
  ingredients: Ingredient[]     // what it needs
  steps: Step[]                 // the recipe
  instructions: Instruction[]   // special instructions per role
  style: { styleKitId | styleKit, look?, layout? }         // from StylePreset
  grammar: { structure, targets, cutRule, unknown }        // from StylePreset; targets are the measured numbers
  controls: Control[]           // options, sliders, toggles: defined by this cookbook
  checks: Check[]               // what the output is measured against
}

Ingredient = { id, kind, need: "required" | "optional" | "none", ways: Way[] }
  kind: voice | music | presenter | ugc_footage | generated_video | generated_image | stock | product_kit | persona | reference
  Way = { id, label, modelClass? | visualType? | upload?: true | coded?: true }   // e.g. voice: tts | upload | none

Step = { id, kind: NodeKind, label, when?: Condition, uses: { component? | visualType? | modelClass? | role? }, params: Record<string, Value> }

Instruction = { role: "script" | "plan" | "visual" | "voice" | "edit" | "critic" | "agent", text: string (<= 4000 chars), when?: Condition }

Control =
  | { id, kind: "toggle", label, help?, default: boolean, binds: Binding[] }
  | { id, kind: "slider", label, help?, min, max, step, default, unit?, binds: Binding[] }
  | { id, kind: "select", label, help?, options: [{ value, label }], default, binds: Binding[] }
  | { id, kind: "text",   label, help?, maxLength, default, binds: Binding[] }
  | { id, kind: "colour", label, help?, roles: PaletteRole[], default, binds: Binding[] }   // picks from the style kit, never free CSS

Binding =
  | { set: Path }                                   // the control's value goes to a parameter
  | { set: Path, map: { linear: { in: [a, b], out: [c, d] } } }
  | { set: Path, map: { table: Record<string, Value> } }
  | { enable: StepId }                              // toggle: the step runs only when on
  | { choose: { ingredient: IngredientId } }        // select: the value names one of the ingredient's ways
  | { instruct: { role, text } }                    // adds an instruction when on, or for one select value

Condition = { control: ControlId, equals?: Value, in?: Value[], atLeast?: number, atMost?: number }
Check = { measure: "hardCuts" | "shotP50Ms" | "meanMotion" | "integratedLufs" | ..., target: number, tolerance: number }
```

Rules the validator enforces (`validateCookbook`, pure):

1. Every binding path exists in the cookbook's own parameter space (its steps' params, its grammar targets, its style), and the value type
   fits. A path outside the cookbook is refused.
2. Every slider range sits inside the engine's own bound for its target (for example the visual treatment bounds in `contracts/edl.ts`,
   the `thresholds` tunables). A cookbook cannot push a value the engine would refuse.
3. Control ids, step ids and ingredient ids are unique. A condition names a control that exists. There are no cycles.
4. No expressions and no code: bindings are data from the fixed list above, so a cookbook can never run anything.
5. Instruction text is bounded, stored as data, and passed to a model only inside a delimited "cookbook instructions" section. It cannot
   lift a gate: originality, claims, policy, rights and budget gates run after it, as they do now (AGENTS.md rules 3 and 8).
6. Unknown stays unknown: a way whose price is not in the catalog has cost `null`, shown as "price unknown", never 0.

## 4. Resolving a cookbook

`resolveCookbook(cookbook, values, context) -> ResolvedCookbook` in `src/lib/meridian/cookbooks/resolve.ts`. It is pure: the same inputs
give the same output, byte for byte, so a run can record exactly what made it.

1. Fill missing values with the defaults; refuse an unknown control id or a value outside the control (typed `invalid_input`).
2. Apply the bindings in control order: set parameters, enable or disable steps, choose ingredient ways, add instructions.
3. Work out the requirements: for each ingredient, the chosen way and its cost class:
   - `free`: coded components, the agent renderer, an upload the person supplies.
   - `paid`: a model class or a generated visual type (`RECIPES` "generate"), priced through `plan/cost.ts` and `config/prices.ts`.
   - `unknown`: no price in the catalog.
4. Estimate: the sum of the paid lines for the cookbook's length, with the unknown lines named. It is an estimate; the engine's own
   reservation at intake stays the binding budget check.
5. Output:
   - `requirements`: a list like "Voice-over: AI voice, about $0.04"; "Presenter: none"; "3D scenes: coded, free".
   - `badge`: "Free in agent mode"; "Needs a voice-over"; "Needs UGC footage"; "Paid: about $1.20"; or "Price unknown".
   - `request`: the fields for `buildProductionRequest` (section 6).
   - `planTemplate`: the orchestrator nodes, with their params.
   - `agentBrief`: the instructions an agent session follows in agent mode (section 5).

## 5. Two ways to run: agent mode and engine mode

- **Agent mode (free on the Claude plan).** A Claude Code session follows the cookbook as a skill, writes the script, builds the coded
  scenes and components, renders them locally (Chromium and ffmpeg, as `scripts/engine/preset-preview/` did today), and measures the
  result against the cookbook's checks. No provider is called, so there is no spend. A cookbook can offer agent mode only when every
  required ingredient has a free way. A voice-over needs a recording upload in this mode, since speech generation is a paid call.
- **Engine mode.** The Content Factory sends the resolved request to the engine. Paid steps go through the gateway and the ledger, with
  budgets as hard limits (CLAUDE.md rule 3).

The requirements panel shows which modes the current option values allow. For example, turning on "Voice-over: AI voice" removes agent
mode and adds the voice line to the estimate.

## 6. How a resolved cookbook reaches the engine

- **Phase A (no contract change).** `buildProductionRequest` (`src/lib/meridian/content-factory/request.ts`) takes the resolved cookbook
  and maps it onto fields the engine already reads:
  - `page.styleKitId`: the installed kit.
  - `format.keep`: the genes.
  - `visualRequests`: the shot wants.
  - `constraints.maxMs` and `constraints.budgetUsd`.
  - `brief.text`: a delimited "Cookbook instructions" section. Today `brief.text` is the only text that reaches the script writer
    (`write-script.ts`).
- **Phase B (contract change, decision D1 and Q1).** Add `cookbook: { id, version, valuesHash, instructions: Record<role, text> }` to
  `productionRequestSchema` as `engine-contracts@12`, with a Bible section 4 note. The roles that read it (scriptwriter, planner, critic,
  editor) get new prompt versions that read a "cookbook instructions" block. The shipped prompt files stay unchanged, since their hashes
  are pinned. Until D1 is answered, only the script step follows instructions.

## 7. Storage, versions and learning

- Built-in cookbooks live in code (`src/lib/meridian/cookbooks/builtin/`), read only, tested.
- Custom cookbooks live in a new table, `cookbooks`:
  - Columns: `id, organization_id, brand_id null, cookbook_id, version, body jsonb, content_hash, created_by, created_at, archived_at`.
  - Unique on `(organization_id, cookbook_id, version)`.
  - Rows are immutable: "edit" writes the next version, like `engine_kits`.
- Saving my settings forks the cookbook: a new `cookbook_id` with `parent` set, and the current values as its defaults.
- Every run records `cookbook_id`, `version`, the option values and the mode, on the content factory run and the engine request. With the
  published results and measurements, this gives the research agents a table of "which cookbook and which options earned what". That is
  the A-to-B return data the owner asked for. Scores stay scores until a calibration report says otherwise (AGENTS rule 9).

## 8. Screens

- **Cookbook library** (`/brands/$brandId/cookbooks`): cards with the badge, the needs and the estimate; filters by family and by
  "free in agent mode".
- **Cookbook detail**:
  - The options are rendered from `controls` with the existing `Switch`, `Slider`, `SelectInput` and `RadioGroup`, and the requirements
    and estimate update as they move.
  - Buttons: "Use in Content Factory" (opens the hub with `?cookbook=`), "Save as my cookbook", "Preview" (agent mode only: a local render).
- **Cookbook editor** (editor role): instructions per role, steps on and off, and the controls list. A form backed by the schema shows
  every validation error next to its field.
- **Content Factory start**: the cookbook picker replaces the three modes, which remain as "blank" cookbooks.
- Role checks: viewers read, editors use and save, admins edit built-in copies. Tenancy checks on every server function (AGENTS rule 2).
  Accessibility per AGENTS rule 11 (labels on every slider, keyboard, visible focus, reduced motion).

## 9. Tasks

Each task is one loop unit or less, with its own tests (fixture-based, PGlite where storage is touched).

| Id | Task | Files | Done when | Needs |
| --- | --- | --- | --- | --- |
| C1 | Shared control schema; component variables parsed into it | `src/lib/meridian/cookbooks/controls.ts`; a test over every `component.html` | Every component's variables parse; a bad declaration fails the test | – |
| C2 | Cookbook schema and `validateCookbook` | `cookbooks/schema.ts`, `validate.ts` | The rules in section 3 each have a failing and a passing test | C1 |
| C3 | `resolveCookbook`: values, bindings, requirements, cost class, estimate | `cookbooks/resolve.ts` | Golden tests: the same input gives the same output; unknown prices stay null; an unknown control is refused | C2 |
| C4 | First built-in: the 3D data explainer, converted from the style preset | `cookbooks/builtin/3d-data-explainer.ts` | It validates; its options change requirements as section 1 says | C3 |
| C5 | Two more built-ins that need paid parts: a UGC product cookbook (presenter: avatar or upload) and a voice-led listicle | `cookbooks/builtin/` | The badge shows "Needs UGC footage" or "Needs a voice-over" correctly | C3 |
| C6 | Storage: migration `0140_cookbooks.sql`, store, server functions (list, get, save version, fork, archive) | `cookbooks/store.ts`, `actions.ts` | PGlite tests: versions are immutable, a fork keeps its parent, tenancy and roles are enforced | C2 |
| C7 | Phase A wiring: `buildProductionRequest` takes a resolved cookbook | `content-factory/request.ts` | Request fixtures for each built-in; the instructions reach `brief.text` inside the delimited section | C3 |
| C8 | Runs record cookbook id, version, values and mode | migration, `content-factory` run store, engine request metadata | A run's cookbook can be read back; the export package includes it | C6, C7 |
| C9 | Cookbook library and detail screens | `src/routes/_app/brands/$brandId/cookbooks.tsx`, `src/components/cookbooks/` | Browser check: options move the requirements and the estimate; keyboard and contrast pass | C4, C6 |
| C10 | Content Factory start uses the picker; `?cookbook=` carries through to the request | `content-hub*.tsx` | ui-smoke covers the path | C7, C9 |
| C11 | Compose components the 3D explainer needs: `captions.boxed`, `stat.counter`, `label.pill`, `panel.bars`, `panel.line`, `panel.tiles`, `cta.follow` | `src/engine/compose/components/` | Golden snapshots; variables use the C1 schema | C1 |
| C12 | Agent mode: a cookbook-driven local renderer (generalises `scripts/engine/preset-preview/` to read a resolved cookbook and the C11 components) and a cookbook-to-skill export | `scripts/engine/cookbook-render/`, `.claude/skills/cookbook/` | The 3D explainer renders from its cookbook, and `compare.ts` reports its checks | C4, C11 |
| C13 | Checks: measure an output against a cookbook's targets and show pass, near or miss | `cookbooks/checks.ts` (uses the media functions) | Test on recorded measures; a real render's report matches `compare.ts` | C2 |
| C14 | Fold in the factory pipeline presets and retire `factory_pipeline_configs` | `factory/pipeline-*`, a migration | Each old preset exists as a cookbook; nothing reads the old table | D4 |
| C15 | Delete the dead flow modules | `src/lib/meridian/flow/` | Typecheck and tests pass | Q21 |
| C16 | Phase B: request contract field and new prompt versions for planner, critic and editor | `contracts/request.ts`, `contracts/version.ts`, `src/engine/prompts/*@n.md`, the roles | Contract tests; prompt hash pins for the new versions | D1 (Q1) |
| C17 | Learning view: results by cookbook and option, for the research agents | `src/lib/meridian/learning/` | Fixture test: a table with unknowns as unknown | C8 |

Order: C1 to C4 first (pure, no decisions needed), then C6, C7, C9 and C10 (a working product path in phase A), then C11 to C13 (agent
mode and quality checks), then C5, C8, C14, C15 and C17, and C16 when D1 is answered.

## 10. Decisions for the owner

| Id | Question | Recommendation |
| --- | --- | --- |
| D1 | Phase B: add a cookbook field to the engine request (a contract change, `engine-contracts@12`) so the planner, critic and editor follow cookbook instructions too? This is Q1 in a concrete form | Yes, after phase A works |
| D2 | Agent mode: may a video made fully by a Claude Code session go through the normal review, disclosure and publish gates like an engine video? | Yes, with the same gates and a label saying how it was made |
| D3 | Who can see a custom cookbook: the brand, the whole workspace, or both by choice? | Both, by choice; default to the brand |
| D4 | Retire the factory pipeline presets (stored but never applied today) once they exist as cookbooks? | Yes |
| D5 | Who may edit instructions, given that they reach model prompts: editors, or admins only? | Editors for their own cookbooks; admins for copies of built-ins |
| D6 | Record option values with run results for the research agents? | Yes; they are the main signal for which settings pay |
