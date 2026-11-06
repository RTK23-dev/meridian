// Direction scripts on PGlite (or PostgreSQL with MERIDIAN_PG_TEST_URL): who may ask for scripts, what a run is given, how a queued run is
// executed once and stored, how a revision keeps its concept and carries the person's note, and how choosing a script writes the draft's
// script lines. The model port is recorded and the catalogue is a fixture, so nothing here reads a key or calls a provider.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import type { TextModelChoice } from "../../../engine/orchestrator/settings.ts";
import type { Sql } from "../learning/store.ts";
import type { ExecutableJob } from "../jobs/execute.ts";
import type { GenerationDeps } from "../providers/chat.server.ts";
import { ADMIN_REFUSAL, SESSION_REFUSAL } from "../content-factory/service-core.ts";
import { createSession, getSession, postMessage } from "../content-factory/service-sessions.ts";
import { STRONG_SCRIPT, WEAK_SCRIPT } from "./fixtures.ts";
import type { DeckCard } from "./concepts.ts";
import type { DirectionPort, DirectionRequest, ModelCall } from "./pipeline.ts";
import type { DirectedScript } from "./script.ts";
import {
  askForRevision,
  askForScripts,
  chooseScript,
  directionPanelOf,
  directionRequestFor,
  directionSeatsOf,
  executeDirectionJob,
  REVISE_CALL_LIMIT,
  writeCallLimit,
  type DirectionPorts,
} from "./service.ts";
import { sessionAccess } from "../content-factory/service-core.ts";

const WS = "ws_dir_a";
const OTHER_WS = "ws_dir_b";
const BRAND = "brand_dir_a";
const ADMIN = "user_dir_admin";
const MEMBER = "user_dir_member";
const OTHER_ADMIN = "user_dir_other";

const BRIEF = "A short video for our double-wall mug. We tested three mugs for two hours; coffee poured at 90 degrees; ours held 61. Only 1 stayed hot.";

async function seedUser(sql: Sql, userId: string, organizationId: string, role: string): Promise<void> {
  await sql`insert into "user" (id, name, email, "emailVerified") values (${userId}, ${userId}, ${`${userId}@fixture.example`}, true)`;
  await sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${userId}`}, ${organizationId}, ${userId}, ${role})`;
}

function choice(id: string): TextModelChoice {
  return { id, name: id, promptUsdPerToken: 0.000003, completionUsdPerToken: 0.000015, inputModalities: ["text"], contextLength: 200_000 };
}

/** The stored task models and a catalogue that lists `listed`. */
function modelDeps(stored: Record<string, string>, listed: string[] = Object.values(stored)): GenerationDeps {
  return {
    stored: async (_organizationId, task) => stored[task] ?? null,
    catalog: async () => ({ status: "ok", choices: listed.map(choice), takenAt: "2026-11-05T10:00:00.000Z" }),
    env: {},
  };
}

const MODELS = { copy: "vendor-a/writer-1" };

function blockOf(user: string, name: string): unknown {
  const match = user.match(new RegExp(`<untrusted-data name="${name}">\\n([\\s\\S]*?)\\n</untrusted-data>`));
  if (!match) throw new Error(`no ${name} block`);
  return JSON.parse(match[1]!);
}

const IDEAS = [
  ["copper", "kettle", "dawn", "spill", "rescue"],
  ["glacier", "commute", "thermos", "race", "verdict"],
  ["lantern", "night", "shift", "nurse", "warmth"],
  ["orbit", "desk", "forgotten", "cup", "timer"],
  ["velvet", "grandmother", "kitchen", "recipe", "secret"],
  ["harbor", "fisherman", "storm", "flask", "dawnbreak"],
  ["meadow", "picnic", "wind", "lid", "surprise"],
  ["quartz", "lab", "thermometer", "graph", "proof"],
];

/** A recorded port: distinct concepts, a judge that keeps its choice when the order swaps, the strong script, and a swipe test that ships. */
function recordedPort(overrides: { director?: (call: ModelCall) => DirectedScript; swipe?: "ship" | "revise" } = {}): DirectionPort & { calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  let lab = 0;
  return {
    calls,
    async complete(call) {
      calls.push(call);
      let out: unknown;
      if (call.step === "concept_lab") {
        const cards = blockOf(call.user, "cards") as DeckCard[];
        const salt = lab * 4;
        lab += 1;
        out = {
          obvious: ["Show the mug on a desk", "List the mug's features", "A customer says it is great"],
          concepts: cards.map((card, index) => {
            const [a, b, c, d, e] = IDEAS[(index + salt) % IDEAS.length]!;
            return {
              ...card,
              topic: `${a} mug`,
              coreArgument: `${b} ${c} ${e}`,
              evidence: "The brief's two-hour test",
              job: "reach",
              audience: "broad",
              angle: `${a} ${b}`,
              hook: { picture: `${c} in motion`, text: `${d}`, voice: `${e} ${a}` },
              promise: `${b} ${c}`,
              payoff: `${d} ${e}`,
              sendTrigger: "utility",
              novelty: `${a} ${e}`,
              probability: 0.1,
            };
          }),
        };
      } else if (call.step === "viewer_panel") {
        const pairs = blockOf(call.user, "pairs") as { pair: number; first: unknown; second: unknown }[];
        out = { verdicts: pairs.map((entry) => ({ pair: entry.pair, choice: JSON.stringify(entry.first) < JSON.stringify(entry.second) ? "first" : "second", reason: "Sharper." })) };
      } else if (call.step === "script_director") {
        if (overrides.director) out = overrides.director(call);
        else {
          const concept = blockOf(call.user, "concept") as { hook: { picture: string } };
          out = { ...STRONG_SCRIPT, beats: [{ ...STRONG_SCRIPT.beats[0]!, picture: concept.hook.picture }, ...STRONG_SCRIPT.beats.slice(1)] };
        }
      } else {
        const ships = (overrides.swipe ?? "ship") === "ship";
        out = {
          windows: [{ fromMs: 0, toMs: 500, beatId: "b1", sees: "Three mugs", openQuestion: "Which stays hot?", expectation: "better", risk: ships ? "low" : "high", reason: "Stakes" }],
          scores: { stop_frame: { score: 3, evidence: "b1 motion" }, promise: { score: 3, evidence: "b1 text" } },
          blocker: ships ? "none" : "hook",
          verdict: ships ? "ship" : "revise",
          fixes: ships ? [] : ["b1: show the result first"],
        };
      }
      return { ok: true, content: JSON.stringify(out), model: `served-${call.slot}`, costUsd: 0.01 };
    },
  };
}

function ports(port: DirectionPort, stored: Record<string, string> = MODELS): DirectionPorts {
  return { modelDeps: modelDeps(stored), port: () => port };
}

async function jobOf(sql: Sql, runId: string): Promise<ExecutableJob & { status: string; idempotency_key: string }> {
  const [row] = await sql<ExecutableJob & { status: string; idempotency_key: string }>`
    select j.id, j.organization_id, j.brand_id, j.job_type, j.payload, j.attempts, j.max_attempts, j.status, j.idempotency_key
    from jobs j join direction_runs r on r.job_id = j.id where r.id = ${runId}
  `;
  assert.ok(row, "the run has a job");
  return row;
}

async function runJob(sql: Sql, runId: string, direction: DirectionPorts): Promise<string> {
  const job = await jobOf(sql, runId);
  await sql`update jobs set status = 'running', attempts = attempts + 1 where id = ${job.id}`;
  const result = await executeDirectionJob(sql, job, JSON.parse(job.payload) as Record<string, unknown>, direction);
  await sql`update jobs set status = 'succeeded', result = ${result} where id = ${job.id}`;
  return result;
}

const ASK = { count: 2, job: "reach" as const, niche: "ecommerce" as const, maxSeconds: 30, language: "en" };

describe("direction scripts for a draft", () => {
  let db: TestDatabase;
  let sql: Sql;

  before(async () => {
    db = await createTestDatabase();
    sql = db.sql;
    await seedWorkspace(sql, WS, BRAND);
    await seedWorkspace(sql, OTHER_WS);
    await seedUser(sql, ADMIN, WS, "admin");
    await seedUser(sql, MEMBER, WS, "member");
    await seedUser(sql, OTHER_ADMIN, OTHER_WS, "admin");
    await sql`
      insert into brand_brains (brand_id, target_customers, problems, tone, writing_style, proof_points, words_to_avoid, prohibited_claims, updated_by)
      values (${BRAND}, 'Office workers who forget their coffee', 'Cold coffee by ten', 'plain and warm', 'short sentences',
        'Keeps drinks hot for two hours', 'Thermo King', 'Never claim it is unbreakable', 'test')
    `;
  });

  after(async () => {
    await db?.close();
  });

  async function draft(text: string | null = BRIEF): Promise<string> {
    const session = await createSession(sql, ADMIN, { organizationId: WS, brandId: BRAND, title: "Mug test" });
    if (text) await postMessage(sql, ADMIN, { sessionId: session.id, text, beatRole: null });
    return session.id;
  }

  test("only an admin of the draft's workspace may ask, and a refused ask queues nothing", async () => {
    const sessionId = await draft();
    const port = recordedPort();
    await assert.rejects(askForScripts(sql, MEMBER, { sessionId, ...ASK }, ports(port)), new RegExp(ADMIN_REFUSAL.slice(0, 30)));
    await assert.rejects(askForScripts(sql, OTHER_ADMIN, { sessionId, ...ASK }, ports(port)), new RegExp(SESSION_REFUSAL));
    await assert.rejects(askForScripts(sql, ADMIN, { sessionId, ...ASK, count: 5 }, ports(port)), /Ask for 1 to 4 scripts/);
    await assert.rejects(askForScripts(sql, ADMIN, { sessionId, ...ASK, maxSeconds: 2 }, ports(port)), /Set a length from 5 to 180 seconds/);
    await assert.rejects(askForScripts(sql, ADMIN, { sessionId: await draft(null), ...ASK }, ports(port)), /Say what the video is for in the chat first/);
    await assert.rejects(askForScripts(sql, ADMIN, { sessionId, ...ASK }, ports(port, {})), /No model is chosen for Copy and scripts/);
    const [queued] = await sql<{ n: number }>`select count(*)::int as n from direction_runs where organization_id = ${WS} and session_id = ${sessionId}`;
    assert.equal(Number(queued!.n), 0);
    assert.equal(port.calls.length, 0, "asking never calls a model");
  });

  test("a stored seat that left the catalogue is refused with its reason, never swapped for another model", async () => {
    const sessionId = await draft();
    const refused = await directionSeatsOf(sql, ADMIN, { sessionId }, { modelDeps: modelDeps({ copy: MODELS.copy, direction_judge: "vendor-c/gone" }, [MODELS.copy]) });
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? "" : refused.reason, /^Script judge: vendor-c\/gone is not a text model with prices in the live catalogue/);
    const auto = await directionSeatsOf(sql, ADMIN, { sessionId }, { modelDeps: modelDeps(MODELS) });
    assert.ok(auto.ok);
    assert.deepEqual(auto.seats.writers, [MODELS.copy]);
    assert.equal(auto.seats.judge, MODELS.copy, "Auto judges with the copy model");
    assert.deepEqual(auto.seats.view, { writer: MODELS.copy, secondWriter: null, judge: MODELS.copy, secondWriterAuto: true, judgeAuto: true });
    const chosen = await directionSeatsOf(sql, ADMIN, { sessionId }, { modelDeps: modelDeps({ copy: MODELS.copy, direction_writer: "vendor-b/writer-2", direction_judge: "vendor-c/judge-1" }) });
    assert.ok(chosen.ok);
    assert.deepEqual(chosen.seats.writers, [MODELS.copy, "vendor-b/writer-2"]);
    assert.equal(chosen.seats.judge, "vendor-c/judge-1");
    assert.deepEqual(Object.keys(chosen.seats.slots).sort(), [MODELS.copy, "vendor-b/writer-2", "vendor-c/judge-1"].sort());
  });

  test("the request is the draft's instructions and the brand's brain, with the hooks to avoid", async () => {
    const sessionId = await draft();
    const row = await sessionAccess(sql, ADMIN, sessionId);
    const request = await directionRequestFor(sql, row, ASK);
    assert.equal(request.brief.text, BRIEF);
    assert.equal(request.brand.name, BRAND);
    assert.deepEqual(request.brand.claims, ["Keeps drinks hot for two hours"]);
    assert.deepEqual(request.brand.forbidden, ["Thermo King", "Never claim it is unbreakable"]);
    assert.equal(request.brand.tone, "plain and warm short sentences");
    assert.match(request.audience ?? "", /^Who: Office workers who forget their coffee\nProblems: Cold coffee by ten$/);
    assert.equal(request.maxDurationMs, 30_000);
    assert.equal(request.niche, "ecommerce");
    assert.deepEqual(request.trends, [], "no trend is given that discovery did not date");
  });

  test("a queued run is executed once, stores every option with its drafts, and the panel shows them", async () => {
    const sessionId = await draft();
    const port = recordedPort();
    const direction = ports(port);
    const asked = await askForScripts(sql, ADMIN, { sessionId, ...ASK }, direction);
    assert.equal(asked.callLimit, writeCallLimit(2));
    const job = await jobOf(sql, asked.runId);
    assert.equal(job.job_type, "direction.write");
    assert.equal(job.max_attempts, 1, "a paid run is never retried by itself");
    assert.equal(job.idempotency_key, `direction:${asked.runId}`);
    assert.deepEqual(JSON.parse(job.payload), { organizationId: WS, runId: asked.runId });
    await assert.rejects(askForScripts(sql, ADMIN, { sessionId, ...ASK }, direction), /already working on this draft/);

    const before = await directionPanelOf(sql, ADMIN, { sessionId });
    assert.equal(before.working, true);
    assert.equal(before.runs[0]!.status, "queued");

    assert.match(await runJob(sql, asked.runId, direction), /^direction:ready:2$/);
    assert.equal(await executeDirectionJob(sql, job, { runId: asked.runId }, direction), "direction:ready", "a finished run is not run again");

    const panel = await directionPanelOf(sql, ADMIN, { sessionId });
    assert.equal(panel.working, false);
    const run = panel.runs[0]!;
    assert.equal(run.status, "ready", run.reasons.join(" "));
    assert.equal(run.calls, port.calls.length);
    assert.ok(run.calls <= run.callLimit);
    assert.ok(Math.abs((run.costUsd ?? 0) - port.calls.length * 0.01) < 1e-6);
    assert.ok(run.concepts && run.concepts.kept >= 2);
    assert.equal(panel.scripts.length, 2);
    assert.deepEqual(
      panel.scripts.map((card) => card.rank).sort(),
      [1, 2],
    );
    const card = panel.scripts.find((item) => item.rank === 1)!;
    assert.equal(card.ships, true);
    assert.equal(card.blocked, false);
    assert.equal(card.state, "option");
    assert.equal(card.version, 1);
    assert.equal(card.beats[0]!.role, "hook");
    assert.ok(card.beats.at(-1)!.endMs > 0, "the timeline is measured");
    assert.equal(card.swipe?.verdict, "ship");
    assert.ok(port.calls.every((call) => call.slot === MODELS.copy), "with one model chosen, every seat uses it");
    const stored = await sql<{ record: string }>`select record from direction_runs where id = ${asked.runId}`;
    assert.ok((JSON.parse(stored[0]!.record) as { seats: { judgeAuto: boolean } }).seats.judgeAuto);

    // A new run avoids this draft's earlier hooks.
    const row = await sessionAccess(sql, ADMIN, sessionId);
    const next = await directionRequestFor(sql, row, ASK);
    assert.ok(next.recentHooks.includes(STRONG_SCRIPT.beats[0]!.voice));
  });

  test("a revision keeps the concept, carries the note, and becomes the next version of its script", async () => {
    const sessionId = await draft();
    const writePort = recordedPort();
    const first = await askForScripts(sql, ADMIN, { sessionId, ...ASK, count: 1 }, ports(writePort));
    await runJob(sql, first.runId, ports(writePort));
    const [original] = (await directionPanelOf(sql, ADMIN, { sessionId })).scripts;
    assert.ok(original);

    await assert.rejects(askForRevision(sql, ADMIN, { sessionId, scriptId: original.id, note: "x".repeat(601) }, ports(writePort)), /Keep a note to 600 characters/);
    await assert.rejects(askForRevision(sql, ADMIN, { sessionId, scriptId: "not-a-script", note: "" }, ports(writePort)), /not in this draft/);

    const revisePort = recordedPort();
    const asked = await askForRevision(sql, ADMIN, { sessionId, scriptId: original.id, note: "Open on the steam, not the timer" }, ports(revisePort));
    assert.equal(asked.callLimit, REVISE_CALL_LIMIT);
    assert.equal((await jobOf(sql, asked.runId)).job_type, "direction.revise");
    assert.equal(await runJob(sql, asked.runId, ports(revisePort)), "direction:ready");

    const director = revisePort.calls.find((call) => call.step === "script_director")!;
    assert.deepEqual(blockOf(director.user, "person"), { notes: "Open on the steam, not the timer" });
    assert.ok(blockOf(director.user, "draft"), "the director revises the draft");
    assert.equal(revisePort.calls.filter((call) => call.step === "concept_lab").length, 0, "a revision writes no new concepts");
    const request = await sql<{ request: string }>`select request from direction_runs where id = ${asked.runId}`;
    assert.ok(!(JSON.parse(request[0]!.request) as DirectionRequest).recentHooks.includes(STRONG_SCRIPT.beats[0]!.voice), "a revision may keep its own hook");

    const panel = await directionPanelOf(sql, ADMIN, { sessionId });
    const revised = panel.scripts.find((card) => card.parentId === original.id)!;
    assert.equal(revised.version, 2);
    assert.equal(revised.rank, original.rank);
    assert.equal(panel.runs[0]!.kind, "revise");
    assert.equal(panel.runs[0]!.ask.note, "Open on the steam, not the timer");
  });

  test("choosing a script writes its lines in order with a direction note, and choosing another replaces them", async () => {
    const sessionId = await draft();
    const port = recordedPort();
    const asked = await askForScripts(sql, ADMIN, { sessionId, ...ASK }, ports(port));
    await runJob(sql, asked.runId, ports(port));
    const [a, b] = (await directionPanelOf(sql, ADMIN, { sessionId })).scripts;
    assert.ok(a && b);

    await assert.rejects(chooseScript(sql, MEMBER, { sessionId, scriptId: a.id }), new RegExp(ADMIN_REFUSAL.slice(0, 30)));
    const detail = await chooseScript(sql, ADMIN, { sessionId, scriptId: a.id });
    const lines = detail.messages.filter((message) => message.beatRole !== null);
    assert.deepEqual(
      lines.map((message) => [message.beatRole, message.text]),
      STRONG_SCRIPT.beats.map((beat) => [beat.role, beat.voice]),
      "every spoken beat, in order, with its role",
    );
    const notes = detail.messages.filter((message) => message.beatRole === null);
    assert.equal(notes.length, 2, "the brief and one direction note");
    assert.match(notes[1]!.text, /^Direction for the chosen script \(option \d, version 1, direction-codex@2\)/);
    assert.match(notes[1]!.text, /b1 \(hook\): picture: .*; on screen: "Only 1 stays hot"; sound: A kettle click/);
    assert.equal(detail.settings.language, "en");
    assert.equal(detail.settings.maxSeconds, 30);

    // The direction brief leaves the posted note out.
    const row = await sessionAccess(sql, ADMIN, sessionId);
    assert.equal((await directionRequestFor(sql, row, ASK)).brief.text, BRIEF);

    const again = await chooseScript(sql, ADMIN, { sessionId, scriptId: b.id });
    assert.equal(again.messages.filter((message) => message.beatRole !== null).length, STRONG_SCRIPT.beats.length, "the first script's lines were replaced");
    assert.equal(again.messages.filter((message) => message.beatRole === null).length, 2);
    const states = await sql<{ id: string; state: string }>`select id, state from direction_scripts where session_id = ${sessionId} order by id`;
    assert.deepEqual(new Map(states.map((item) => [item.id, item.state])), new Map([[a.id, "option"], [b.id, "chosen"]]));
    const same = await chooseScript(sql, ADMIN, { sessionId, scriptId: b.id });
    assert.equal(same.messages.length, again.messages.length, "choosing the chosen script again changes nothing");
  });

  test("a script with a blocking finding, or a draft with hand-written lines, cannot take a chosen script", async () => {
    const sessionId = await draft();
    const weak = recordedPort({ director: () => WEAK_SCRIPT, swipe: "revise" });
    const asked = await askForScripts(sql, ADMIN, { sessionId, ...ASK, count: 1 }, ports(weak));
    await runJob(sql, asked.runId, ports(weak));
    const panel = await directionPanelOf(sql, ADMIN, { sessionId });
    assert.equal(panel.runs[0]!.status, "failed");
    const blocked = panel.scripts[0]!;
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.drafts, 3, "the first draft and two revisions");
    assert.ok(blocked.findings.some((finding) => finding.severity === "block"));
    await assert.rejects(chooseScript(sql, ADMIN, { sessionId, scriptId: blocked.id }), /blocking finding/);

    const handWritten = await draft();
    await postMessage(sql, ADMIN, { sessionId: handWritten, text: "My own hook line.", beatRole: "hook" });
    const port = recordedPort();
    const run = await askForScripts(sql, ADMIN, { sessionId: handWritten, ...ASK, count: 1 }, ports(port));
    await runJob(sql, run.runId, ports(port));
    const [option] = (await directionPanelOf(sql, ADMIN, { sessionId: handWritten })).scripts;
    await assert.rejects(chooseScript(sql, ADMIN, { sessionId: handWritten, scriptId: option!.id }), /script lines written by hand/);
    const detail = await getSession(sql, ADMIN, { sessionId: handWritten });
    assert.deepEqual(
      detail.messages.filter((message) => message.beatRole !== null).map((message) => message.text),
      ["My own hook line."],
      "nothing the person wrote is lost or mixed",
    );
  });

  test("a run whose seats are refused when it starts fails with the reason and sends nothing; a dead job shows as failed", async () => {
    const sessionId = await draft();
    const port = recordedPort();
    const asked = await askForScripts(sql, ADMIN, { sessionId, ...ASK }, ports(port));
    assert.equal(await runJob(sql, asked.runId, { modelDeps: modelDeps({}), port: () => port }), "direction:failed");
    assert.equal(port.calls.length, 0);
    const run = (await directionPanelOf(sql, ADMIN, { sessionId })).runs[0]!;
    assert.equal(run.status, "failed");
    assert.match(run.reasons[0] ?? "", /No model is chosen for Copy and scripts.*Nothing was sent\.$/);

    const stuck = await askForScripts(sql, ADMIN, { sessionId, ...ASK }, ports(port));
    const job = await jobOf(sql, stuck.runId);
    await sql`update direction_runs set status = 'running' where id = ${stuck.runId}`;
    await sql`update jobs set status = 'dead', last_error = 'Lease expired before the worker finished.' where id = ${job.id}`;
    const shown = (await directionPanelOf(sql, ADMIN, { sessionId })).runs[0]!;
    assert.equal(shown.status, "failed");
    assert.match(shown.reasons.at(-1) ?? "", /The worker stopped before the run finished: Lease expired/);
    await askForScripts(sql, ADMIN, { sessionId, ...ASK }, ports(port));
  });

  test("another workspace cannot read a draft's scripts", async () => {
    const sessionId = await draft();
    await assert.rejects(directionPanelOf(sql, OTHER_ADMIN, { sessionId }), new RegExp(SESSION_REFUSAL));
  });
});
