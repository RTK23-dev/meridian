import { useId, useState, type FormEvent } from "react";
import { Button, DisabledReason, Field, Input, StatusBadge } from "@/components/ui";
import { pageUrlForSeed } from "@/lib/meridian/sources/public-url";

export type DiscoverySourceRow = {
  adapterId: string;
  label: string;
  status: string;
  reason: string;
  connected: boolean;
};

type Props = {
  canEdit: boolean;
  sources: readonly DiscoverySourceRow[];
  pending: boolean;
  onStart: (seed: string) => void;
};

/**
 * Starts one public discovery run. A public page URL or domain is read directly, with no key. A search phrase needs a keyed
 * source with a saved key, so the control is disabled, with the reason written out, until one is connected. Each keyed source is
 * listed with its status, and the ones not connected keep their reason on screen.
 */
export function DiscoveryStart({ canEdit, sources, pending, onStart }: Props) {
  const [seed, setSeed] = useState("");
  const reasonId = useId();
  const trimmed = seed.trim();
  const isPage = pageUrlForSeed(trimmed) !== null;
  const anyConnected = sources.some((source) => source.connected);
  const disabledReason = !trimmed
    ? "Enter a search phrase or a public page URL to start a run."
    : !isPage && !anyConnected
      ? "No discovery source is connected for this workspace. Save a YouTube, SerpAPI or Meta Ad Library key in the Setup guide, or enter a public page URL instead."
      : null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabledReason || !canEdit || pending) return;
    onStart(trimmed);
    setSeed("");
  }

  return (
    <div className="space-y-4">
      <form className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end" onSubmit={submit}>
        <Field label="Search phrase or public page URL" hint="A page URL or domain is read as one page. Any other text is searched by the connected keyed sources.">
          <Input
            value={seed}
            onChange={(event) => setSeed(event.target.value)}
            maxLength={200}
            placeholder="artisan sourdough, or shop.example/sponge"
            aria-describedby={disabledReason ? reasonId : undefined}
            disabled={!canEdit}
          />
        </Field>
        <Button type="submit" disabled={!canEdit || pending || disabledReason !== null} aria-describedby={disabledReason ? reasonId : undefined}>
          {pending ? "Running discovery…" : "Start discovery"}
        </Button>
      </form>
      {!canEdit ? <DisabledReason id={reasonId}>Only workspace members can start a discovery run.</DisabledReason> : null}
      {canEdit && disabledReason ? <DisabledReason id={reasonId}>{disabledReason}</DisabledReason> : null}
      <div>
        <h3 className="text-lg">Sources for this workspace</h3>
        <ul className="mt-2 grid gap-x-6 md:grid-cols-2">
          {sources.map((source) => (
            <li key={source.adapterId} className="border-t border-border py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{source.label}</span>
                <StatusBadge status={source.connected ? "connected" : source.status === "failed" ? "failed" : "not_connected"} />
              </div>
              {source.connected ? null : <p className="mt-1 text-xs text-fg-muted [overflow-wrap:anywhere]">{source.reason || "Not connected."}</p>}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-fg-muted">Public pages need no key. Meridian reads each site's robots.txt first, and a bot check is reported, never bypassed. Keyed sources read the key saved for this workspace only. A key is checked when a request is made.</p>
      </div>
    </div>
  );
}
