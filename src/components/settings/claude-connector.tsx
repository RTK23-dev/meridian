import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Badge, Button, Input } from "@/components/ui";
import { InfoButton } from "@/components/settings/info-button";
import { qk } from "@/lib/query/keys";
import { useMcpConnectorsQuery, useScopedMutation } from "@/lib/query/hooks";
import { createMcpConnector, revokeMcpConnector } from "@/lib/meridian/mcp/actions";

type Connector = { id: string; name: string; hint: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null };

function when(iso: string | null): string {
  if (!iso) return "never used";
  return `used ${new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
}

/**
 * The Claude connector: a secret link an admin makes once and pastes into claude.ai (Settings, Connectors, Add custom connector). The chat
 * then writes and renders the video itself, and calls Meridian only for voice, images and decisions, under the workspace's own limits.
 * The link is shown once; only its last four characters are kept to tell links apart, and any link can be revoked.
 */
export function ClaudeConnector({ organizationId, canAdmin }: { organizationId: string; canAdmin: boolean }) {
  const list = useMcpConnectorsQuery(organizationId, canAdmin);
  const connectors = ((list.data as Connector[] | undefined) ?? []).filter((item) => item.revokedAt === null);
  const [name, setName] = useState("");
  const [made, setMade] = useState<{ url: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const create = useScopedMutation({
    mutationKey: ["mutation", "mcp.connector.create", organizationId],
    mutationFn: (value: string) => createMcpConnector({ data: { organizationId, name: value } }),
    invalidate: () => [qk.mcpConnectors(organizationId)],
    onSuccess: (result) => {
      setMade({ url: `${window.location.origin}/api/mcp/${result.secret}`, name: result.connector.name });
      setCopied(false);
      setName("");
    },
  });
  const revoke = useScopedMutation({
    mutationKey: ["mutation", "mcp.connector.revoke", organizationId],
    mutationFn: (connectorId: string) => revokeMcpConnector({ data: { organizationId, connectorId } }),
    invalidate: () => [qk.mcpConnectors(organizationId)],
    success: (_id, result) => (result.revoked ? "Link revoked. It answers nothing from now on." : "That link was already revoked."),
  });

  return (
    <section aria-labelledby="claude-connector-title" className="panel space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="claude-connector-title" className="text-section font-semibold text-fg-primary">Chat connector</h2>
        <Badge variant="info">MCP</Badge>
        <InfoButton label="the chat connector">
          <p>Make Meridian videos from a Claude or ChatGPT chat. The chat first asks a quick Q&amp;A (the video, the style, the voice, and how involved you want to be), then makes it step by step. In Studio mode you choose at every step; in Guided mode you approve the script and the final cut; in Orchestrator mode it runs on its own.</p>
          <p className="text-fg-muted">The chat writes the script and the coded video and can render it in its own sandbox, free. Meridian makes only what a chat cannot: voiceovers, images and decisions, each paid from the brand budgets on the Billing page.</p>
          <p className="text-fg-muted">Claude: Settings, Connectors, Add custom connector, then paste the link. ChatGPT: turn on developer mode for connectors, then add one with the link and no authentication. To render in the chat, allow this site in the chat's code execution network settings.</p>
          <p className="text-fg-muted">A link acts as the admin who made it. Anyone who has it can spend from this workspace, so keep it private and revoke it if it leaks.</p>
        </InfoButton>
      </div>
      <p className="text-sm text-fg-muted">Make videos from Claude or ChatGPT: a quick Q&amp;A, then Studio (you choose each step), Guided or Orchestrator. Meridian adds the voice, images and decisions under your limits.</p>

      {!canAdmin ? (
        <p className="text-sm text-fg-muted">Only a workspace admin can make connector links.</p>
      ) : (
        <>
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void create.mutateAsync(name.trim() || "Claude").catch(() => undefined);
            }}
          >
            <Input aria-label="Link name" placeholder="Name, for example Victor's Claude" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} className="min-w-0 flex-1" />
            <Button type="submit" size="sm" disabled={create.isPending}>{create.isPending ? "Making..." : "Make a link"}</Button>
          </form>

          {made ? (
            <div role="status" className="space-y-2 rounded-sharp border border-border-strong p-3">
              <p className="text-sm font-semibold text-fg-primary">Link for {made.name}: copy it now, it is shown once.</p>
              <div className="flex items-center gap-2">
                <Input aria-label="Connector link" readOnly value={made.url} onFocus={(event) => event.currentTarget.select()} className="min-w-0 flex-1 font-mono text-xs" />
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    void navigator.clipboard?.writeText(made.url).then(() => setCopied(true), () => setCopied(false));
                  }}
                >
                  {copied ? <Check aria-hidden="true" className="size-4" /> : <Copy aria-hidden="true" className="size-4" />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <p className="text-caption text-fg-muted">Paste it as a custom connector in Claude (Settings, Connectors) or ChatGPT (developer mode). Keep it private: it can spend from this workspace.</p>
            </div>
          ) : null}

          {connectors.length > 0 ? (
            <ul aria-label="Connector links" className="divide-y divide-hairline rounded-sharp border border-hairline">
              {connectors.map((item) => (
                <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate font-medium text-fg-primary">{item.name}</span>
                  <span className="font-mono text-xs text-fg-muted">…{item.hint}</span>
                  <span className="text-xs text-fg-muted">{when(item.lastUsedAt)}</span>
                  <Button type="button" variant="quiet" size="sm" disabled={revoke.isPending} onClick={() => void revoke.mutateAsync(item.id).catch(() => undefined)}>
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          ) : list.isSuccess ? (
            <p className="text-sm text-fg-muted">No link yet.</p>
          ) : null}
        </>
      )}
    </section>
  );
}
