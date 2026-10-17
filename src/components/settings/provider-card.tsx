import { Link } from "@tanstack/react-router";
import { Circle } from "lucide-react";
import type { ReactNode } from "react";
import { Button, StatusBadge } from "@/components/ui";
import type { CardModel } from "./integration-model";

export type CardAction = { key: string; label: string; onClick: () => void; disabled?: boolean; pending?: boolean };

/** One provider: its status, what the server reports, and the step that is missing. Actions are passed in by the page. */
export function ProviderCard({ card, actions = [], link, note, extra }: {
  card: CardModel;
  actions?: CardAction[];
  link?: { to: "/settings"; label: string };
  note?: string;
  extra?: ReactNode;
}) {
  return (
    <li className="flex min-w-0 flex-col gap-3 panel transition duration-200 hover:shadow-md">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <h3 className="min-w-0 text-base font-semibold text-fg">{card.label}</h3>
        <StatusBadge status={card.status} label={card.label} />
      </div>
      <p className="break-words text-sm text-fg-muted [overflow-wrap:anywhere]">{card.summary}</p>
      {card.facts.map((fact) => <p key={fact} className="break-words text-sm text-fg [overflow-wrap:anywhere]">{fact}</p>)}
      {card.missing ? (
        <p className="flex min-w-0 items-start gap-2 border-t border-border pt-3 text-sm text-fg-muted">
          <Circle aria-hidden="true" className="mt-1 size-3 shrink-0" />
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">{card.missing}</span>
        </p>
      ) : null}
      {extra}
      {actions.length || link ? (
        <div className="mt-auto flex min-w-0 flex-wrap items-center gap-2 pt-1">
          {actions.map((action, index) => (
            <Button key={action.key} type="button" variant={index === 0 ? "primary" : "secondary"} size="lg" disabled={action.disabled || action.pending} onClick={action.onClick}>
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
