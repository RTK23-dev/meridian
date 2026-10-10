import { Link } from "@tanstack/react-router";
import { Circle } from "lucide-react";
import { Button, StatusBadge } from "@/components/ui";
import type { CardModel } from "./integration-model";

export type CardAction = { key: string; label: string; onClick: () => void; disabled?: boolean; pending?: boolean };

/** One provider: its status, what the server reports, and the step that is missing. Actions are passed in by the page. */
export function ProviderCard({ card, actions = [], link, note }: {
  card: CardModel;
  actions?: CardAction[];
  link?: { to: "/settings"; label: string };
  note?: string;
}) {
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="text-base font-semibold text-fg">{card.label}</h3>
        <StatusBadge status={card.status} label={card.label} />
      </div>
      <p className="text-sm text-fg-muted">{card.summary}</p>
      {card.facts.map((fact) => <p key={fact} className="text-sm text-fg">{fact}</p>)}
      {card.missing ? (
        <div className="rounded-md border border-border bg-surface-2 p-3 text-sm">
          <p className="flex items-center gap-2 font-semibold text-fg">
            <Circle aria-hidden="true" className="size-3 text-fg-muted" />What is missing
          </p>
          <p className="mt-1 text-fg-muted">{card.missing}</p>
        </div>
      ) : null}
      {actions.length || link ? (
        <div className="mt-auto flex flex-wrap gap-2 pt-1">
          {actions.map((action) => (
            <Button key={action.key} type="button" variant="secondary" size="lg" disabled={action.disabled || action.pending} onClick={action.onClick}>
              {action.pending ? "Working…" : action.label}
              <span className="sr-only"> for {card.label}</span>
            </Button>
          ))}
          {link ? <Button asChild variant="quiet" size="lg"><Link to={link.to}>{link.label}</Link></Button> : null}
        </div>
      ) : null}
      {note ? <p className="text-sm text-fg-muted">{note}</p> : null}
    </li>
  );
}
