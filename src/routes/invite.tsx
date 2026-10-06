import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Authed, useBusy } from "@/components/gate";
import { Button, Notice } from "@/components/ui";
import { acceptInvite } from "@/lib/meridian/api";

export const Route = createFileRoute("/invite")({ component: Page });

function Page() {
  return (
    <Authed>
      <Accept />
    </Authed>
  );
}

function Accept() {
  const busy = useBusy();
  const [done, setDone] = useState("");
  const token = typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("token") ?? "";
  return (
    <div className="mx-auto max-w-lg space-y-4">
      <h1 className="font-display text-3xl">Accept invitation</h1>
      <p className="text-sm text-muted">The link works once. It is not shown again after you accept.</p>
      {busy.error ? <Notice>{busy.error}</Notice> : null}
      {done ? <p>{done}</p> : null}
      <Button
        type="button"
        disabled={busy.pending || !token || Boolean(done)}
        onClick={() => {
          void busy.run(async () => {
            const result = await acceptInvite({ data: { token } });
            setDone(result.message);
          });
        }}
      >
        Accept invitation
      </Button>
    </div>
  );
}
