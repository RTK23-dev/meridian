import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useWorkspace } from "@/components/workspace";
import { Button, errorText } from "@/components/ui";
import { FormError } from "@/components/settings/form-error";
import { plainServerError } from "@/components/settings/form-model";
import { acceptInvite } from "@/lib/meridian/api";
import { useScopedMutation } from "@/lib/query/hooks";

export const Route = createFileRoute("/_app/invite")({ staticData: { pageTitle: "Accept invitation" }, component: Page });

function Page() {
  return <Accept />;
}

function Accept() {
  const { reload } = useWorkspace();
  const [done, setDone] = useState("");
  const accept = useScopedMutation({
    mutationKey: ["mutation", "invite.accept"],
    mutationFn: (token: string) => acceptInvite({ data: { token } }),
    // An accepted invitation adds a workspace to the list, so the workspace reloads.
    onSuccess: async (result) => {
      setDone(result.message);
      await reload();
    },
  });
  const token = typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("token") ?? "";
  const rawError = accept.error ? errorText(accept.error) : null;
  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div className="space-y-2">
        <p className="eyebrow">Invitation</p>
        <h1 className="font-display text-3xl">Join this workspace</h1>
        <p className="text-fg-muted">Accept the invitation to add this workspace to your list. The link works once, and it is not shown again after you accept.</p>
      </div>

      {!token && !done ? (
        <FormError message="This link is missing its invitation token. Open the link from your email again." />
      ) : null}
      {rawError ? <FormError message={plainServerError(rawError, "invite")} raw={rawError} /> : null}

      {done ? (
        <div role="status" className="space-y-3 rounded-lg border border-success/50 bg-success-soft p-4 text-sm text-success">
          <p>{done}</p>
          <Button asChild variant="secondary" size="md">
            <Link to="/">Go to the workspace</Link>
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          size="lg"
          disabled={accept.isPending || !token}
          onClick={() => {
            void accept.mutateAsync(token).catch(() => undefined);
          }}
        >
          {accept.isPending ? "Accepting…" : "Accept invitation"}
        </Button>
      )}
    </div>
  );
}
