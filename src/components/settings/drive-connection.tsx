import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, DisabledReason } from "@/components/ui";
import { PlainErrorNotice } from "@/components/plain-error";
import { checkDriveConnection, disconnectDrive, getDriveConnection } from "@/lib/meridian/storage/drive-connection-actions";

/**
 * The Google Drive connection, as the settings screen shows it. Drive is the artifact store: it holds rendered media, export
 * packages and uploaded source files, and Postgres records every row about them.
 *
 * An admin connects this workspace's Google Drive with Connect Google Drive, which needs the OAuth client set in the deployment
 * environment. When it cannot be used, the control is disabled and the reason is shown beside it. Disconnect removes the
 * connection and asks Google to revoke it, and it reports whether Google confirmed that. The Google sign-in on the Integrations
 * screen connects Google Ads, not Drive. Non-admins see the state but no controls.
 */
export function DriveConnectionPanel({ organizationId, canAdmin }: { organizationId: string; canAdmin: boolean }) {
  const queryClient = useQueryClient();
  const queryKey = ["settings", "drive-connection", organizationId];
  const view = useQuery({
    queryKey,
    queryFn: () => getDriveConnection({ data: { organizationId } }),
    enabled: Boolean(organizationId),
  });
  const check = useMutation({
    mutationFn: () => checkDriveConnection({ data: { organizationId } }),
  });
  const disconnect = useMutation({
    mutationFn: () => disconnectDrive({ data: { organizationId } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const data = view.data;
  const connected = data?.state === "connected";
  const credentialsSet = data?.state === "credentials_set";
  const canCheck = connected || credentialsSet;
  const connectHref = `/api/drive/connect?organizationId=${encodeURIComponent(organizationId)}`;
  const connectReasonId = "drive-connect-reason";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Google Drive</CardTitle>
        <CardDescription>
          Drive stores rendered media, export packages and uploaded source files. Postgres records every row about them.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {view.isPending ? <p className="text-sm text-fg-muted">Checking the Drive setup.</p> : null}
        {view.isError ? <PlainErrorNotice error={view.error} /> : null}

        {data ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {connected ? (
                <Badge variant="success">CONNECTED</Badge>
              ) : credentialsSet ? (
                <Badge variant="success">CREDENTIALS SET</Badge>
              ) : (
                <Badge variant="neutral">NOT CONNECTED</Badge>
              )}
              <span className="text-sm text-fg-muted">{data.detail}</span>
            </div>

            {connected && data.connectedAt ? (
              <p className="text-sm text-fg-muted">Connected {new Date(data.connectedAt).toLocaleString()}.</p>
            ) : null}

            {data.missing.length > 0 ? (
              <div className="space-y-1 text-sm">
                <p className="font-medium text-fg">Still missing in the deployment environment</p>
                <ul className="list-disc space-y-1 pl-5 text-fg-muted">
                  {data.missing.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {data.steps.length > 0 ? (
              <ol className="list-decimal space-y-2 pl-5 text-sm text-fg-muted [overflow-wrap:anywhere]">
                {data.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            ) : null}

            <p className="text-sm text-fg-muted">{data.oauthSignInNote}</p>

            {canAdmin ? (
              <div className="space-y-2">
                {connected ? (
                  <Button variant="secondary" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
                    {disconnect.isPending ? "Disconnecting Google Drive" : "Disconnect Google Drive"}
                  </Button>
                ) : (
                  <>
                    <Button
                      variant="secondary"
                      onClick={() => window.location.assign(connectHref)}
                      disabled={!data.connect.available}
                      aria-describedby={data.connect.available ? undefined : connectReasonId}
                    >
                      Connect Google Drive
                    </Button>
                    {data.connect.available ? null : <DisabledReason id={connectReasonId}>{data.connect.reason}</DisabledReason>}
                  </>
                )}
                {disconnect.data ? (
                  <p className="text-sm text-fg-muted" role="status">
                    {disconnect.data.detail}
                  </p>
                ) : null}
                {disconnect.isError ? <PlainErrorNotice error={disconnect.error} /> : null}

                {canCheck ? (
                  <div className="space-y-2">
                    <Button variant="secondary" onClick={() => check.mutate()} disabled={check.isPending}>
                      {check.isPending ? "Checking Drive" : "Check Drive connection"}
                    </Button>
                    {check.data ? (
                      <p className="text-sm text-fg-muted" role="status">
                        {check.data.status === "HEALTHY"
                          ? "Drive accepted the credentials."
                          : check.data.status === "NOT_CONFIGURED"
                            ? "Drive is not configured."
                            : "Drive did not accept the credentials."}{" "}
                        {check.data.detail}
                      </p>
                    ) : null}
                    {check.isError ? <PlainErrorNotice error={check.error} /> : null}
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-fg-muted">An admin can connect, disconnect, or check the Drive connection.</p>
            )}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
