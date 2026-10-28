import { useEffect, useRef, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { Button, ErrorState, Field, Input } from "@/components/ui";
import { PlainErrorMessage } from "@/components/plain-error";
import { plainError } from "@/lib/copy";
import { qk } from "@/lib/query/keys";
import { useDecisionEnginesQuery, useProviderSettingsQuery, useScopedMutation, useVideoBudgetQuery } from "@/lib/query/hooks";
import { removeProviderConfig, saveProviderConfig, saveVideoBudget, testProviderConnection } from "@/lib/meridian/settings/server-actions";
import { keyOwnerNote, splitOperatorHint } from "./key-copy";
import { OperatorVariables } from "./operator-note";
import { parseMonthlyVideoBudget } from "@/lib/meridian/settings/video-budget-model";
import type { ProviderCategory, ProviderConfigSummary } from "@/lib/meridian/settings/provider-config";
import {
  rowsIn,
  setupHeadline,
  setupRows,
  SETUP_GROUPS,
  type SetupEngines,
  type SetupGroup,
  type SetupRow,
  type SetupStatus,
} from "./setup-model";

const STATUS_PRESENTATION: Record<SetupStatus, { label: string; className: string }> = {
  usable: { label: "Saved, not checked live", className: "bg-success-soft text-success" },
  deployment_shared_default: { label: "Deployment shared default", className: "bg-info-soft text-info" },
  unusable: { label: "Unusable", className: "bg-danger-soft text-danger" },
  not_configured: { label: "Not configured", className: "bg-surface-2 text-fg-muted" },
};

interface SetupPanelProps {
  organizationId: string;
  canAdmin: boolean;
}

/**
 * The guided Setup view. Each provider row shows its real state from the server's resolver, the reason, and a masked
 * fingerprint when a key is saved. A row that accepts a key has a form that saves through the admin-only server path. The
 * server checks the role again, so the disabled controls here are only a convenience.
 */
export function SetupPanel({ organizationId, canAdmin }: SetupPanelProps) {
  const providers = useProviderSettingsQuery(organizationId);
  const engines = useDecisionEnginesQuery(organizationId);
  const summaries = (providers.data as Record<ProviderCategory, ProviderConfigSummary> | undefined) ?? null;
  const engineStatus = (engines.data as SetupEngines | undefined) ?? null;

  if ((providers.isError && !summaries) || (engines.isError && !engineStatus)) {
    return (
      <ErrorState
        message="The setup status could not be loaded. Nothing is assumed to be configured."
        onRetry={() => {
          void providers.refetch();
          void engines.refetch();
        }}
      />
    );
  }
  if (!summaries || !engineStatus) {
    return <p className="text-sm text-fg-muted">Loading setup status...</p>;
  }

  const rows = setupRows({ summaries, engines: engineStatus });

  return (
    <section aria-labelledby="setup-title" className="space-y-6 panel">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="setup-title" className="text-section font-semibold text-fg">Setup</h2>
          <Button asChild variant="secondary"><Link to="/setup">Open the guided setup</Link></Button>
        </div>
        <p className="text-sm text-fg-muted">
          Each row is the server&apos;s own state for that provider, with the reason. A key is saved here, encrypted, and is never
          shown again. Saving a key needs TOKEN_ENCRYPTION_KEY on the server; <code className="font-mono text-xs">npm run setup</code>{" "}
          generates it for a local install.
        </p>
        <p className="text-sm font-semibold text-fg">{setupHeadline(rows)}</p>
        {!canAdmin ? <p className="text-sm text-fg-muted">Only a workspace admin can save or remove a key. Everyone can read these states.</p> : null}
      </div>

      {SETUP_GROUPS.filter((group) => group.id !== "other_sources").map((group) => (
        <GroupBlock key={group.id} group={group.id} label={group.label} hint={group.hint} rows={rowsIn(rows, group.id)} organizationId={organizationId} canAdmin={canAdmin} />
      ))}

      <details className="border-t border-border pt-4">
        <summary className="cursor-pointer text-sm font-semibold text-fg">
          Other source connectors ({rowsIn(rows, "other_sources").length})
        </summary>
        <div className="mt-4 space-y-4">
          <p className="text-sm text-fg-muted">{SETUP_GROUPS.find((group) => group.id === "other_sources")?.hint}</p>
          <ul className="space-y-3">
            {rowsIn(rows, "other_sources").map((row) => (
              <SetupRowItem key={row.id} row={row} organizationId={organizationId} canAdmin={canAdmin} />
            ))}
          </ul>
        </div>
      </details>
    </section>
  );
}

function GroupBlock({
  group,
  label,
  hint,
  rows,
  organizationId,
  canAdmin,
}: {
  group: SetupGroup;
  label: string;
  hint: string;
  rows: SetupRow[];
  organizationId: string;
  canAdmin: boolean;
}) {
  return (
    <div className="space-y-3" data-group={group}>
      <div>
        <h3 className="text-sm font-semibold text-fg-muted">{label}</h3>
        <p className="text-sm text-fg-muted">{hint}</p>
      </div>
      <ul className="space-y-3">
        {rows.map((row) => (
          <SetupRowItem key={row.id} row={row} organizationId={organizationId} canAdmin={canAdmin} />
        ))}
      </ul>
    </div>
  );
}

/**
 * The workspace's "Monthly video budget (USD)". Blank means no budget is set; there is no default. Only an admin can change
 * it, and the server checks the role again.
 */
export function VideoBudgetForm({ organizationId, canAdmin }: { organizationId: string; canAdmin: boolean }) {
  const budget = useVideoBudgetQuery(organizationId);
  const saved = budget.data?.monthlyVideoBudgetUsd ?? null;
  const [draft, setDraft] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const save = useScopedMutation({
    mutationKey: ["mutation", "settings.video-budget.save", organizationId],
    mutationFn: (value: string) => saveVideoBudget({ data: { organizationId, monthlyVideoBudgetUsd: value } }),
    invalidate: () => [qk.videoBudget(organizationId)],
    onSuccess: (result) => {
      setDraft(null);
      setMessage(result.monthlyVideoBudgetUsd === null ? "Monthly budget cleared. No budget is set." : "Monthly budget saved.");
    },
  });

  const inputRef = useRef<HTMLInputElement>(null);
  // A blocker elsewhere links here with #monthly-budget. Read the router's location as well as the browser URL:
  // client-side navigation uses history.pushState, which does not dispatch a native hashchange event.
  const routeHash = useRouterState({ select: (state) => state.location.hash });
  useEffect(() => {
    const hash = routeHash.replace(/^#/, "");
    if (hash !== "monthly-budget" && window.location.hash !== "#monthly-budget") return;
    // Let the destination commit before focusing; the input can initially be disabled while its saved value loads.
    const frame = window.requestAnimationFrame(() => {
      const field = inputRef.current;
      if (!field) return;
      field.scrollIntoView({ block: "center" });
      field.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [budget.isPending, routeHash]);

  const shown = draft ?? (saved === null ? "" : saved.toFixed(2));
  const parsed = parseMonthlyVideoBudget(shown);
  const failure = save.error ? plainError(save.error) : null;
  const current = budget.isError
    ? "The budget could not be loaded. Nothing is assumed."
    : budget.isPending
      ? "Loading the budget..."
      : saved === null
        ? "No budget is set."
        : `The budget is ${saved.toFixed(2)} USD a month.`;

  return (
    <div id="monthly-budget" className="scroll-mt-24 space-y-3 border-t border-border pt-4" data-row="monthly_video_budget">
      <div className="space-y-1">
        <p className="font-semibold text-fg">Monthly budget (USD)</p>
        <p className="text-sm text-fg-muted">
          This workspace's hard monthly cap, in US dollars, on all paid generation together: video, copy and scripts,
          research analysis, brand brain suggestions, Factory image labels and OpenRouter decisions. It is a limit Meridian
          enforces, not your OpenRouter account balance. Blank means no budget is set, so paid generation, and the
          OpenRouter connection test, are blocked until one is saved. Each call is also capped on its own. There is no
          default. {current}
        </p>
      </div>
      {!canAdmin ? (
        <p className="text-sm text-fg-muted">Only a workspace admin can change the budget.</p>
      ) : (
        <>
          {failure ? <PlainErrorMessage message={failure.message} raw={failure.raw} /> : null}
          {message ? <p className="text-sm text-success" role="status">{message}</p> : null}
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!parsed.ok || save.isPending || budget.isPending) return;
              setMessage(null);
              void save.mutateAsync(shown).catch(() => undefined);
            }}
          >
            <div className="min-w-0 flex-1 basis-full sm:min-w-[16rem] sm:basis-auto">
              <Field
                label="Monthly budget (USD)"
                hint="A number of 0 or more, with at most two decimals. Leave blank for no budget."
                error={parsed.ok ? undefined : parsed.message}
              >
                <Input
                  ref={inputRef}
                  inputMode="decimal"
                  value={shown}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="No budget set"
                  disabled={save.isPending || budget.isPending || budget.isError}
                />
              </Field>
            </div>
            <Button type="submit" variant="secondary" disabled={!parsed.ok || draft === null || save.isPending || budget.isPending}>
              {save.isPending ? "Saving..." : "Save budget"}
            </Button>
          </form>
        </>
      )}
    </div>
  );
}

/**
 * Check key for a row that offers it. The server reads the key through the resolver and calls no provider, so the answer says
 * the key is readable (CONFIGURED). It is never shown as a provider connection; only READY would be, and no Setup check returns it.
 */
export function TestConnection({
  row,
  organizationId,
  onAnswer,
}: {
  row: SetupRow;
  organizationId: string;
  /** Told each answer, so a parent can show the row's Configured reading. The answer is kept for this session only. */
  onAnswer?: (answer: { status: string }) => void;
}) {
  const [result, setResult] = useState<{ status: string; message: string } | null>(null);
  const test = useScopedMutation({
    mutationKey: ["mutation", "setup.key.test", organizationId, row.id],
    mutationFn: () => testProviderConnection({ data: { organizationId, category: row.id as ProviderCategory } }),
  });
  const tone = result?.status === "CONFIGURED" || result?.status === "READY" ? "text-success" : result?.status === "NOT_TESTABLE" ? "text-fg-muted" : "text-danger";
  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="quiet"
        disabled={test.isPending}
        onClick={() => {
          setResult(null);
          void test.mutateAsync(undefined).then(
            (answer) => {
              setResult(answer);
              onAnswer?.({ status: answer.status });
            },
            (error: unknown) => {
              setResult({ status: "ERROR", message: error instanceof Error ? error.message : "The test could not run." });
              onAnswer?.({ status: "ERROR" });
            },
          );
        }}
      >
        {test.isPending ? "Checking..." : "Check key"}
        <span className="sr-only"> for {row.label}</span>
      </Button>
      {result ? (
        <p className={`text-sm ${tone} [overflow-wrap:anywhere]`} role="status">
          <strong>{result.status === "NOT_TESTABLE" ? "Not testable here" : result.status}</strong>: {result.message}
        </p>
      ) : null}
    </div>
  );
}

function SetupRowItem({ row, organizationId, canAdmin }: { row: SetupRow; organizationId: string; canAdmin: boolean }) {
  const presentation = STATUS_PRESENTATION[row.status];
  const reason = splitOperatorHint(row.reason);
  return (
    <li className="space-y-3 border-t border-border py-4 first:border-t-0 first:pt-0" data-row={row.id}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-semibold text-fg">{row.label}</p>
          <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">{reason.plain}</p>
          {reason.operator ? (
            <details className="text-xs text-fg-muted">
              <summary className="cursor-pointer">For whoever runs the server</summary>
              <p className="mt-1 font-mono [overflow-wrap:anywhere]">{reason.operator}</p>
            </details>
          ) : null}
          {row.save.kind === "form" ? <p className="text-xs text-fg-muted">{keyOwnerNote(row.label)}</p> : null}
          {row.fingerprint ? (
            <p className="font-mono text-xs text-fg-muted">Stored key: {row.fingerprint}</p>
          ) : null}
          {row.note ? <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">{row.note}</p> : null}
        </div>
        <span className={`shrink-0 rounded px-2 py-0.5 text-xs font-semibold ${presentation.className}`} aria-label={`${row.label}: ${presentation.label}`}>
          {presentation.label}
        </span>
      </div>
      <RowAction row={row} organizationId={organizationId} canAdmin={canAdmin} />
      {row.testable && canAdmin ? <TestConnection row={row} organizationId={organizationId} /> : null}
    </li>
  );
}

/** What a row can do. A keyed row has a form. A deployment or engine row says where its setting is, and has no button. */
function RowAction({ row, organizationId, canAdmin }: { row: SetupRow; organizationId: string; canAdmin: boolean }) {
  if (row.save.kind === "engine") {
    return (
      <p className="text-sm text-fg-muted">
        This row cannot change the engine. Choose it in <strong className="text-fg">Decision engine</strong>, on the TypeSafe JEV tab of
        the provider settings below.
      </p>
    );
  }
  if (row.save.kind === "deployment") {
    return (
      <OperatorVariables names={row.save.variables} lead="This is set on the server. This panel cannot save it." />
    );
  }
  return <KeyForm row={row} organizationId={organizationId} canAdmin={canAdmin} category={row.save.category} />;
}

/**
 * The key form for one provider. The key is sent once and cleared. The field is never filled from the server, because a key
 * is never sent back. A save without a key is not offered, so the stored key is never replaced by an empty one.
 */
export function KeyForm({ row, organizationId, canAdmin, category }: { row: Pick<SetupRow, "label" | "fingerprint" | "removable">; organizationId: string; canAdmin: boolean; category: string }) {
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const invalidate = () => [qk.providerSettings(organizationId), qk.decisionEngines(organizationId), qk.integrations(organizationId)];
  const save = useScopedMutation({
    mutationKey: ["mutation", "setup.key.save", organizationId, category],
    mutationFn: (apiKey: string) => saveProviderConfig({ data: { organizationId, category: category as ProviderCategory, credentials: { apiKey } } }),
    invalidate,
    onSuccess: () => {
      setDraft("");
      setMessage(`${row.label} key saved. The key is not shown again; only its last four characters are.`);
    },
  });
  const remove = useScopedMutation({
    mutationKey: ["mutation", "setup.key.remove", organizationId, category],
    mutationFn: () => removeProviderConfig({ data: { organizationId, category: category as ProviderCategory } }),
    invalidate,
    onSuccess: () => setMessage(`${row.label} saved key removed.`),
  });

  const busy = save.isPending || remove.isPending;
  const failure = [save.error, remove.error].find(Boolean);
  const error = failure ? plainError(failure) : null;
  const trimmed = draft.trim();

  if (!canAdmin) {
    return <p className="text-sm text-fg-muted">Only a workspace admin can save this key.</p>;
  }

  return (
    <div className="space-y-3">
      {error ? <PlainErrorMessage message={error.message} raw={error.raw} /> : null}
      {message ? <p className="text-sm text-success" role="status">{message}</p> : null}
      <form
        className="flex flex-wrap items-end gap-3"
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          if (!trimmed || busy) return;
          setMessage(null);
          void save.mutateAsync(trimmed).catch(() => undefined);
        }}
      >
        <div className="min-w-0 flex-1 basis-full sm:min-w-[16rem] sm:basis-auto">
          <Field label={`${row.label} key`} hint="Paste it and press Enter. It is stored encrypted and is not shown again.">
            <Input
              type="password"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={row.fingerprint ? "Enter a new key to replace the saved one" : "Enter the key"}
              autoComplete="new-password"
              spellCheck={false}
              disabled={busy}
            />
          </Field>
        </div>
        <Button type="submit" variant="secondary" disabled={!trimmed || busy}>
          {save.isPending ? "Saving..." : row.fingerprint ? "Replace key" : "Save key"}
        </Button>
        {row.removable ? (
          <Button type="button" variant="quiet" disabled={busy} onClick={() => { setMessage(null); void remove.mutateAsync().catch(() => undefined); }}>
            {remove.isPending ? "Removing..." : "Remove saved key"}
          </Button>
        ) : null}
      </form>
    </div>
  );
}
