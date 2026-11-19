// The cookbook library (round 3, K19): the cards a brand's library shows, filtered by family and by "free in agent mode", and a detail for one
// cookbook: its settings, its cost and needs, a way to make a video with it (the Create section, where the run's cookbook step offers it), and
// "Save as my cookbook" (a copy the person can edit). The rules are in library-model.ts; the server checks every write. Nothing here decides a
// cookbook.

import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button, Input, ScreenSkeleton, SelectInput, Switch, toast } from "@/components/ui";
import { hasRole } from "@/lib/meridian/access";
import type { Cookbook } from "@/lib/meridian/cookbooks/schema";
import { defaultsOf, type ControlValue } from "@/lib/meridian/cookbooks/controls";
import { forkCookbookAction, listCookbookVersionsAction, listCookbooksAction, readCookbookAction } from "@/lib/meridian/cookbooks/actions";
import { useBrandQuery } from "@/lib/query/hooks";
import { familiesIn, filterCards, NO_FILTER, type CookbookCard, type LibraryFilter } from "./library-model";
import { SettingsPanel } from "./settings-panel";
import { settingRows } from "./settings-model";

type Library = { state: "loading" } | { state: "error"; reason: string } | { state: "ready"; cards: CookbookCard[] };

export function CookbookLibraryScreen({ brandId }: { brandId: string }) {
  const brand = useBrandQuery(brandId);
  const role = brand.data?.identity.role ?? null;
  const [library, setLibrary] = useState<Library>({ state: "loading" });
  const [filter, setFilter] = useState<LibraryFilter>(NO_FILTER);
  const [selected, setSelected] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLibrary({ state: "loading" });
    (async () => {
      try {
        const outcome = await listCookbooksAction({ data: { brandId } });
        if (cancelled) return;
        setLibrary({ state: "ready", cards: outcome.cards });
      } catch (caught) {
        if (!cancelled) setLibrary({ state: "error", reason: caught instanceof Error ? caught.message : "The cookbooks could not be read." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [brandId, reload]);

  const cards = useMemo(
    () => (library.state === "ready" ? filterCards(library.cards, filter) : []),
    [library, filter],
  );
  const families = useMemo(() => (library.state === "ready" ? familiesIn(library.cards) : []), [library]);

  if (library.state === "error") return <p role="alert" className="text-sm text-danger">The cookbooks could not be loaded: {library.reason}</p>;
  if (library.state === "loading") return <ScreenSkeleton label="Loading cookbooks" shape="rows" />;

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-title font-semibold text-fg-primary">Cookbooks</h1>
        <p className="max-w-2xl text-small text-fg-secondary">
          A cookbook is a recipe for a video: its steps, the instructions for each part, and the settings you can change. Free cookbooks run in agent mode with no provider call.
        </p>
      </header>

      <section aria-labelledby="cookbook-filters" className="flex flex-wrap items-end gap-4">
        <h2 id="cookbook-filters" className="sr-only">Filter the cookbooks</h2>
        <label className="flex flex-col gap-1.5 text-small">
          <span className="font-medium text-fg-primary">Family</span>
          <SelectInput
            className="w-56"
            value={filter.family}
            onChange={(event) => setFilter({ ...filter, family: event.target.value as LibraryFilter["family"] })}
          >
            <option value="all">All families</option>
            {families.map((family) => (
              <option key={family} value={family}>
                {family}
              </option>
            ))}
          </SelectInput>
        </label>
        <Switch label="Free in agent mode only" checked={filter.freeOnly} onCheckedChange={(checked) => setFilter({ ...filter, freeOnly: checked })} />
      </section>

      {cards.length === 0 ? (
        <p className="text-small text-fg-muted">No cookbook matches these filters.</p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Cookbooks">
          {cards.map((card) => (
            <li key={`${card.source}:${card.cookbookId}`}>
              <CookbookCardButton card={card} selected={selected === card.cookbookId} onOpen={() => setSelected(card.cookbookId)} />
            </li>
          ))}
        </ul>
      )}

      {selected !== null ? (
        <CookbookDetail
          key={selected}
          brandId={brandId}
          cookbookId={selected}
          canCopy={role !== null && hasRole(role, "member")}
          onCopied={() => setReload((count) => count + 1)}
        />
      ) : null}
    </div>
  );
}

const CHIP = "inline-flex min-h-6 items-center rounded-full border border-hairline px-2 text-caption text-fg-secondary";

/**
 * One cookbook as a card: the family above the name, a two-line summary, then its facts as chips at the foot, so a grid of cards reads as
 * names and chips rather than six stacked lines each. The open one takes the ink border, as every chosen option does.
 */
function CookbookCardButton({ card, selected, onOpen }: { card: CookbookCard; selected: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onOpen}
      className="flex h-full w-full flex-col gap-2 rounded-sharp border-2 border-hairline bg-raised p-4 text-left transition-colors hover:border-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent aria-pressed:border-fg-primary aria-pressed:bg-overlay sm:p-5"
    >
      <span className="eyebrow">{card.family}</span>
      <span className="text-heading font-semibold text-fg-primary">{card.label}</span>
      <span className="line-clamp-2 text-small text-fg-secondary">{card.summary}</span>
      {card.unresolved !== null ? <span className="text-small text-danger">{card.unresolved}</span> : null}
      <span className="mt-auto flex flex-wrap items-center gap-2 pt-2">
        <span className={card.freeInAgentMode ? "inline-flex min-h-6 items-center rounded-full bg-white-accent px-2 text-caption font-semibold text-ground" : `${CHIP} font-medium text-fg-primary`}>{card.badge}</span>
        <span className={CHIP}>{card.source === "builtin" ? "Built in" : "Yours"}</span>
        <span className="text-caption text-fg-muted">{card.estimate}</span>
      </span>
    </button>
  );
}

function CookbookDetail({
  brandId,
  cookbookId,
  canCopy,
  onCopied,
}: {
  brandId: string;
  cookbookId: string;
  canCopy: boolean;
  onCopied: () => void;
}) {
  const [state, setState] = useState<{ state: "loading" } | { state: "error"; reason: string } | { state: "ready"; cookbook: Cookbook; source: "builtin" | "workspace" }>({
    state: "loading",
  });
  const [values, setValues] = useState<Record<string, ControlValue>>({});
  const [copyName, setCopyName] = useState("");
  const [share, setShare] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const outcome = await readCookbookAction({ data: { brandId, cookbookId } });
        if (cancelled) return;
        if (!outcome.ok) {
          setState({ state: "error", reason: outcome.reason });
          return;
        }
        setValues(defaultsOf(outcome.value.cookbook.controls));
        setState({ state: "ready", cookbook: outcome.value.cookbook, source: outcome.value.source });
      } catch (caught) {
        if (!cancelled) setState({ state: "error", reason: caught instanceof Error ? caught.message : "The cookbook could not be read." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [brandId, cookbookId]);

  if (state.state === "error") return <p role="alert" className="text-small text-danger">{state.reason}</p>;
  if (state.state === "loading") return <p className="text-small text-fg-muted">Reading this cookbook…</p>;

  const cookbook = state.cookbook;
  const rows = settingRows(cookbook, values);

  const copy = async () => {
    const name = copyName.trim();
    if (name === "") {
      toast.error("Give your copy a name first.");
      return;
    }
    setBusy(true);
    try {
      const newCookbookId = `ck_my_${Date.now().toString(36)}`;
      const outcome = await forkCookbookAction({ data: { brandId, cookbookId, version: cookbook.version, newCookbookId, shareWithWorkspace: share } });
      if (outcome.ok) {
        toast.success(`Saved as "${name}".`);
        setCopyName("");
        onCopied();
      } else {
        toast.error(outcome.reason);
      }
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "The copy was not saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="cookbook-detail-title" className="surface-tile space-y-6 border border-hairline p-4 sm:p-6">
      <header className="space-y-2">
        <h2 id="cookbook-detail-title" className="text-section font-semibold text-fg-primary">{cookbook.label}</h2>
        <p className="text-small text-fg-secondary">{cookbook.summary}</p>
        <p className="flex flex-wrap gap-2">
          <span className={CHIP}>Version {cookbook.version}</span>
          <span className={CHIP}>{state.source === "builtin" ? "Built in" : "Made in this workspace"}</span>
        </p>
      </header>

      <div className="space-y-2">
        <Link to="/brands/$brandId/content" params={{ brandId }} search={{ section: "create" }} className="inline-flex min-h-10 items-center rounded-full bg-white-accent px-4 text-button font-semibold text-ground hover:bg-fg-secondary">
          Make a video with this cookbook
        </Link>
        <p className="text-caption text-fg-muted">Create's Cookbook step offers it, with the settings below as its defaults.</p>
      </div>

      <div className="space-y-3">
        <h3 className="text-small font-semibold text-fg-primary">Settings</h3>
        {rows.length === 0 ? <p className="text-small text-fg-muted">This cookbook has no settings.</p> : <SettingsPanel rows={rows} onChange={(id, value) => setValues((current) => ({ ...current, [id]: value }))} />}
      </div>

      <VersionHistory brandId={brandId} cookbookId={cookbookId} source={state.source} current={cookbook.version} />

      {canCopy ? (
        <div className="space-y-3 border-t border-hairline pt-4">
          <h3 className="text-small font-semibold text-fg-primary">Save as my cookbook</h3>
          <p className="text-small text-fg-muted">A copy is yours to edit. It keeps a link to this cookbook.</p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-64">
              <Input label="Name" value={copyName} onChange={(event) => setCopyName(event.target.value)} maxLength={80} />
            </div>
            <label className="flex min-h-10 items-center gap-2 text-small text-fg-primary">
              <input type="checkbox" checked={share} onChange={(event) => setShare(event.target.checked)} />
              Share with the whole workspace
            </label>
            <Button type="button" variant="secondary" loading={busy} disabled={busy} onClick={() => void copy()}>
              Save as my cookbook
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

type VersionRow = { version: number; createdAt: string; archived: boolean };

function VersionHistory({ brandId, cookbookId, source, current }: { brandId: string; cookbookId: string; source: "builtin" | "workspace"; current: number }) {
  const [state, setState] = useState<{ state: "loading" } | { state: "error"; reason: string } | { state: "ready"; versions: VersionRow[] }>({ state: "loading" });

  useEffect(() => {
    if (source === "builtin") return;
    let cancelled = false;
    (async () => {
      try {
        const outcome = await listCookbookVersionsAction({ data: { brandId, cookbookId } });
        if (cancelled) return;
        setState(outcome.ok ? { state: "ready", versions: outcome.value } : { state: "error", reason: outcome.reason });
      } catch (caught) {
        if (!cancelled) setState({ state: "error", reason: caught instanceof Error ? caught.message : "The versions could not be read." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [brandId, cookbookId, source]);

  return (
    <div className="space-y-2">
      <h3 className="text-small font-semibold text-fg-primary">Versions</h3>
      {source === "builtin" ? (
        <p className="text-small text-fg-muted">A built-in cookbook is versioned with the app. This is version {current}.</p>
      ) : state.state === "loading" ? (
        <p className="text-small text-fg-muted">Reading the versions…</p>
      ) : state.state === "error" ? (
        <p role="alert" className="text-small text-danger">{state.reason}</p>
      ) : (
        <ol className="list-decimal space-y-1 pl-5 text-small text-fg-primary">
          {state.versions.map((row) => (
            <li key={row.version}>
              Version {row.version}, written {new Date(row.createdAt).toLocaleDateString()}
              {row.archived ? " (archived)" : ""}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
