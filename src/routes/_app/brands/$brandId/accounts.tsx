import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  ErrorState,
  Field,
  Notice,
  Panel,
  SelectInput,
  ScreenSkeleton,
  TextInput,
  errorText,
} from "@/components/ui";
import { usePendingVariables, usePlatformAccountsQuery, useScopedMutation } from "@/lib/query/hooks";
import { qk } from "@/lib/query/keys";
import {
  connectPlatformAccountAction,
  disconnectPlatformAccountAction,
} from "@/lib/meridian/accounts/actions";
import { useWorkspace } from "@/components/workspace";
import { hasRole } from "@/lib/meridian/access";

export const Route = createFileRoute("/_app/brands/$brandId/accounts")({
  component: Page,
});

function Page() {
  const { brandId } = Route.useParams();
  return <BrandAccounts brandId={brandId} />;
}

const PLATFORMS = [
  { id: "instagram", name: "Instagram", type: "social_page", placeholder: "@brand_official" },
  { id: "facebook", name: "Facebook", type: "social_page", placeholder: "Brand Page" },
  { id: "youtube", name: "YouTube Shorts", type: "channel", placeholder: "@brand_shorts" },
  { id: "tiktok", name: "TikTok", type: "creator_profile", placeholder: "@brand_tiktok" },
  { id: "meta_ads", name: "Meta Ads", type: "ad_account", placeholder: "act_1234567890" },
  { id: "google_ads", name: "Google Ads", type: "ad_account", placeholder: "123-456-7890" },
] as const;

function BrandAccounts({ brandId }: { brandId: string }) {
  const { data: workspace } = useWorkspace();
  const role = workspace?.active?.role || "viewer";
  const canEdit = hasRole(role, "member");
  const canAdmin = hasRole(role, "admin");

  const query = usePlatformAccountsQuery(brandId);
  const accounts = query.data ?? [];

  const [addModalOpen, setAddModalOpen] = useState(false);
  const [platform, setPlatform] = useState<string>("instagram");
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [externalAccountId, setExternalAccountId] = useState("");
  const [token, setToken] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const connectAccount = useScopedMutation({
    mutationKey: ["mutation", "accounts.connect", brandId],
    mutationFn: (vars: { platform: string; name: string; handle: string; externalAccountId: string; accountType: string; token: string }) =>
      connectPlatformAccountAction({ data: { brandId, ...vars } }),
    // A connected account is listed by the accounts screen and offered as a channel on studio.
    invalidate: () => [qk.accounts(brandId), qk.channels(brandId)],
    success: "Account connected.",
    onSuccess: () => {
      setAddModalOpen(false);
      setName("");
      setHandle("");
      setExternalAccountId("");
      setToken("");
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

  const handleConnect = async () => {
    if (!name.trim() || !externalAccountId.trim()) {
      setErrorMessage("Account name and Account ID are required.");
      return;
    }

    setErrorMessage(null);
    const ok = await connectAccount
      .mutateAsync({
        platform,
        name: name.trim(),
        handle: handle.trim(),
        externalAccountId: externalAccountId.trim(),
        accountType: selectedPlatformMeta.type,
        token: token.trim(),
      })
      .then(() => true, () => false);

    if (!ok) {
      setErrorMessage("Failed to connect account.");
    }
  };

  const handleDisconnect = async (accountId: string) => {
    await disconnectAccount.mutateAsync(accountId).catch(() => undefined);
  };

  if (query.isError && !query.data) {
    return <ErrorState message={errorText(query.error)} onRetry={() => void query.refetch()} />;
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="max-w-2xl space-y-2">
          <p className="text-sm font-semibold uppercase tracking-widest text-brass">Account Vault</p>
          <h1 className="font-display text-4xl">Connected Platform Accounts</h1>
          <p className="text-muted">
            Manage multiple social pages, creator profiles, and advertising accounts for this brand.
            All tokens are encrypted in the database with AES-256-GCM.
          </p>
        </div>
        {canEdit ? (
          <Button type="button" onClick={() => setAddModalOpen(true)}>
            Connect Account
          </Button>
        ) : null}
      </div>

      {query.isPending && !query.data ? (
        <ScreenSkeleton label="Loading accounts" shape="rows" />
      ) : accounts.length === 0 ? (
        <Panel className="p-8 text-center">
          <p className="text-lg font-semibold">No accounts connected yet</p>
          <p className="mt-1 text-sm text-muted">
            Connect an Instagram page, YouTube channel, TikTok account, or ad account to enable multi-channel publishing and automated performance telemetry.
          </p>
          {canEdit ? (
            <div className="mt-4">
              <Button type="button" onClick={() => setAddModalOpen(true)}>
                Connect First Account
              </Button>
            </div>
          ) : null}
        </Panel>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {accounts.map((account) => {
            const isConnected = account.status === "connected";
            return (
              <Panel key={account.id} className="flex flex-col justify-between p-5 space-y-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-widest text-brass">
                      {account.platform.replace("_", " ")}
                    </span>
                    <Badge variant={isConnected ? "success" : "danger"}>
                      {account.status}
                    </Badge>
                  </div>
                  <h3 className="font-display text-xl">{account.name}</h3>
                  {account.handle ? (
                    <p className="text-sm text-muted">{account.handle}</p>
                  ) : null}
                  <p className="text-xs text-muted font-mono">
                    ID: {account.externalAccountId}
                  </p>
                  <p className="text-xs text-muted">
                    Credential: {account.credentialId ? "Encrypted in Vault" : "Environment / Open"}
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
              </Panel>
            );
          })}
        </div>
      )}

      <Dialog open={addModalOpen} onOpenChange={(open) => setAddModalOpen(open)}>
        <DialogContent aria-describedby="connect-account-description">
          <DialogTitle>Connect Platform Account</DialogTitle>
          <DialogDescription id="connect-account-description">
            Add an account to this brand. Tokens are encrypted using AES-256-GCM before writing to the database.
          </DialogDescription>

          <div className="mt-4 space-y-4">
            {errorMessage ? <Notice>{errorMessage}</Notice> : null}

            <Field label="Platform">
              <SelectInput
                value={platform}
                onChange={(e) => setPlatform(e.target.value)}
              >
                {PLATFORMS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.type.replace("_", " ")})
                  </option>
                ))}
              </SelectInput>
            </Field>

            <Field label="Account Display Name">
              <TextInput
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Acme Official Store"
                required
              />
            </Field>

            <Field label="Account Handle / Username">
              <TextInput
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                placeholder={selectedPlatformMeta.placeholder}
              />
            </Field>

            <Field label="External Account ID / Page ID">
              <TextInput
                value={externalAccountId}
                onChange={(e) => setExternalAccountId(e.target.value)}
                placeholder="e.g. 1029384756 or act_12345"
                required
              />
            </Field>

            <Field label="Access Token / API Key (Optional, Encrypted in Vault)">
              <TextInput
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Paste token or leave blank to rely on environment default"
              />
            </Field>

            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="quiet"
                onClick={() => setAddModalOpen(false)}
                disabled={connectAccount.isPending}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={handleConnect}
                disabled={connectAccount.isPending}
              >
                {connectAccount.isPending ? "Connecting…" : "Save & Connect"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
