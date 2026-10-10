import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useWorkspace } from "@/components/workspace";
import { Button, Notice, errorText } from "@/components/ui";
import { acceptInvite } from "@/lib/meridian/api";
import { useScopedMutation } from "@/lib/query/hooks";

export const Route = createFileRoute("/_app/invite")({ staticData: { pageTitle: "Accept invitation" }, component: Page });

function Page() {
  return (
    <Accept />
  );
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
  return (
    <div className="mx-auto max-w-lg space-y-4">
      <h1 className="font-display text-3xl">Accept invitation</h1>
      <p className="text-sm text-muted">The link works once. It is not shown again after you accept.</p>
      {accept.error ? <Notice>{errorText(accept.error)}</Notice> : null}
      {done ? <p>{done}</p> : null}
      <Button
        type="button"
        disabled={accept.isPending || !token || Boolean(done)}
        onClick={() => {
          void accept.mutateAsync(token).catch(() => undefined);
        }}
      >
        Accept invitation
      </Button>
    </div>
  );
}
