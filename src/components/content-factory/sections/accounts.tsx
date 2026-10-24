import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { UnsavedChangesBar } from "@/components/forms/unsaved-bar";
import { UnsavedChangesGuard } from "@/components/forms/unsaved-guard";
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogTitle, DisabledReason, Field, ErrorNotice, Card, ScreenSkeleton, Input } from "@/components/ui";
import { PlainErrorState } from "@/components/plain-error";
import { usePendingVariables, usePlatformAccountsQuery, useScopedMutation } from "@/lib/query/hooks";
import { qk } from "@/lib/query/keys";
import {
  connectPlatformAccountAction,
  disconnectPlatformAccountAction,
} from "@/lib/meridian/accounts/actions";
import { beginOauth } from "@/lib/meridian/oauth/begin";
import { oauthClientReadinessAction } from "@/lib/meridian/oauth/readiness";
import { signInProviderForPlatform, signInState, type AccountSignInProvider } from "@/components/accounts/oauth-connect";
import { parseAccountPaste } from "@/components/accounts/paste";
import { useWorkspace } from "@/components/workspace";
import { hasRole } from "@/lib/meridian/access";

const PLATFORMS = [
  { id: "instagram", name: "Instagram", type: "social_page", placeholder: "@brand_official" },
  { id: "facebook", name: "Facebook", type: "social_page", placeholder: "Brand Page" },
  { id: "youtube", name: "YouTube Shorts", type: "channel", placeholder: "@brand_shorts" },
  { id: "tiktok", name: "TikTok", type: "creator_profile", placeholder: "@brand_tiktok" },
  { id: "tiktok_ads", name: "TikTok Ads", type: "ad_account", placeholder: "Advertiser id" },
  { id: "meta_ads", name: "Meta Ads", type: "ad_account", placeholder: "act_1234567890" },
  { id: "google_ads", name: "Google Ads", type: "ad_account", placeholder: "123-456-7890" },
] as const;

function usesWorkspaceLogin(platform: string): boolean {
  return platform === "meta_ads" || platform === "google_ads" || platform === "tiktok_ads";
}

export function BrandAccounts({ brandId }: { brandId: string }) {
  const { data: workspace } = useWorkspace();
  const role = workspace?.active?.role || "viewer";
  const canAdmin = hasRole(role, "admin");

  const query = usePlatformAccountsQuery(brandId);
  const accounts = query.data ?? [];

  const [addModalOpen, setAddModalOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [platform, setPlatform] = useState<(typeof PLATFORMS)[number]["id"]>("instagram");
  const [paste, setPaste] = useState("");
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [accountId, setAccountId] = useState("");
  const [token, setToken] = useState("");

  const organizationId = workspace?.active?.id ?? "";
  const signInProvider = signInProviderForPlatform(platform);
  const readinessQuery = useQuery({
    queryKey: ["oauth", "readiness", organizationId],
    queryFn: () => oauthClientReadinessAction({ data: { organizationId } }),
    enabled: Boolean(organizationId) && canAdmin && signInProvider !== null,
    staleTime: 60_000,
  });
  const [signingIn, setSigningIn] = useState<AccountSignInProvider | null>(null);
  const signIn = signInProvider ? signInState({ provider: signInProvider, canAdmin, readiness: readinessQuery.data?.[signInProvider] }) : null;
  const signInReason = readinessQuery.isError ? "The sign-in settings could not be checked. Reload the page to try again." : signIn?.reason ?? null;
  const signInEnabled = Boolean(signIn?.enabled) && !readinessQuery.isError && signingIn === null;
  const startSignIn = async (provider: AccountSignInProvider) => {
    setErrorMessage(null);
    setSigningIn(provider);
    try {
      const started = await beginOauth({ data: { organizationId, provider, origin: window.location.origin, returnTo: `/brands/${brandId}/accounts` } });
      window.location.assign(started.url);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Sign-in could not start.");
      setSigningIn(null);
    }
  };

  const clearDraft = () => {
    setPaste("");
    setName("");
    setHandle("");
    setAccountId("");
    setToken("");
    setErrorMessage(null);
  };

  const connectAccount = useScopedMutation({
    mutationKey: ["mutation", "accounts.connect", brandId],
    mutationFn: (vars: { platform: string; name: string; handle: string; externalAccountId: string; accountType: string; token: string }) =>
      connectPlatformAccountAction({ data: { brandId, ...vars } }),
    // A connected account is listed by the accounts screen and offered as a channel on studio.
    invalidate: () => [qk.accounts(brandId), qk.channels(brandId)],
    success: "Account connected.",
    onSuccess: () => {
      setAddModalOpen(false);
      clearDraft();
    },
  });
  const disconnectKey = ["mutation", "accounts.disconnect", brandId] as const;
  const disconnectAccount = useScopedMutation({
    mutationKey: disconnectKey,
    mutationFn: (accountId: string) => disconnectPlatformAccountAction({ data: { brandId, accountId } }),
    invalidate: () => [qk.accounts(brandId), qk.channels(brandId)],
    success: "Account disconnected.",
  });
  const disconnecting = usePendingVariables<string>(disconnectKey);

  const selectedPlatformMeta = PLATFORMS.find((p) => p.id === platform) || PLATFORMS[0];
  const dirty = [paste, name, handle, accountId, token].some((value) => value.trim().length > 0);

  function applyPaste(value: string) {
    setPaste(value);
    const parsed = parseAccountPaste(value);
    if (!parsed) return;
    setAccountId(parsed.externalAccountId);
    setHandle(parsed.handle);
    setName((current) => current.trim() ? current : parsed.name);
  }

  async function handleConnect(event: FormEvent) {
    event.preventDefault();
    setErrorMessage(null);
    if (!name.trim() || !accountId.trim()) {
      setErrorMessage("Enter the account name and the account ID. Pasting a profile link fills both.");
      return;
    }
    const workspaceLogin = usesWorkspaceLogin(platform);
    const ok = await connectAccount
      .mutateAsync({
        platform,
        name: name.trim(),
        handle: handle.trim(),
        externalAccountId: accountId.trim(),
        accountType: selectedPlatformMeta.type,
        token: workspaceLogin ? "" : token.trim(),
      })
      .then(() => true, () => false);
    if (!ok) setErrorMessage("Failed to connect account.");
  }

  const handleDisconnect = async (accountId: string) => {
    await disconnectAccount.mutateAsync(accountId).catch(() => undefined);
  };

  if (query.isError && !query.data) {
    return <PlainErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="max-w-2xl space-y-2">
          <p className="eyebrow">Account Vault</p>
          <h1 className="page-title">Connected accounts</h1>
          <p className="text-muted">
            This names the page or ad account this brand uses. Meta, Google, and TikTok ads use the workspace login from Integrations, then the ad account ID here. Instagram, Facebook, YouTube, and a TikTok creator profile still need their own token on this form.
          </p>
        </div>
        {canAdmin && accounts.length > 0 ? (
          <Button type="button" onClick={() => setAddModalOpen(true)}>
            Connect another
          </Button>
        ) : null}
      </div>

      {query.isPending && !query.data ? (
        <ScreenSkeleton label="Loading accounts" shape="rows" />
      ) : accounts.length === 0 ? (
        canAdmin ? (
          <ConnectForm
            platform={platform}
            onPlatform={setPlatform}
            paste={paste}
            onPaste={applyPaste}
            name={name}
            onName={setName}
            handle={handle}
            onHandle={setHandle}
            accountId={accountId}
            onAccountId={setAccountId}
            token={token}
            onToken={setToken}
            errorMessage={errorMessage}
            pending={connectAccount.isPending}
            dirty={dirty}
            onSubmit={handleConnect}
            onDiscard={clearDraft}
            signIn={signInProvider ? {
              provider: signInProvider,
              enabled: signInEnabled,
              reason: signInReason,
              pending: signingIn === signInProvider,
              onStart: () => void startSignIn(signInProvider),
            } : null}
            workspaceLogin={usesWorkspaceLogin(platform)}
          />
        ) : <p className="text-sm text-muted">No accounts yet. A workspace admin can connect one.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {accounts.map((account) => {
            const isConnected = account.status === "connected";
            return (
              <Card key={account.id} className="flex flex-col justify-between p-5 space-y-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="eyebrow">
                      {account.platform.replace("_", " ")}
                    </span>
                    <Badge variant={isConnected ? "success" : "danger"}>
                      {account.status}
                    </Badge>
                  </div>
                  <h3 className="text-xl">{account.name}</h3>
                  {account.handle ? (
                    <p className="text-sm text-muted">{account.handle}</p>
                  ) : null}
                  <p className="text-xs text-muted font-mono">
                    ID: {account.externalAccountId}
                  </p>
                  <p className="text-xs text-muted">
                    Token: {account.credentialId ? "Encrypted in the vault" : "None stored. This account cannot publish."}
                  </p>
                </div>

                <div className="flex items-center justify-between border-t border-line pt-3">
                  <span className="text-xs text-muted">
                    {account.accountType.replace("_", " ")}
                  </span>
                  {canAdmin && isConnected ? (
                    <Button
                      type="button"
                      variant="quiet"
                      disabled={disconnecting.includes(account.id)}
                      onClick={() => handleDisconnect(account.id)}
                    >
                      Disconnect
                    </Button>
                  ) : null}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {accounts.length > 0 ? (
      <Dialog open={addModalOpen} onOpenChange={(open) => { if (!open) clearDraft(); setAddModalOpen(open); }}>
        <UnsavedChangesGuard dirty={dirty && addModalOpen} />
        <DialogContent aria-describedby="connect-account-description">
          <DialogTitle>Connect an account</DialogTitle>
          <DialogDescription id="connect-account-description">
            Paste a link or an ID. Sign-in is there for Meta Ads, Google Ads, and TikTok Ads when this deployment has it.
          </DialogDescription>
          <div className="mt-4">
            <ConnectForm
              platform={platform}
              onPlatform={setPlatform}
              paste={paste}
              onPaste={applyPaste}
              name={name}
              onName={setName}
              handle={handle}
              onHandle={setHandle}
              accountId={accountId}
              onAccountId={setAccountId}
              token={token}
              onToken={setToken}
              errorMessage={errorMessage}
              pending={connectAccount.isPending}
              dirty={dirty}
              onSubmit={handleConnect}
              onDiscard={() => { clearDraft(); setAddModalOpen(false); }}
              signIn={signInProvider ? {
                provider: signInProvider,
                enabled: signInEnabled,
                reason: signInReason,
                pending: signingIn === signInProvider,
                onStart: () => void startSignIn(signInProvider),
              } : null}
              workspaceLogin={usesWorkspaceLogin(platform)}
            />
          </div>
        </DialogContent>
      </Dialog>
      ) : null}
    </div>
  );
}

function signInName(provider: AccountSignInProvider): string {
  if (provider === "meta") return "Meta";
  if (provider === "google") return "Google";
  return "TikTok";
}

function ConnectForm({
  platform,
  onPlatform,
  paste,
  onPaste,
  name,
  onName,
  handle,
  onHandle,
  accountId,
  onAccountId,
  token,
  onToken,
  errorMessage,
  pending,
  dirty,
  onSubmit,
  onDiscard,
  signIn,
  workspaceLogin,
}: {
  platform: (typeof PLATFORMS)[number]["id"];
  onPlatform: (id: (typeof PLATFORMS)[number]["id"]) => void;
  paste: string;
  onPaste: (value: string) => void;
  name: string;
  onName: (value: string) => void;
  handle: string;
  onHandle: (value: string) => void;
  accountId: string;
  onAccountId: (value: string) => void;
  token: string;
  onToken: (value: string) => void;
  errorMessage: string | null;
  pending: boolean;
  dirty: boolean;
  onSubmit: (event: FormEvent) => void;
  onDiscard: () => void;
  signIn: { provider: AccountSignInProvider; enabled: boolean; reason: string | null; pending: boolean; onStart: () => void } | null;
  workspaceLogin: boolean;
}) {
  const selected = PLATFORMS.find((item) => item.id === platform) ?? PLATFORMS[0];
  const [confirming, setConfirming] = useState(false);
  const canSave = name.trim().length > 0 && accountId.trim().length > 0;
  const saveReason = pending
    ? "Connecting the account. Wait for it to finish."
    : !name.trim()
      ? "Enter an account name to connect."
      : !accountId.trim()
        ? "Enter the account ID to connect."
        : "";
  return (
    <form className="space-y-4 rounded-xl border border-border bg-surface p-4" noValidate onSubmit={onSubmit}>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Platform">
        {PLATFORMS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={platform === item.id}
            onClick={() => onPlatform(item.id)}
            className={`min-h-11 rounded-full border px-3 text-sm font-semibold ${platform === item.id ? "border-fg bg-fg text-bg" : "border-border bg-surface text-fg hover:bg-surface-2"}`}
          >
            {item.name}
          </button>
        ))}
      </div>
      {errorMessage ? <ErrorNotice>{errorMessage}</ErrorNotice> : null}
      {signIn ? (
        <div className="space-y-2 rounded-md border border-border p-3">
          <p className="text-sm font-semibold">Sign in with {signInName(signIn.provider)}</p>
          <p className="text-sm text-fg-muted">Sign-in stores the workspace login and brings you back to this page. Then enter the ad account ID. It does not connect a page or a creator profile.</p>
          <Button type="button" disabled={!signIn.enabled} aria-describedby={signIn.enabled || !signIn.reason ? undefined : "accounts-signin-reason"} onClick={signIn.onStart}>
            {signIn.pending ? "Opening sign-in…" : `Sign in with ${signInName(signIn.provider)}`}
          </Button>
          {!signIn.enabled && signIn.reason ? <DisabledReason id="accounts-signin-reason">{signIn.reason}</DisabledReason> : null}
        </div>
      ) : null}
      <Field label="Paste a link to fill the fields" hint={`For example ${selected.placeholder}. You can still edit every field after it fills.`}>
        <Input value={paste} onChange={(event) => onPaste(event.target.value)} placeholder={selected.placeholder} autoComplete="off" spellCheck={false} maxLength={200} />
      </Field>
      <Field label="Account name" hint="The name shown in Meridian.">
        <Input value={name} onChange={(event) => onName(event.target.value)} maxLength={120} placeholder="Acme official" required />
      </Field>
      <Field label="Handle" hint="Optional. A profile link fills this.">
        <Input value={handle} onChange={(event) => onHandle(event.target.value)} maxLength={120} placeholder={selected.placeholder} autoComplete="off" spellCheck={false} />
      </Field>
      <Field label="Account ID" hint="The page ID, channel ID, or ad account ID the platform uses.">
        <Input value={accountId} onChange={(event) => onAccountId(event.target.value)} maxLength={120} placeholder="1029384756 or act_12345" required autoComplete="off" spellCheck={false} />
      </Field>
      {workspaceLogin ? (
        <p className="text-sm text-fg-muted">Paid ads use the workspace login. This form does not take a second token. Enter the ad account this brand should use.</p>
      ) : (
        <Field label="Access token" hint="Required to publish or sync this page. The ads login does not include this permission. Stored encrypted.">
          <Input type="password" value={token} onChange={(event) => onToken(event.target.value)} placeholder="Paste the access token" autoComplete="new-password" spellCheck={false} />
        </Field>
      )}
      <UnsavedChangesBar dirty={dirty} subject="account connection" confirming={confirming} onConfirmingChange={setConfirming} onDiscard={onDiscard} />
      {!canSave || pending ? <DisabledReason id="accounts-connect-reason">{saveReason}</DisabledReason> : null}
      <Button type="submit" disabled={pending || !canSave} aria-describedby={!canSave || pending ? "accounts-connect-reason" : undefined}>{pending ? "Connecting…" : "Connect"}</Button>
    </form>
  );
}
