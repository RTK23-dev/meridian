import { useId } from "react";
import { AlertCircle, CheckCircle2, Clock3, Info, PlugZap, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import type { ConnectionKind, ConnectionState, ProviderCard } from "./provider-options.ts";

const ICONS: Record<ConnectionKind, LucideIcon> = {
  connected: CheckCircle2,
  available: CheckCircle2,
  configured: Info,
  not_checked: Info,
  not_needed: Info,
  not_connected: PlugZap,
  checking: Clock3,
  unknown: AlertCircle,
};

function toneFor(kind: ConnectionKind): string {
  if (kind === "connected" || kind === "available") return "text-success";
  if (kind === "not_connected" || kind === "unknown") return "text-danger";
  return "text-fg-muted";
}

/** The connection line on a card. The icon and the words carry the state; the colour only reinforces it. */
function ConnectionLine({ connection }: { connection: ConnectionState }) {
  const Icon = ICONS[connection.kind];
  return (
    <span className={cn("flex items-start gap-1.5 text-xs", toneFor(connection.kind))}>
      <Icon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span>{connection.text}</span>
    </span>
  );
}

/**
 * A group of provider cards as one radio group. A card that is not connected is disabled, and its reason is attached to it.
 * Radio inputs keep native keyboard behaviour: arrow keys move the choice, and space or enter selects it.
 */
export function ProviderCardGroup<Value extends string>({
  legend,
  name,
  cards,
  value,
  error,
  onChange,
}: {
  legend: string;
  name: string;
  cards: ProviderCard<Value>[];
  value: string;
  error?: string;
  onChange: (value: Value) => void;
}) {
  const base = useId();
  return (
    <fieldset className="space-y-2" aria-describedby={error ? `${base}-error` : undefined}>
      <legend className="text-sm font-semibold">{legend}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {cards.map((card, index) => {
          const inputId = `${base}-${index}`;
          const reasonId = `${inputId}-reason`;
          const checked = value === card.value;
          return (
            <label
              key={card.value}
              htmlFor={inputId}
              className={cn(
                "flex min-h-11 gap-3 rounded-md border p-3 text-sm",
                checked ? "border-accent bg-accent-soft" : "border-border bg-surface",
                card.disabled ? "cursor-not-allowed opacity-75" : "cursor-pointer",
              )}
            >
              <input
                id={inputId}
                type="radio"
                name={name}
                value={card.value}
                checked={checked}
                disabled={card.disabled}
                aria-describedby={card.disabled && card.disabledReason ? reasonId : undefined}
                onChange={() => onChange(card.value)}
                className="mt-1 size-4 shrink-0"
              />
              <span className="min-w-0 space-y-1">
                <span className="block font-semibold">
                  {card.label}
                  {checked ? <span className="ml-2 text-xs font-normal text-fg-muted">Selected</span> : null}
                </span>
                <span className="block text-fg-muted">{card.description}</span>
                <ConnectionLine connection={card.connection} />
                {card.disabled && card.disabledReason ? <span id={reasonId} className="block text-xs text-danger">{card.disabledReason}</span> : null}
              </span>
            </label>
          );
        })}
      </div>
      {error ? <p id={`${base}-error`} role="alert" className="text-sm text-danger">{error}</p> : null}
    </fieldset>
  );
}
