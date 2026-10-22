import { cn } from "@/components/ui/cn";
import type { AgentState, AgentTone } from "./team-model";

/**
 * The team at work on the overview (DESIGN.md section 7). Each agent is a monogram, never a mascot. A working agent's ring pulses with the
 * attention signal, a blocked one has a danger ring, and one waiting on the person has a solid violet ring. Every state also has its words, so
 * colour is never the only signal.
 */
const RING: Record<AgentTone, string> = {
  checking: "border border-hairline",
  blocked: "ring-2 ring-danger",
  waiting: "signal-ring",
  working: "signal-ring signal-working",
  queued: "border border-dashed border-border-strong",
  idle: "border border-hairline",
};

const LABEL: Record<AgentTone, string> = {
  checking: "text-fg-muted",
  blocked: "text-danger",
  waiting: "text-fg",
  working: "text-fg",
  queued: "text-fg-secondary",
  idle: "text-fg-muted",
};

export function TeamPanel({ agents }: { agents: AgentState[] }) {
  return (
    <section aria-labelledby="team-heading" className="panel">
      <h2 id="team-heading" className="text-heading font-semibold text-fg">Your team</h2>
      <p className="mt-1 text-small text-fg-muted">What each agent is doing right now, from the workspace's own jobs.</p>
      <ul className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {agents.map((agent) => (
          <li key={agent.id} className="flex min-w-0 items-start gap-3" data-tone={agent.tone}>
            <span aria-hidden="true" className={cn("grid size-8 shrink-0 place-items-center rounded-full bg-overlay font-sans text-caption font-semibold text-fg", RING[agent.tone])}>
              {agent.monogram}
            </span>
            <div className="min-w-0">
              <p className="text-small font-semibold text-fg">{agent.name}</p>
              <p className="text-caption text-fg-muted">{agent.role}</p>
              <p className={cn("mt-1 text-small", LABEL[agent.tone])}>{agent.label}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
