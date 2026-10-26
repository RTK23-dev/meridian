import { useId, useState, type FormEvent } from "react";
import { Button, DisabledReason, Field, Input, StatusBadge } from "@/components/ui";
import { groupSources, SOURCE_CAPABILITIES } from "@/lib/meridian/discovery/source-capabilities";
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
  const groups = groupSources(sources);
  const anyConnected = groups.search.some((source) => source.connected);
  const disabledReason = !trimmed
    ? "Enter a public page URL to read, or a search phrase."
    : !isPage && !anyConnected
      ? "No discovery source is connected for this workspace. To search by phrase, save a search source key in the Setup guide. Or enter a public page URL, which needs none."
      : null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabledReason || !canEdit || pending) return;
    onStart(trimmed);
    setSeed("");
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 text-sm md:grid-cols-2">
        <p><span className="font-semibold">Paste a public page URL.</span> Meridian reads that one page. No setup or key is needed. The result is the examples on that page.</p>
        <p><span className="font-semibold">Or search by phrase.</span> This asks a connected search source, with your own key, for matching examples. It is optional.</p>
      </div>
      <form className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end" onSubmit={submit}>
        <Field label="Public page URL, or a search phrase" hint="A page URL or domain is read as one page. Any other text is searched by a connected search source.">
          <Input
            value={seed}
            onChange={(event) => setSeed(event.target.value)}
            maxLength={200}
            placeholder="shop.example/sponge, or artisan sourdough"
            aria-describedby={disabledReason ? reasonId : undefined}
            disabled={!canEdit}
          />
        </Field>
        <Button type="submit" disabled={!canEdit || pending || disabledReason !== null} aria-describedby={disabledReason ? reasonId : undefined}>
          {pending ? "Reading…" : isPage ? "Read this page" : "Search"}
        </Button>
      </form>
      {!canEdit ? <DisabledReason id={reasonId}>Only workspace members can start a discovery run.</DisabledReason> : null}
      {canEdit && disabledReason ? <DisabledReason id={reasonId}>{disabledReason}</DisabledReason> : null}
      <p className="text-xs text-fg-muted">Meridian reads each site's robots.txt first. When a site says no, or shows a bot check, that is reported and never worked around. You can upload an example or paste its text instead.</p>
      <details>
        <summary className="cursor-pointer text-sm text-fg-muted">
          Optional: search by phrase ({groups.search.filter((source) => source.connected).length} of {groups.search.length} connected)
        </summary>
        <p className="mt-2 text-xs text-fg-muted">
          These use your own developer key for the service to search public material. They are never needed to read a page URL, and none of them needs the password or token of the brand you are studying. A saved key is checked only when a search runs.
        </p>
        <ul className="mt-2 grid gap-x-6 md:grid-cols-2">
          {groups.search.map((source) => (
            <li key={source.adapterId} className="border-t border-border py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{source.label}</span>
                <StatusBadge status={source.connected ? "connected" : source.status === "failed" ? "failed" : "not_connected"} />
              </div>
              <p className="mt-1 text-xs text-fg-muted">{SOURCE_CAPABILITIES[source.adapterId]?.summary}</p>
            </li>
          ))}
        </ul>
      </details>
      {groups.unavailable.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-sm text-fg-muted">Not available in this release ({groups.unavailable.length})</summary>
          <p className="mt-2 text-xs text-fg-muted">No key is needed for these, and saving one changes nothing. Here is what to do instead.</p>
          <ul className="mt-2 grid gap-x-6 md:grid-cols-2">
            {groups.unavailable.map((source) => (
              <li key={source.adapterId} className="border-t border-border py-3">
                <span className="font-semibold">{source.label}</span>
                <p className="mt-1 text-xs text-fg-muted">{SOURCE_CAPABILITIES[source.adapterId]?.instead ?? SOURCE_CAPABILITIES[source.adapterId]?.summary}</p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
