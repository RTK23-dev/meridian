import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useWorkspace } from "@/components/workspace";
import { ErrorState, ScreenSkeleton, StatusBadge, errorText } from "@/components/ui";
import { FormError } from "@/components/settings/form-error";
import { plainServerError } from "@/components/settings/form-model";
import { ProviderCard, type CardAction } from "@/components/settings/provider-card";
import {
  INTEGRATION_GROUPS, integrationCards, processRows, publishingLine,
  type CardModel, type ProviderSummaries, type SummaryState, type SystemStatus,
} from "@/components/settings/integration-model";
import { hasRole } from "@/lib/meridian/access";
import { beginOauth } from "@/lib/meridian/oauth/begin";
import { refreshStoredToken } from "@/lib/meridian/oauth/refresh";
import { disconnectProvider, probeProviderConnection, reconnectProvider } from "@/lib/meridian/providers/connect";
import { removeProviderConfig, testProviderConnection } from "@/lib/meridian/settings/server-actions";
import { useIntegrationsQuery, usePendingVariables, useProviderSettingsQuery, useScopedMutation } from "@/lib/query/hooks";
import { qk } from "@/lib/query/keys";

export const Route = createFileRoute("/_app/integrations")({ staticData: { pageTitle: "Integrations" }, component: Page });

type AccountProvider = "meta" | "tiktok" | "google" | "ad_library";
type OAuthProvider = Extract<AccountProvider, "meta" | "tiktok" | "google">;

const OAUTH: ReadonlySet<string> = new Set<OAuthProvider>(["meta", "tiktok", "google"]);

function isOAuthProvider(provider: string): provider is OAuthProvider {
  return OAUTH.has(provider);
}

function Page() {
  return <Integrations />;
}

function Integrations() {
  const { data: workspace } = useWorkspace();
  const organizationId = workspace?.active?.id ?? "";
  const canAdmin = workspace?.active ? hasRole(workspace.active.role, "admin") : false;
  const query = useIntegrationsQuery(organizationId);
  const summaries = useProviderSettingsQuery(organizationId);
  const [note, setNote] = useState<string | null>(null);
  const connectKey = ["mutation", "integrations.connect", organizationId] as const;
  const probeKey = ["mutation", "integrations.probe", organizationId] as const;
  const disconnectKey = ["mutation", "integrations.disconnect", organizationId] as const;
  const refreshKey = ["mutation", "integrations.refresh", organizationId] as const;
  const testKey = ["mutation", "integrations.test-key", organizationId] as const;
  const removeKeyKey = ["mutation", "integrations.remove-key", organizationId] as const;

  // Connecting leaves the page for the provider's consent screen, so it refreshes nothing here.
  const connect = useScopedMutation({
    mutationKey: connectKey,
    mutationFn: (provider: OAuthProvider) => beginOauth({ data: { organizationId, provider, origin: window.location.origin } }),
    onSuccess: (result) => window.location.assign(result.url),
  });
  const probe = useScopedMutation({
    mutationKey: probeKey,
    mutationFn: (vars: { provider: AccountProvider; reconnect: boolean }) => vars.reconnect
      ? reconnectProvider({ data: { organizationId, provider: vars.provider } })
      : probeProviderConnection({ data: { organizationId, provider: vars.provider } }),
    invalidate: () => [qk.integrations(organizationId)],
    onSuccess: (result, vars) => setNote(`${vars.provider}: ${result.phase}. ${result.detail}`),
  });
  const disconnect = useScopedMutation({
    mutationKey: disconnectKey,
    mutationFn: (provider: AccountProvider) => disconnectProvider({ data: { organizationId, provider } }),
    invalidate: () => [qk.integrations(organizationId)],
    success: "Provider disconnected.",
    onSuccess: (result, provider) => setNote(`${provider}: ${result.detail}`),
  });
  const refreshToken = useScopedMutation({
    mutationKey: refreshKey,
    mutationFn: (provider: OAuthProvider) => refreshStoredToken({ data: { organizationId, provider } }),
    invalidate: () => [qk.integrations(organizationId)],
    onSuccess: (result, provider) => setNote(`${provider}: ${result.detail}`),
  });
  // A key test reads the stored credential and changes nothing, so it invalidates nothing.
  const testKeyAction = useScopedMutation({
    mutationKey: testKey,
    mutationFn: () => testProviderConnection({ data: { organizationId, category: "perception" } }),
    onSuccess: (result) => setNote(`Google AI Studio: ${result.status === "READY" ? "ready" : "not ready"}. ${result.message}`),
  });
  const removeKey = useScopedMutation({
    mutationKey: removeKeyKey,
    mutationFn: () => removeProviderConfig({ data: { organizationId, category: "perception" } }),
    invalidate: () => [qk.providerSettings(organizationId), qk.decisionEngines(organizationId), qk.integrations(organizationId)],
    success: "Workspace Google AI Studio key removed.",
    onSuccess: () => setNote("Google AI Studio: the workspace key was removed. A deployment key, if set, is used instead."),
  });

  const connecting = usePendingVariables<OAuthProvider>(connectKey);
  const probing = usePendingVariables<{ provider: AccountProvider }>(probeKey).map((vars) => vars.provider);
  const disconnecting = usePendingVariables<AccountProvider>(disconnectKey);
  const refreshing = usePendingVariables<OAuthProvider>(refreshKey);
  const failures = [connect, probe, disconnect, refreshToken, testKeyAction, removeKey]
    .map((action) => action.error)
    .filter((error): error is Error => Boolean(error));

  if (query.isError && !query.data) return <ErrorState message={errorText(query.error)} onRetry={() => void query.refetch()} />;
  if (!query.data) return <ScreenSkeleton label="Loading integration status" shape="rows" />;

  const status: SystemStatus = query.data;
  const summaryState: SummaryState = summaries.isError
    ? { state: "error" }
    : summaries.data
      ? { state: "ready", value: summaries.data as ProviderSummaries }
      : { state: "loading" };
  const cards = integrationCards({ status, summaries: summaryState });

  function actionsFor(card: CardModel): CardAction[] {
    if (!canAdmin) return [];
    if (card.kind === "account" && (card.id === "meta" || card.id === "tiktok" || card.id === "google" || card.id === "ad_library")) {
      const provider: AccountProvider = card.id;
      const disconnected = card.status === "DISCONNECTED";
      const actions: CardAction[] = [];
      if (isOAuthProvider(provider)) {
        actions.push({
          key: "connect",
          label: "Connect",
          disabled: connecting.includes(provider),
          onClick: () => { void connect.mutateAsync(provider).catch(() => undefined); },
        });
      }
      actions.push({
        key: "probe",
        label: disconnected ? "Reconnect" : "Test connection",
        disabled: probing.includes(provider),
        onClick: () => { void probe.mutateAsync({ provider, reconnect: disconnected }).catch(() => undefined); },
      });
      actions.push({
        key: "disconnect",
        label: "Disconnect",
        disabled: disconnecting.includes(provider) || disconnected,
        onClick: () => { void disconnect.mutateAsync(provider).catch(() => undefined); },
      });
      if (isOAuthProvider(provider)) {
        actions.push({
          key: "refresh",
          label: "Refresh token",
          disabled: refreshing.includes(provider),
          onClick: () => { void refreshToken.mutateAsync(provider).catch(() => undefined); },
        });
      }
      return actions;
    }
    if (card.id === "google_ai_studio") {
      const actions: CardAction[] = [{
        key: "test-key",
        label: "Test connection",
        pending: testKeyAction.isPending,
        onClick: () => { void testKeyAction.mutateAsync().catch(() => undefined); },
      }];
      if (card.workspaceKey) {
        actions.push({
          key: "remove-key",
          label: "Remove workspace key",
          pending: removeKey.isPending,
          onClick: () => { void removeKey.mutateAsync().catch(() => undefined); },
        });
      }
      return actions;
    }
    return [];
  }

  function linkFor(card: CardModel): { to: "/settings"; label: string } | undefined {
    if (!canAdmin) return undefined;
    if (card.id === "google_ai_studio") return { to: "/settings", label: "Key settings" };
    return undefined;
  }

  return (
    <div className="space-y-8">
      <div className="max-w-2xl space-y-3">
        <p className="eyebrow">Integrations</p>
        <h1 className="font-display text-4xl">What is actually connected</h1>
        <p className="text-fg-muted">
          A credential in the environment is not a connection. A provider shows as connected only after a request to it succeeds, and it changes again when someone disconnects it.
        </p>
      </div>

      {note ? <p className="text-sm text-fg" role="status">{note}</p> : null}
      {failures.map((error, index) => {
        const raw = errorText(error);
        return <FormError key={index} message={plainServerError(raw, "settings")} raw={raw} />;
      })}

      {INTEGRATION_GROUPS.map((group) => {
        const groupCards = cards.filter((card) => card.group === group.id);
        if (groupCards.length === 0) return null;
        return (
          <section key={group.id} aria-labelledby={`group-${group.id}`} className="space-y-3">
            <div>
              <h2 id={`group-${group.id}`} className="text-section font-semibold text-fg">{group.label}</h2>
              <p className="text-sm text-fg-muted">{group.hint}</p>
            </div>
            <ul className="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {groupCards.map((card) => (
                <ProviderCard
                  key={card.id}
                  card={card}
                  actions={actionsFor(card)}
                  link={linkFor(card)}
                  note={!canAdmin && card.kind !== "deployment" ? "An admin tests and changes providers." : undefined}
                />
              ))}
            </ul>
            {group.id === "ads" ? (
              <p className="rounded-md border border-border bg-surface p-3 text-sm text-fg-muted">
                <span className="font-semibold text-fg">Publishing: </span>{publishingLine(status)}
              </p>
            ) : null}
            {group.id === "infrastructure" ? (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-fg">Background processes</h3>
                <ul className="grid gap-2 md:grid-cols-3">
                  {processRows(status).map((row) => (
                    <li key={row.id} className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-fg">{row.label}</span>
                        <StatusBadge status={row.status} label={row.label} />
                      </div>
                      <p className="text-sm text-fg-muted">{row.summary}</p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        );
      })}

      {!canAdmin ? <p className="text-sm text-fg-muted">An admin tests and disconnects providers. Everyone in the workspace can read these statuses.</p> : null}
    </div>
  );
}
