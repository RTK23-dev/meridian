import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, ErrorNotice, Field, Input, SelectInput, Textarea } from "@/components/ui";
import { chooseDirectionScript, getDirectionPanel, getDirectionSeats, reviseDirectionScript, writeDirectionScripts } from "@/lib/meridian/direction/actions";
import type { Message } from "@/lib/meridian/content-factory/model";
import type { DirectionPanel, RunCard } from "@/lib/meridian/direction/service";
import type { SeatsOutcome } from "@/lib/meridian/direction/seats";
import { NICHE_FAMILIES } from "@/lib/meridian/direction/lists";
import { JOB_CHOICES, OPTION_COUNTS, RUN_STATUS_WORDS, costWords, lineagesOf, scriptState, seatWords, seconds, writeBlock, writeLabel, type ScriptLineage } from "./create-scripts-model";

/** How often the panel reads a working run again. */
const POLL_MS = 4000;

function failureText(failure: unknown, fallback: string): string {
  return failure instanceof Error && failure.message ? failure.message : fallback;
}

/**
 * The Scripts panel of a draft on the Create page: write one script or several to choose from, regenerate one with a note or ask for a new
 * idea, and use one as the draft's script. Each run is queued, spends from the workspace's budget within its call limit, and shows its
 * cost as the provider reported it. Admins only: the server refuses everyone else as well.
 */
export function CreateScripts({ sessionId, canAdmin, language: draftLanguage, onMessages }: { sessionId: string; canAdmin: boolean; language: string | null; onMessages: (messages: Message[]) => void }) {
  const [panel, setPanel] = useState<DirectionPanel | null>(null);
  const [seats, setSeats] = useState<SeatsOutcome | null>(null);
  const [count, setCount] = useState(3);
  const [job, setJob] = useState<(typeof JOB_CHOICES)[number]["value"]>("reach");
  const [niche, setNiche] = useState("");
  const [maxSeconds, setMaxSeconds] = useState(30);
  const [language, setLanguage] = useState(draftLanguage ?? "en");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setPanel(await getDirectionPanel({ data: { sessionId } }));
    } catch (failure) {
      setProblem(failureText(failure, "The scripts could not be read. Reload the page to try again."));
    }
  }, [sessionId]);

  useEffect(() => {
    setPanel(null);
    setSeats(null);
    void refresh();
    getDirectionSeats({ data: { sessionId } })
      .then(setSeats)
      .catch((failure: unknown) => setSeats({ ok: false, reason: failureText(failure, "The models could not be checked.") }));
  }, [sessionId, refresh]);

  const working = panel?.working ?? false;
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [working, refresh]);

  const block = writeBlock({ canAdmin, draft: panel?.draft ?? true, working: working || busy, seats, maxSeconds, language: language.trim() });
  const lineages = useMemo(() => lineagesOf(panel?.scripts ?? []), [panel]);
  const latestRun = panel?.runs[0] ?? null;

  async function act(work: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setProblem(null);
    try {
      await work();
      await refresh();
      return true;
    } catch (failure) {
      setProblem(failureText(failure, "That did not work. Nothing was spent."));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const write = (howMany: number) =>
    act(() => writeDirectionScripts({ data: { sessionId, count: howMany, job, niche: niche ? (niche as (typeof NICHE_FAMILIES)[number]) : null, maxSeconds, language: language.trim() } }));
  const revise = (scriptId: string, note: string) => act(() => reviseDirectionScript({ data: { sessionId, scriptId, note } }));
  const choose = (scriptId: string) =>
    act(async () => {
      const detail = await chooseDirectionScript({ data: { sessionId, scriptId } });
      onMessages(detail.messages);
    });

  return (
    <section aria-labelledby="create-scripts" className="mt-6 space-y-5 border-t border-hairline pt-5">
      <div className="space-y-1">
        <p className="eyebrow">Scripts</p>
        <h2 id="create-scripts" className="font-display text-xl font-semibold tracking-tight text-fg-primary">Write scripts from this draft</h2>
        <p className="max-w-prose text-sm text-fg-secondary">
          Meridian writes many ideas, drops the obvious ones, ranks the rest as viewers would, then scripts the best, checks every line and walks
          each script second by second. A run spends from this workspace's budget, within a hard limit of model calls.
        </p>
        <p className={seats && !seats.ok ? "text-caption text-warning" : "text-caption text-fg-muted"} role="status">{seatWords(seats)}</p>
      </div>

      {canAdmin ? (
        <div className="grid gap-3 sm:grid-cols-5">
          <Field label="How many">
            <SelectInput value={count} onChange={(event) => setCount(Number(event.target.value))}>
              {OPTION_COUNTS.map((value) => (
                <option key={value} value={value}>{value === 1 ? "1 script" : `${value} options`}</option>
              ))}
            </SelectInput>
          </Field>
          <Field label="Job" hint={JOB_CHOICES.find((choice) => choice.value === job)?.hint}>
            <SelectInput value={job} onChange={(event) => setJob(event.target.value as typeof job)}>
              {JOB_CHOICES.map((choice) => (
                <option key={choice.value} value={choice.value}>{choice.label}</option>
              ))}
            </SelectInput>
          </Field>
          <Field label="Niche">
            <SelectInput value={niche} onChange={(event) => setNiche(event.target.value)}>
              <option value="">Any</option>
              {NICHE_FAMILIES.map((value) => (
                <option key={value} value={value}>{value === "b2b" ? "B2B" : value[0]!.toUpperCase() + value.slice(1)}</option>
              ))}
            </SelectInput>
          </Field>
          <Field label="Seconds">
            <Input type="number" min={5} max={180} value={maxSeconds} onChange={(event) => setMaxSeconds(Number(event.target.value))} />
          </Field>
          <Field label="Language">
            <Input value={language} onChange={(event) => setLanguage(event.target.value)} maxLength={12} spellCheck={false} />
          </Field>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void write(count)} disabled={block !== null} loading={busy && !working}>
          {writeLabel(count)}
        </Button>
        {block && !(seats && !seats.ok && block === seats.reason) ? <p className="text-sm text-fg-muted">{block}</p> : null}
      </div>

      {problem ? <ErrorNotice>{problem}</ErrorNotice> : null}
      {latestRun ? <RunSummary run={latestRun} /> : null}

      {panel === null ? (
        <p className="text-sm text-fg-muted">Reading this draft's scripts...</p>
      ) : lineages.length === 0 ? (
        <p className="text-sm text-fg-muted">No scripts yet. Write some from the instructions above.</p>
      ) : (
        <ol className="space-y-5" aria-label="Scripts">
          {lineages.map((lineage) => (
            <li key={lineage.rootId}>
              <ScriptLineageCard
                lineage={lineage}
                canAct={canAdmin && (panel?.draft ?? false) && !working && !busy}
                onChoose={choose}
                onRevise={revise}
                onFresh={() => void write(1)}
                freshBlock={block}
              />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function RunSummary({ run }: { run: RunCard }) {
  const variant = run.status === "ready" ? "success" : run.status === "failed" ? "danger" : run.status === "needs_person" ? "warning" : "info";
  return (
    <div className="space-y-2 border border-hairline bg-raised px-4 py-3 text-sm" aria-live="polite">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Badge variant={variant}>{RUN_STATUS_WORDS[run.status]}</Badge>
        <span className="text-fg-secondary">
          {run.kind === "revise" ? "Revision" : run.ask.count === 1 ? "One script" : `${run.ask.count ?? "?"} options`} · {run.calls} of at most {run.callLimit} model calls ·{" "}
          {costWords(run)}
        </span>
      </div>
      {run.concepts ? (
        <p className="text-fg-muted">
          {run.concepts.written} ideas written, {run.concepts.written - run.concepts.kept} dropped (obvious, repeated or near-copies), {run.concepts.kept} ranked
          {run.concepts.reliability !== null ? `; the ranking held for ${Math.round(run.concepts.reliability * 100)}% of pairs when their order was swapped` : ""}.
        </p>
      ) : null}
      {run.concepts && run.concepts.obvious.length > 0 ? (
        <details className="text-fg-muted">
          <summary className="cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">Ideas every writer would reach, so none was used</summary>
          <ul className="mt-1 list-disc pl-5">
            {run.concepts.obvious.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {[...run.reasons, ...run.notes].length > 0 ? (
        <ul className="list-disc space-y-1 pl-5 text-fg-secondary">
          {[...run.reasons, ...run.notes].map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ScriptLineageCard({
  lineage,
  canAct,
  onChoose,
  onRevise,
  onFresh,
  freshBlock,
}: {
  lineage: ScriptLineage;
  canAct: boolean;
  onChoose: (scriptId: string) => void;
  onRevise: (scriptId: string, note: string) => Promise<boolean>;
  onFresh: () => void;
  freshBlock: string | null;
}) {
  const latest = lineage.versions.at(-1)!;
  const [shownId, setShownId] = useState(latest.id);
  const [note, setNote] = useState("");
  const [revising, setRevising] = useState(false);
  useEffect(() => setShownId(latest.id), [latest.id]);
  const script = lineage.versions.find((version) => version.id === shownId) ?? latest;
  const state = scriptState(script);
  const hook = script.beats[0];

  return (
    <article className="space-y-4 border border-hairline bg-raised px-4 py-4" aria-labelledby={`script-${script.id}`}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-caption font-semibold uppercase tracking-wide text-fg-muted">
            {lineage.rank !== null ? `Option ${lineage.rank}` : "Script"} · {script.concept.hookFamily} · {script.concept.format} · {script.concept.feeling} · {seconds(script.durationMs)}
          </p>
          <h3 id={`script-${script.id}`} className="font-display text-lg font-semibold text-fg-primary">
            {hook?.onScreenText ?? hook?.voice ?? script.topic ?? "Untitled script"}
          </h3>
          <p className="text-sm text-fg-secondary">{script.concept.angle}</p>
        </div>
        <Badge variant={state.variant}>{state.label}</Badge>
      </header>

      {lineage.versions.length > 1 ? (
        <Field label="Version">
          <SelectInput value={script.id} onChange={(event) => setShownId(event.target.value)} className="max-w-56">
            {lineage.versions.map((version) => (
              <option key={version.id} value={version.id}>
                Version {version.version}
                {version.id === latest.id ? " (latest)" : ""}
              </option>
            ))}
          </SelectInput>
        </Field>
      ) : null}

      <ol className="space-y-3" aria-label="Timeline">
        {script.beats.map((beat) => (
          <li key={beat.beatId} className="grid gap-1 sm:grid-cols-[6.5rem_1fr]">
            <p className="text-caption text-fg-muted">
              {seconds(beat.startMs)}–{seconds(beat.endMs)} · {beat.role}
            </p>
            <div className="space-y-1">
              {beat.voice ? <p className="text-body text-fg-primary">{beat.voice}</p> : <p className="text-sm italic text-fg-muted">No voice.</p>}
              {beat.onScreenText ? <p className="text-sm text-fg-secondary">On screen: “{beat.onScreenText}”</p> : null}
              {beat.picture ? <p className="text-sm text-fg-muted">Picture: {beat.picture}</p> : null}
              {beat.sound ? <p className="text-sm text-fg-muted">Sound: {beat.sound}</p> : null}
              {beat.borrowed ? (
                <p className="text-sm text-fg-secondary">
                  Borrowed opening: {beat.borrowed.source}, credited “{beat.borrowed.credit}”. Attach it at publishing with the platform's Stitch or Remix: the engine does not render another creator's footage.
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2 text-sm">
          <p className="font-semibold text-fg-secondary">Checks</p>
          <p className="text-fg-muted">
            {script.counts.block} blocking, {script.counts.warn === 1 ? "1 warning" : `${script.counts.warn} warnings`}. Trust floor: {script.floors.trust.replace("_", " ")}. Originality floor:{" "}
            {script.floors.originality.replace("_", " ")}.
          </p>
          {script.findings.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5 text-fg-secondary">
              {script.findings.map((finding, index) => (
                <li key={`${finding.beatId}-${index}`} className={finding.severity === "block" ? "text-danger" : undefined}>
                  {finding.severity === "block" ? "Blocks: " : ""}
                  {finding.beatId ? `${finding.beatId}: ` : ""}
                  {finding.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="space-y-2 text-sm">
          <p className="font-semibold text-fg-secondary">Swipe test</p>
          {script.swipe ? (
            <>
              <p className="text-fg-muted">
                {script.swipe.verdict === "ship" ? "Would ship." : "Would revise."} Biggest leak: {script.swipe.blocker === "none" ? "none" : script.swipe.blocker}.
                {script.swipe.leanIn !== null ? ` Lean-In score ${Math.round(script.swipe.leanIn)} of 100 (a model's reading, not a forecast).` : ""}
              </p>
              {script.swipe.risky.length > 0 ? (
                <ul className="list-disc space-y-1 pl-5 text-fg-secondary">
                  {script.swipe.risky.map((window) => (
                    <li key={`${window.beatId}-${window.fromMs}`}>
                      At {seconds(window.fromMs)} ({window.beatId}) a viewer may leave: {window.reason}
                    </li>
                  ))}
                </ul>
              ) : null}
              {script.swipe.fixes.length > 0 ? <p className="text-fg-muted">Suggested: {script.swipe.fixes.join(" · ")}</p> : null}
            </>
          ) : (
            <p className="text-fg-muted">The swipe test did not answer for this draft.</p>
          )}
        </div>
      </div>

      <details className="text-sm text-fg-muted">
        <summary className="cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">Why it is shaped this way</summary>
        <p className="mt-1">{script.rationale}</p>
        <p className="mt-1">Promise: {script.concept.promise}. Payoff: {script.concept.payoff}. New element: {script.concept.novelty}.</p>
        {script.drafts > 1 ? <p className="mt-1">This version took {script.drafts} drafts: the checks and the swipe test sent it back.</p> : null}
      </details>

      {revising ? (
        <div className="space-y-2">
          <Textarea
            label="What should change? (optional)"
            hint="For example: open on the result, shorter lines, a warmer voice. The checks still apply: a note cannot add facts the draft does not give."
            value={note}
            maxLength={600}
            onChange={(event) => setNote(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="md"
              disabled={!canAct}
              onClick={() => {
                void onRevise(script.id, note).then((queued) => {
                  if (!queued) return;
                  setRevising(false);
                  setNote("");
                });
              }}
            >
              Regenerate this script
            </Button>
            <Button variant="ghost" size="md" onClick={() => setRevising(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="md" disabled={!canAct || script.blocked || script.state === "chosen"} onClick={() => onChoose(script.id)}>
          {script.state === "chosen" ? "This is the draft's script" : "Use this script"}
        </Button>
        {!revising ? (
          <Button variant="secondary" size="md" disabled={!canAct} onClick={() => setRevising(true)}>
            Regenerate with a note
          </Button>
        ) : null}
        <Button variant="ghost" size="md" disabled={!canAct || freshBlock !== null} onClick={onFresh}>
          New idea instead
        </Button>
        {script.blocked ? <p className="text-sm text-fg-muted">A blocked script cannot be used. Regenerate it, or choose another.</p> : null}
      </div>
    </article>
  );
}
