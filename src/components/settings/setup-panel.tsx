import { useState } from "react";
import { Button, ErrorState, Field, Input } from "@/components/ui";
import { PlainErrorMessage } from "@/components/plain-error";
import { plainError } from "@/lib/copy";
import { qk } from "@/lib/query/keys";
import { useDecisionEnginesQuery, useProviderSettingsQuery, useScopedMutation } from "@/lib/query/hooks";
import { removeProviderConfig, saveProviderConfig } from "@/lib/meridian/settings/server-actions";
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
  usable: { label: "Usable", className: "bg-success-soft text-success" },
  deployment_shared_default: { label: "Deployment shared default", className: "bg-accent-soft text-accent" },
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
    <section aria-labelledby="setup-title" className="space-y-6 rounded-lg border border-border bg-surface p-5">
      <div className="space-y-2">
        <h2 id="setup-title" className="text-section font-semibold text-fg">Setup</h2>
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

      <details className="rounded border border-border p-4">
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
        <h3 className="text-sm font-semibold uppercase tracking-wide text-fg-muted">{label}</h3>
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

function SetupRowItem({ row, organizationId, canAdmin }: { row: SetupRow; organizationId: string; canAdmin: boolean }) {
  const presentation = STATUS_PRESENTATION[row.status];
  return (
    <li className="space-y-3 rounded border border-border p-4" data-row={row.id}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-semibold text-fg">{row.label}</p>
          <p className="text-sm text-fg-muted">{row.reason}</p>
          {row.fingerprint ? (
            <p className="font-mono text-xs text-fg-muted">Stored key: {row.fingerprint}</p>
          ) : null}
          {row.note ? <p className="text-sm text-fg-muted">{row.note}</p> : null}
        </div>
        <span className={`shrink-0 rounded px-2 py-0.5 text-xs font-semibold ${presentation.className}`} aria-label={`${row.label}: ${presentation.label}`}>
          {presentation.label}
        </span>
      </div>
      <RowAction row={row} organizationId={organizationId} canAdmin={canAdmin} />
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
      <p className="text-sm text-fg-muted">
        Set {row.save.variables.map((name, index) => (
          <span key={name}>
            {index > 0 ? ", " : ""}
            <code className="font-mono text-xs text-fg">{name}</code>
          </span>
        ))} on the server. This panel cannot save them, and no key is shown here.
      </p>
    );
  }
  return <KeyForm row={row} organizationId={organizationId} canAdmin={canAdmin} category={row.save.category} />;
}

/**
 * The key form for one provider. The key is sent once and cleared. The field is never filled from the server, because a key
 * is never sent back. A save without a key is not offered, so the stored key is never replaced by an empty one.
 */
function KeyForm({ row, organizationId, canAdmin, category }: { row: SetupRow; organizationId: string; canAdmin: boolean; category: string }) {
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
        <div className="min-w-[16rem] flex-1">
          <Field label={`${row.label} API key`} hint="Leave blank to keep the saved key. Only an admin can save a key.">
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
        <Button type="submit" disabled={!trimmed || busy}>
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
