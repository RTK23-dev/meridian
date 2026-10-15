import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Badge, Button, Card, Dialog, DialogContent, DialogDescription, DialogTitle, DisabledReason, EmptyState, ErrorNotice, Field, Input, ScreenSkeleton, SelectInput } from "@/components/ui";
import { PlainErrorState } from "@/components/plain-error";
import { useThemePagesQuery, usePlatformAccountsQuery, useScopedMutation } from "@/lib/query/hooks";
import { qk } from "@/lib/query/keys";
import { archiveThemePageAction, createThemePageAction, updateThemePageAction } from "@/lib/meridian/pages/actions";
import { PAGE_PLATFORMS, WEEKDAYS, type PagePlatform, type Weekday } from "@/lib/meridian/pages/model";
import type { ThemePageView } from "@/lib/meridian/pages/store";
import { useWorkspace } from "@/components/workspace";
import { hasRole } from "@/lib/meridian/access";

export const Route = createFileRoute("/_app/brands/$brandId/pages")({ staticData: { pageTitle: "Theme pages" },
  component: Page,
});

function Page() {
  const { brandId } = Route.useParams();
  return <BrandPages brandId={brandId} />;
}

const PLATFORM_LABELS: Record<PagePlatform, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  youtube: "YouTube Shorts",
  tiktok: "TikTok",
};

const WEEKDAY_LABELS: Record<Weekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

type Graduation = "MANUAL" | "SS_PERFORMANCE";

/** The form as typed. Times are typed per weekday as HH:MM, separated by commas. Empty text is unknown, and it is sent as null. */
type Draft = {
  name: string;
  niche: string;
  platform: PagePlatform;
  platformAccountId: string;
  personaKitId: string;
  voiceKitId: string;
  styleKitId: string;
  postingTimeZone: string;
  times: Record<Weekday, string>;
  trialFirst: boolean;
  trialGraduation: "" | Graduation;
  status: "active" | "paused";
};

function blankTimes(): Record<Weekday, string> {
  return { mon: "", tue: "", wed: "", thu: "", fri: "", sat: "", sun: "" };
}

const BLANK_DRAFT: Draft = {
  name: "",
  niche: "",
  platform: "instagram",
  platformAccountId: "",
  personaKitId: "",
  voiceKitId: "",
  styleKitId: "",
  postingTimeZone: "",
  times: blankTimes(),
  trialFirst: false,
  trialGraduation: "",
  status: "active",
};

function draftOf(page: ThemePageView): Draft {
  const times = blankTimes();
  for (const day of WEEKDAYS) times[day] = (page.postingTimes?.[day] ?? []).join(", ");
  return {
    name: page.name,
    niche: page.niche ?? "",
    platform: page.platform,
    platformAccountId: page.platformAccountId ?? "",
    personaKitId: page.personaKitId ?? "",
    voiceKitId: page.voiceKitId ?? "",
    styleKitId: page.styleKitId ?? "",
    postingTimeZone: page.postingTimeZone ?? "",
    times,
    trialFirst: page.trialFirst,
    trialGraduation: page.trialGraduation ?? "",
    status: page.status === "paused" ? "paused" : "active",
  };
}

/** What the server receives. Empty text is null, so an unset field stays unknown rather than blank. */
function payloadOf(draft: Draft) {
  const postingTimes: Record<string, string[]> = {};
  for (const day of WEEKDAYS) {
    const list = draft.times[day].split(",").map((item) => item.trim()).filter((item) => item !== "");
    if (list.length > 0) postingTimes[day] = list;
  }
  return {
    name: draft.name,
    niche: draft.niche.trim() === "" ? null : draft.niche,
    platform: draft.platform,
    platformAccountId: draft.platformAccountId || null,
    personaKitId: draft.personaKitId.trim() || null,
    voiceKitId: draft.voiceKitId.trim() || null,
    styleKitId: draft.styleKitId.trim() || null,
    postingTimeZone: draft.postingTimeZone.trim() || null,
    postingTimes,
    trialFirst: draft.trialFirst,
    trialGraduation: draft.trialGraduation || null,
    status: draft.status,
  };
}

function scheduleText(page: ThemePageView): string {
  if (!page.postingTimes) return "No schedule set";
  const days = WEEKDAYS.filter((day) => (page.postingTimes?.[day] ?? []).length > 0)
    .map((day) => `${WEEKDAY_LABELS[day].slice(0, 3)} ${(page.postingTimes?.[day] ?? []).join(", ")}`);
  return `${days.join(" · ")} (${page.postingTimeZone ?? "no time zone"})`;
}

function trialText(page: ThemePageView): string {
  if (!page.trialFirst || !page.trialGraduation) return "Off. Posts publish as ordinary posts.";
  return `Trial first, graduation ${page.trialGraduation}`;
}

function BrandPages({ brandId }: { brandId: string }) {
  const { data: workspace } = useWorkspace();
  const role = workspace?.active?.role || "viewer";
  const canEdit = hasRole(role, "member");
  const canAdmin = hasRole(role, "admin");

  const query = useThemePagesQuery(brandId);
  const pages = query.data ?? [];
  const accountsQuery = usePlatformAccountsQuery(brandId);
  const accounts = accountsQuery.data ?? [];

  // "new" opens the create dialog. A page id opens the edit dialog. Null means closed.
  const [dialogTarget, setDialogTarget] = useState<"new" | string | null>(null);
  const [draft, setDraft] = useState<Draft>(BLANK_DRAFT);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const createPage = useScopedMutation({
    mutationKey: ["mutation", "pages.create", brandId],
    mutationFn: (page: ReturnType<typeof payloadOf>) => createThemePageAction({ data: { brandId, page } }),
    invalidate: () => [qk.pages(brandId)],
    success: "Page created.",
  });
  const updatePage = useScopedMutation({
    mutationKey: ["mutation", "pages.update", brandId],
    mutationFn: (vars: { pageId: string; page: ReturnType<typeof payloadOf> }) =>
      updateThemePageAction({ data: { brandId, pageId: vars.pageId, page: vars.page } }),
    invalidate: () => [qk.pages(brandId)],
    success: "Page saved.",
  });
  const archivePage = useScopedMutation({
    mutationKey: ["mutation", "pages.archive", brandId],
    mutationFn: (pageId: string) => archiveThemePageAction({ data: { brandId, pageId } }),
    invalidate: () => [qk.pages(brandId)],
    success: "Page archived.",
  });

  const openNew = () => {
    setErrorMessage(null);
    setDraft(BLANK_DRAFT);
    setDialogTarget("new");
  };
  const openEdit = (page: ThemePageView) => {
    setErrorMessage(null);
    setDraft(draftOf(page));
    setDialogTarget(page.id);
  };

  const save = async () => {
    setErrorMessage(null);
    const payload = payloadOf(draft);
    try {
      if (dialogTarget === "new") await createPage.mutateAsync(payload);
      else if (dialogTarget) await updatePage.mutateAsync({ pageId: dialogTarget, page: payload });
      setDialogTarget(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "The page could not be saved.");
    }
  };

  const handleArchive = async (page: ThemePageView) => {
    const confirmed = window.confirm(`Archive ${page.name}? It stops being listed and cannot be run. Runs that already used it keep their link.`);
    if (!confirmed) return;
    await archivePage.mutateAsync(page.id).catch(() => undefined);
  };

  const setTime = (day: Weekday, value: string) => setDraft((current) => ({ ...current, times: { ...current.times, [day]: value } }));
  const accountOptions = accounts.filter((account) => account.platform === draft.platform);
  const saving = createPage.isPending || updatePage.isPending;

  if (query.isError && !query.data) {
    return <PlainErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="max-w-2xl space-y-2">
          <p className="eyebrow">Theme pages</p>
          <h1 className="page-title">Pages this brand publishes from</h1>
          <p className="text-muted">
            A page holds the persona, voice and style kits its content uses, the account it posts to, its posting schedule, and whether its
            Instagram posts start as a trial reel. A run that names a page uses these. Nothing is guessed for a field left empty.
          </p>
        </div>
        {canEdit ? (
          <Button type="button" variant={pages.length === 0 ? "secondary" : "primary"} onClick={openNew}>
            New page
          </Button>
        ) : null}
      </div>

      {query.isPending && !query.data ? (
        <ScreenSkeleton label="Loading pages" shape="rows" />
      ) : pages.length === 0 ? (
        <EmptyState
          title="No theme pages yet"
          reason="Create a page to give a run its persona, voice, style, account, schedule and trial default. A run without a page keeps its own settings."
          action={canEdit ? <Button type="button" onClick={openNew}>Create first page</Button> : undefined}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {pages.map((page) => (
            <Card key={page.id} className="flex flex-col justify-between p-5 space-y-4">
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="eyebrow">{PLATFORM_LABELS[page.platform]}</span>
                  <Badge variant={page.status === "active" ? "success" : "neutral"}>{page.status}</Badge>
                </div>
                <h3 className="text-xl">{page.name}</h3>
                {page.niche ? <p className="text-sm text-muted">{page.niche}</p> : null}
                <dl className="space-y-1 text-sm">
                  <div>
                    <dt className="text-muted">Account</dt>
                    <dd>{page.platformAccount ? `${page.platformAccount.name} (${page.platformAccount.status || "status unknown"})` : "Not linked"}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">Kits</dt>
                    <dd>
                      Persona {page.personaKitId ?? "not set"} · Voice {page.voiceKitId ?? "not set"} · Style {page.styleKitId ?? "not set"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">Schedule</dt>
                    <dd>{scheduleText(page)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">Instagram trial</dt>
                    <dd>{trialText(page)}</dd>
                  </div>
                </dl>
              </div>
              {canEdit ? (
                <div className="flex items-center justify-end gap-2 border-t border-line pt-3">
                  {canAdmin ? (
                    <Button type="button" variant="quiet" disabled={archivePage.isPending} onClick={() => void handleArchive(page)}>
                      Archive
                    </Button>
                  ) : null}
                  <Button type="button" variant="secondary" onClick={() => openEdit(page)}>
                    Edit
                  </Button>
                </div>
              ) : null}
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogTarget !== null} onOpenChange={(open) => { if (!open && !saving) setDialogTarget(null); }}>
        <DialogContent aria-describedby="theme-page-description" className="max-h-[90vh] overflow-y-auto">
          <DialogTitle>{dialogTarget === "new" ? "New theme page" : "Edit theme page"}</DialogTitle>
          <DialogDescription id="theme-page-description">
            Kit ids are the ids of the persona, voice and style kits in this workspace. A kit or account that is not here is refused when you save.
          </DialogDescription>

          <form className="mt-4 space-y-4" noValidate onSubmit={(event) => { event.preventDefault(); void save(); }}>
            {errorMessage ? <ErrorNotice>{errorMessage}</ErrorNotice> : null}

            <Field label="Page name" required>
              <Input value={draft.name} maxLength={80} required onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </Field>
            <Field label="Niche" hint="Optional. Left empty, the niche is unknown.">
              <Input value={draft.niche} maxLength={80} onChange={(event) => setDraft({ ...draft, niche: event.target.value })} />
            </Field>
            <Field label="Platform">
              <SelectInput value={draft.platform} onChange={(event) => setDraft({ ...draft, platform: event.target.value as PagePlatform, platformAccountId: "" })}>
                {PAGE_PLATFORMS.map((platform) => (
                  <option key={platform} value={platform}>{PLATFORM_LABELS[platform]}</option>
                ))}
              </SelectInput>
            </Field>
            <Field label="Linked account" hint={accountOptions.length === 0 ? "No account of this platform is connected to the brand. Connect one on Connected accounts." : "The account this page posts to."}>
              <SelectInput value={draft.platformAccountId} onChange={(event) => setDraft({ ...draft, platformAccountId: event.target.value })}>
                <option value="">Not linked</option>
                {accountOptions.map((account) => (
                  <option key={account.id} value={account.id}>{account.name} ({account.status})</option>
                ))}
              </SelectInput>
            </Field>
            <Field label="Persona kit id" hint="Optional.">
              <Input value={draft.personaKitId} maxLength={120} onChange={(event) => setDraft({ ...draft, personaKitId: event.target.value })} />
            </Field>
            <Field label="Voice kit id" hint="Optional.">
              <Input value={draft.voiceKitId} maxLength={120} onChange={(event) => setDraft({ ...draft, voiceKitId: event.target.value })} />
            </Field>
            <Field label="Style kit id" hint="A run needs a style kit to make a video for this page.">
              <Input value={draft.styleKitId} maxLength={120} onChange={(event) => setDraft({ ...draft, styleKitId: event.target.value })} />
            </Field>

            <Field label="Time zone" hint="An IANA name such as Europe/London. Needed when a schedule is set.">
              <Input value={draft.postingTimeZone} maxLength={64} placeholder="Europe/London" onChange={(event) => setDraft({ ...draft, postingTimeZone: event.target.value })} />
            </Field>
            <fieldset className="space-y-2">
              <legend className="text-sm font-semibold">Posting times</legend>
              <p className="text-sm text-muted">Local times as HH:MM, separated by commas. Leave a day empty for no posts that day.</p>
              {WEEKDAYS.map((day) => (
                <Field key={day} label={WEEKDAY_LABELS[day]}>
                  <Input value={draft.times[day]} maxLength={200} placeholder="09:00, 18:30" onChange={(event) => setTime(day, event.target.value)} />
                </Field>
              ))}
            </fieldset>

            <fieldset className="space-y-2 rounded-md border border-line p-3">
              <legend className="text-sm font-semibold">Instagram trial</legend>
              <label className="flex min-h-11 items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-1 size-4 shrink-0"
                  checked={draft.trialFirst}
                  onChange={(event) => setDraft({ ...draft, trialFirst: event.target.checked })}
                />
                <span>Post Instagram Reels as a trial first. A person can still turn it off for one post.</span>
              </label>
              {draft.trialFirst ? (
                <Field label="How the trial graduates" hint="MANUAL: a person graduates the reel in the Instagram app. SS_PERFORMANCE: Instagram graduates it if it performs well.">
                  <SelectInput value={draft.trialGraduation} onChange={(event) => setDraft({ ...draft, trialGraduation: event.target.value as "" | Graduation })}>
                    <option value="">Choose a graduation strategy</option>
                    <option value="MANUAL">MANUAL</option>
                    <option value="SS_PERFORMANCE">SS_PERFORMANCE</option>
                  </SelectInput>
                </Field>
              ) : null}
            </fieldset>

            {dialogTarget !== "new" ? (
              <Field label="Status">
                <SelectInput value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as "active" | "paused" })}>
                  <option value="active">Active</option>
                  <option value="paused">Paused</option>
                </SelectInput>
              </Field>
            ) : null}

            {!canEdit ? <DisabledReason>Your role can view pages but not change them.</DisabledReason> : null}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="quiet" onClick={() => setDialogTarget(null)} disabled={saving}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving || !canEdit}>
                {saving ? "Saving…" : "Save page"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
