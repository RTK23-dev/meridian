import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/components/ui/cn";
import type { StudioPhase } from "./studio-phases.ts";

const STATE_WORD: Record<StudioPhase["state"], string> = {
  done: "done",
  current: "waiting on you",
  blocked: "blocked",
  upcoming: "ahead",
};

/**
 * The Studio's phases as a row of dots on one line: a filled dot is done, an accent dot waits on the person, a hollow dot is ahead, and the
 * open phase is the larger, ringed dot with its name in full. Each dot is a tab, so a tap, a click or the arrow keys move between phases.
 * The line fills up to the last phase that is done. Must sit inside the Studio's Tabs root.
 */
export function PhaseDots({ phases, open }: { phases: StudioPhase[]; open: string }) {
  const lastDone = phases.reduce((last, phase, index) => (phase.state === "done" ? index : last), -1);
  const span = phases.length - 1;
  const openPhase = phases.find((phase) => phase.key === open) ?? phases[0]!;
  // The track runs from the middle of the first cell to the middle of the last.
  const inset = `${50 / phases.length}%`;
  const fill = lastDone <= 0 ? 0 : (lastDone / span) * (100 - 100 / phases.length);

  return (
    <div className="space-y-2">
      <TabsPrimitive.List aria-label="Studio phases" className="relative grid" style={{ gridTemplateColumns: `repeat(${phases.length}, minmax(0, 1fr))` }}>
        <span aria-hidden="true" className="absolute top-[1.375rem] h-px bg-border-strong" style={{ left: inset, right: inset }} />
        <span aria-hidden="true" className="absolute top-[1.375rem] h-px bg-fg-primary transition-[width] duration-300 motion-reduce:transition-none" style={{ left: inset, width: `${fill}%` }} />
        {phases.map((phase) => {
          const active = phase.key === open;
          return (
            <TabsPrimitive.Trigger
              key={phase.key}
              value={phase.key}
              className="group relative flex min-h-11 flex-col items-center gap-1.5 rounded-sharp pb-1 pt-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "relative z-10 block rounded-full transition-transform duration-200 motion-reduce:transition-none",
                  active ? "size-3.5 ring-2 ring-accent ring-offset-2 ring-offset-ground" : "size-2.5 group-hover:scale-125",
                  phase.state === "done" ? "bg-fg-primary" : phase.state === "current" ? "bg-accent" : phase.state === "blocked" ? "bg-danger" : "border border-border-strong bg-ground",
                )}
              />
              <span className={cn("max-w-full truncate px-0.5 text-caption", active ? "font-semibold text-fg-primary" : "text-fg-muted group-hover:text-fg-primary")}>
                {phase.label}
              </span>
              <span className="sr-only">: {STATE_WORD[phase.state]}</span>
            </TabsPrimitive.Trigger>
          );
        })}
      </TabsPrimitive.List>
      <p className="text-center text-caption text-fg-muted" aria-live="polite">
        <span className="text-fg-primary">{openPhase.label}</span> · {openPhase.description}
      </p>
    </div>
  );
}
