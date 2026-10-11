import { useMutation, useQuery } from "@tanstack/react-query";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { PlainErrorNotice } from "@/components/plain-error";
import { checkDriveConnection, getDriveConnection } from "@/lib/meridian/storage/drive-connection-actions";

/**
 * The Google Drive connection, as the settings screen shows it. Drive is the artifact store: it holds rendered media, export
 * packages and uploaded source files, and Postgres records every row about them.
 *
 * There is no Connect button. The Google sign-in on the Integrations screen connects Google Ads, not Drive, so it cannot
 * connect Drive. Until Drive credentials are set in the deployment environment, this panel says so and lists the steps.
 * The check button is only shown once credentials exist, and only to admins.
 */
export function DriveConnectionPanel({ organizationId, canAdmin }: { organizationId: string; canAdmin: boolean }) {
  const view = useQuery({
    queryKey: ["settings", "drive-connection", organizationId],
    queryFn: () => getDriveConnection({ data: { organizationId } }),
    enabled: Boolean(organizationId),
  });
  const check = useMutation({
    mutationFn: () => checkDriveConnection({ data: { organizationId } }),
  });

  const data = view.data;
  const credentialsSet = data?.state === "credentials_set";

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
              {credentialsSet ? (
                <Badge variant="success">CREDENTIALS SET</Badge>
              ) : (
                <Badge variant="neutral">NOT CONNECTED</Badge>
              )}
              <span className="text-sm text-fg-muted">{data.detail}</span>
            </div>

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
              <ol className="list-decimal space-y-2 pl-5 text-sm text-fg-muted">
                {data.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            ) : null}

            <p className="text-sm text-fg-muted">{data.oauthSignInNote}</p>

            {credentialsSet ? (
              canAdmin ? (
                <div className="space-y-2">
                  <Button
                    variant="secondary"
                    onClick={() => check.mutate()}
                    disabled={check.isPending}
                  >
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
              ) : (
                <p className="text-sm text-fg-muted">An admin can check the Drive connection.</p>
              )
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
