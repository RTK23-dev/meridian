import { COMMITMENTS, FACTORY_STAGES, SHARED_CORE, SIGNAL_LABEL, TWO_WAYS, type StageSignal } from "./public-model";

/** The colour of a stage's signal. Each one also has its words, so colour is never the only cue. */
const SIGNAL_TONE: Record<StageSignal, string> = {
  review: "text-accent-text",
  decision: "text-fg",
  paused: "text-warning",
};

/**
 * The ten Factory stages as a grid of cells joined by hairlines: two columns on a tablet, five on a laptop, one on a phone. Each cell
 * names its stage, says what it does, and carries its signal in words when it stops for a person.
 */
export function FactoryRail() {
  return (
    <ol aria-label="The Factory stages, in order" className="grid gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-5">
      {FACTORY_STAGES.map((stage, index) => (
        <li key={stage.id} className="flex min-h-48 flex-col gap-3 bg-bg p-5">
          <span className="font-mono text-xs text-fg-muted">{String(index + 1).padStart(2, "0")}</span>
          <h3 className="font-display text-xl font-semibold tracking-tight text-fg">{stage.name}</h3>
          <p className="text-sm leading-relaxed text-fg-muted">{stage.what}</p>
          {stage.signal ? (
            <p className={`mt-auto pt-2 font-mono text-[0.7rem] uppercase leading-snug tracking-[0.12em] ${SIGNAL_TONE[stage.signal]}`}>
              {SIGNAL_LABEL[stage.signal]}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/**
 * The two ways in, drawn as two lanes that meet at one shared core. On a phone the lanes stack and the core sits under them; the
 * connecting rule is decoration and is hidden from assistive technology.
 */
export function TwoLanes() {
  return (
    <div className="space-y-0">
      <div className="grid gap-px border border-border bg-border md:grid-cols-2">
        {TWO_WAYS.map((way, index) => (
          <article key={way.id} className="flex flex-col gap-4 bg-bg p-6 sm:p-8">
            <p className="font-mono text-xs uppercase tracking-[0.14em] text-fg-muted">Lane {index + 1}</p>
            <h3 className="font-display text-2xl font-semibold tracking-tight text-fg">{way.label}</h3>
            <p className="text-fg-muted">{way.start}</p>
            <p className="mt-auto border-t border-border pt-4 text-sm leading-relaxed text-fg">{way.path}</p>
          </article>
        ))}
      </div>
      <div aria-hidden="true" className="mx-auto h-12 w-px bg-border" />
      <div className="bg-fg p-6 text-bg sm:p-10">
        <p className="font-mono text-xs uppercase tracking-[0.14em]">Shared core</p>
        <ul className="mt-5 flex flex-wrap gap-2">
          {SHARED_CORE.map((item) => (
            <li key={item} className="border border-current px-3 py-1.5 text-sm">
              {item}
            </li>
          ))}
        </ul>
        <p className="mt-6 max-w-prose text-sm leading-relaxed opacity-90">
          Both ways write to the same records. Neither has its own pipeline.
        </p>
      </div>
    </div>
  );
}

/** The commitments as numbered statements, one per row, each read on its own. */
export function Commitments() {
  return (
    <ol className="divide-y divide-border border-y border-border">
      {COMMITMENTS.map((line, index) => (
        <li key={line} className="grid gap-2 py-6 md:grid-cols-[5rem_minmax(0,1fr)] md:gap-6">
          <span aria-hidden="true" className="font-mono text-sm text-fg-muted">{String(index + 1).padStart(2, "0")}</span>
          <p className="max-w-prose text-lg leading-relaxed text-fg">{line}</p>
        </li>
      ))}
    </ol>
  );
}
