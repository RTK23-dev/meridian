import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Badge, Button, SelectInput, Textarea } from "@/components/ui";
import { InfoButton } from "@/components/settings/info-button";
import { qk } from "@/lib/query/keys";
import { useClaudeCodeSetupQuery, useMcpConnectorsQuery, useScopedMutation } from "@/lib/query/hooks";
import { createMcpConnector } from "@/lib/meridian/mcp/actions";
import { cancelClaudeCodeRequest, createClaudeCodeRequest, retryClaudeCodeRequest } from "@/lib/meridian/claude-code/actions";

type Source = "gathered" | "factory" | "idea";

const SOURCES: Array<{ id: Source; label: string; hint: string }> = [
  { id: "idea", label: "My own idea", hint: "Write it in a few words." },
  { id: "gathered", label: "Data Meridian already gathered", hint: "The brand's best open opportunity and the patterns the research found." },
  { id: "factory", label: "The Content Factory's latest plan", hint: "The brief and objective of the brand's newest live plan." },
];

/** A request's state in plain words. */
const STATUS_LABEL: Record<string, string> = { open: "Waiting", claimed: "Opened in Claude Code", running: "Being made", done: "Done", failed: "Failed" };

const STEP = "text-sm font-semibold text-fg-primary";
const CHOICE = "flex cursor-pointer items-start gap-2 rounded-sharp border p-3 text-sm has-[:checked]:border-accent has-[:checked]:bg-surface-muted has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60";

/**
 * One click to make a video from Claude Code, in three plain steps: what to make, where the idea comes from, then click. The click records a
 * request and gives back one line to paste into Claude Code, which makes the video on this computer, free, and saves it back. A source with
 * nothing behind it is shown as not ready, and nothing is filled in. Connecting is one button, once; the pasted line installs the skills itself.
 */
type Link = { id: string; lastUsedAt: string | null; revokedAt: string | null };

/** Connecting Claude Code, once: one button makes the link and shows the one command to run. Only an admin can make a link. */
type Runner = { online: boolean; name: string | null; lastSeenAt: string | null; problems: string[] };

function Connect({ organizationId, canAdmin, runner }: { organizationId: string; canAdmin: boolean; runner: Runner }) {
  const list = useMcpConnectorsQuery(organizationId, canAdmin);
  const links = ((list.data as Link[] | undefined) ?? []).filter((item) => item.revokedAt === null);
  const [command, setCommand] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const make = useScopedMutation({
    mutationKey: ["mutation", "claude-code.connect", organizationId],
    mutationFn: (_: void) => createMcpConnector({ data: { organizationId, name: "Claude Code" } }),
    invalidate: () => [qk.mcpConnectors(organizationId)],
    onSuccess: (result) => {
      const text = `npm run claude:runner -- ${window.location.origin}/api/mcp/${result.secret}`;
      setCommand(text);
      void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => setCopied(false));
    },
  });
  const used = links.find((item) => item.lastUsedAt !== null);

  return (
    <div className="space-y-2 rounded-sharp border border-hairline p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className={STEP}>Your computer</p>
        <Badge variant={runner.online && runner.problems.length === 0 ? "success" : "neutral"}>{runner.online ? (runner.problems.length === 0 ? `Ready on ${runner.name}` : `Connected on ${runner.name}, not ready`) : "Not running"}</Badge>
      </div>
      {runner.online && runner.problems.length > 0 ? (
        <ul className="list-disc space-y-1 pl-5 text-sm text-fg-primary">{runner.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
      ) : null}
      {runner.online ? (
        <p className="text-sm text-fg-muted">{runner.problems.length === 0 ? "A video you ask for below starts by itself. Each one starts fresh, and none is added to your Claude Code chat history." : "Fix the above on that computer. The runner checks again every minute."}</p>
      ) : !canAdmin ? (
        <p className="text-sm text-fg-muted">A workspace admin connects a computer once, here. Until then, a video you ask for waits, and you can paste its line into Claude Code yourself.</p>
      ) : command ? (
        <div className="space-y-2" role="status">
          <p className="text-sm text-fg-primary">Run this in a terminal, in the Meridian folder{copied ? " (copied)" : ""}, and leave it running. It is shown once, and it can spend from this workspace, so keep it private. Next time, <code className="font-mono text-xs">npm run claude:runner</code> is enough.</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-sharp bg-surface-muted px-2 py-1 font-mono text-xs">{command}</code>
            <Button type="button" size="sm" variant="secondary" onClick={() => void navigator.clipboard?.writeText(command).then(() => setCopied(true), () => setCopied(false))}>
              {copied ? <Check aria-hidden="true" className="size-4" /> : <Copy aria-hidden="true" className="size-4" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      ) : used || runner.lastSeenAt ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-fg-muted">The runner is not running. In the Meridian folder on your computer, run <code className="font-mono text-xs text-fg-primary">npm run claude:runner</code> and leave it open.</p>
          <Button type="button" size="sm" variant="quiet" disabled={make.isPending} onClick={() => void make.mutateAsync().catch(() => undefined)}>New computer? Make a new command</Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" size="sm" disabled={make.isPending || list.isPending} onClick={() => void make.mutateAsync().catch(() => undefined)}>
            {make.isPending ? "Making..." : links.length > 0 ? "Make a new command" : "Connect this computer"}
          </Button>
          <span className="text-caption text-fg-muted">{links.length > 0 ? "A link exists but has not been used yet. Its command is shown only once, so make a new one if you lost it." : "One click gives you one command to run on the computer that has Claude Code. It then makes the videos you ask for here."}</span>
        </div>
      )}
    </div>
  );
}

export function ClaudeCodeVideo({ organizationId, canMake, canAdmin }: { organizationId: string; canMake: boolean; canAdmin: boolean }) {
  const setup = useClaudeCodeSetupQuery(organizationId);
  const [choice, setChoice] = useState("auto");
  const [model, setModel] = useState("auto");
  const [brandId, setBrandId] = useState("");
  const [source, setSource] = useState<Source>("idea");
  const [idea, setIdea] = useState("");
  const [made, setMade] = useState<{ id: string; prompt: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const reset = () => { setMade(null); setRefusal(null); };
  const create = useScopedMutation({
    mutationKey: ["mutation", "claude-code.request", organizationId],
    mutationFn: (_: void) => createClaudeCodeRequest({ data: { organizationId, brandId, source, choice, model, idea } }),
    invalidate: () => [qk.claudeCodeSetup(organizationId)],
    onSuccess: (result) => {
      if (result.ok) {
        setMade({ id: result.request.id, prompt: result.prompt });
        setRefusal(null);
        void navigator.clipboard?.writeText(result.prompt).then(() => setCopied(result.request.id), () => setCopied(null));
      } else {
        setMade(null);
        setRefusal(result.reason);
      }
    },
  });
  const retry = useScopedMutation({
    mutationKey: ["mutation", "claude-code.retry", organizationId],
    mutationFn: (id: string) => retryClaudeCodeRequest({ data: { organizationId, id } }),
    invalidate: () => [qk.claudeCodeSetup(organizationId)],
    success: (_id, result) => (result.queued ? "Queued again." : "That request can no longer be run again."),
  });
  const cancel = useScopedMutation({
    mutationKey: ["mutation", "claude-code.cancel", organizationId],
    mutationFn: (id: string) => cancelClaudeCodeRequest({ data: { organizationId, id } }),
    invalidate: () => [qk.claudeCodeSetup(organizationId)],
    success: "Request cancelled. Its line stops working.",
  });

  const data = setup.data;
  const brand = data?.brands.find((item) => item.id === brandId) ?? null;
  const ready = (id: Source) => (id === "idea" ? true : brand ? brand.sources[id] : false);
  const copy = (text: string, key: string) => void navigator.clipboard?.writeText(text).then(() => setCopied(key), () => setCopied(null));
  const canGenerate = canMake && !create.isPending && ready(source) && (source !== "idea" || idea.trim().length >= 3);

  return (
    <section aria-labelledby="claude-code-video-title" className="panel space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="claude-code-video-title" className="text-section font-semibold text-fg-primary">Make a video with Claude Code</h2>
        <Badge variant="info">Free</Badge>
        <InfoButton label="making a video with Claude Code">
          <p>Claude Code makes the video on your own computer with the coded styles, so it costs nothing. Meridian keeps the brand, the budget and the project, and stores the finished MP4.</p>
          <p className="text-fg-muted">Add the connector first (the command under Chat connector above). The click records what the video is for and gives you one line to paste into Claude Code. Nothing starts until you paste it.</p>
          <p className="text-fg-muted">Prefer a video made inside Meridian, with the engine and its review gates? Use the regular Content Factory.</p>
        </InfoButton>
      </div>

      {setup.isError ? <p className="text-sm text-fg-muted">This could not be loaded. Try again in a moment.</p> : null}
      {!data && !setup.isError ? <p className="text-sm text-fg-muted">Loading...</p> : null}

      {data ? (
        <>
          <Connect organizationId={organizationId} canAdmin={canAdmin} runner={data.runner} />

          <fieldset className="space-y-2">
            <legend className={STEP}>1. What do you want to make?</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {data.choices.map((item) => (
                <label key={item.id} className={CHOICE}>
                  <input type="radio" name="claude-code-choice" className="mt-1" checked={choice === item.id} onChange={() => { setChoice(item.id); reset(); }} />
                  <span><span className="font-medium text-fg-primary">{item.label}</span><span className="block text-caption text-fg-muted">{item.plain}</span></span>
                </label>
              ))}
            </div>
            {data.choices.length === 0 ? <p className="text-sm text-fg-muted">This server has no video skills to offer.</p> : null}
          </fieldset>

          <div className="space-y-2">
            <label className={`block ${STEP}`} htmlFor="claude-code-brand">2. Which brand is it for?</label>
            <SelectInput id="claude-code-brand" value={brandId} onChange={(event) => { setBrandId(event.target.value); reset(); }}>
              <option value="">No brand (the workspace's own video)</option>
              {data.brands.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </SelectInput>
          </div>

          <fieldset className="space-y-2">
            <legend className={STEP}>3. Where does the idea come from?</legend>
            {SOURCES.map((item) => {
              const ok = ready(item.id);
              const why = item.id === "idea" ? null : !brandId ? "Pick a brand first." : ok ? null : item.id === "gathered" ? "Nothing gathered for this brand yet." : "No live plan for this brand yet.";
              return (
                <label key={item.id} className={`${CHOICE} ${ok ? "" : "text-fg-muted"}`}>
                  <input type="radio" name="claude-code-source" className="mt-1" checked={source === item.id} disabled={!ok} onChange={() => { setSource(item.id); reset(); }} />
                  <span><span className="font-medium">{item.label}</span><span className="block text-caption text-fg-muted">{why ?? item.hint}</span></span>
                </label>
              );
            })}
            <div className="space-y-1.5 pt-1">
              <label className="block text-sm text-fg-primary" htmlFor="claude-code-idea">{source === "idea" ? "The idea" : "Anything to add (optional)"}</label>
              <Textarea id="claude-code-idea" rows={2} maxLength={2000} value={idea} onChange={(event) => setIdea(event.target.value)} placeholder={source === "idea" ? "A 30-second explainer on how our subscription works" : "A tone, a length, or something to include"} />
            </div>
          </fieldset>

          <div className="space-y-2">
            <label className={`block ${STEP}`} htmlFor="claude-code-model">4. Which Claude model?</label>
            <SelectInput id="claude-code-model" value={model} onChange={(event) => { setModel(event.target.value); reset(); }}>
              {data.models.map((item) => <option key={item.id} value={item.id}>{item.label}: {item.plain}</option>)}
            </SelectInput>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" disabled={!canGenerate} onClick={() => void create.mutateAsync().catch(() => undefined)}>
              {create.isPending ? "Making..." : "Generate with Claude Code"}
            </Button>
            {!canMake ? <span className="text-caption text-fg-muted">A member or above can make a video.</span> : null}
            <a className="text-sm font-semibold underline" href="/content-factory">Or use the regular Content Factory</a>
          </div>

          {refusal ? <p role="alert" className="text-sm text-fg-primary">{refusal}</p> : null}

          {made ? (
            <div role="status" className="space-y-2 rounded-sharp border border-border-strong p-3">
              <p className="text-sm font-semibold text-fg-primary">{data.runner.online && data.runner.problems.length === 0 ? "Queued. Your computer starts it within a few seconds; follow it under Recent requests." : `No computer is running the runner, so it is waiting. Start the runner, or paste this into Claude Code yourself${copied === made.id ? " (copied)" : ""}:`}</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-sharp bg-surface-muted px-2 py-1 font-mono text-xs">{made.prompt}</code>
                <Button type="button" size="sm" variant="secondary" onClick={() => copy(made.prompt, made.id)}>
                  {copied === made.id ? <Check aria-hidden="true" className="size-4" /> : <Copy aria-hidden="true" className="size-4" />}
                  {copied === made.id ? "Copied" : "Copy"}
                </Button>
              </div>
              <p className="text-caption text-fg-muted">A request waits for 24 hours. Each one starts fresh with the model you chose, adds nothing to your Claude Code chat history, and saves the finished video to this workspace.</p>
            </div>
          ) : null}

          {data.requests.length > 0 ? (
            <div className="space-y-1 border-t border-hairline pt-3">
              <p className={STEP}>Recent requests</p>
              <ul aria-label="Recent requests" className="divide-y divide-hairline rounded-sharp border border-hairline">
                {data.requests.map((request) => (
                  <li key={request.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 truncate text-fg-primary">{request.idea}</span>
                    <Badge variant={request.status === "done" ? "success" : request.status === "failed" ? "danger" : "neutral"}>{STATUS_LABEL[request.status] ?? request.status}</Badge>
                    {request.status === "open" ? <Button type="button" variant="quiet" size="sm" onClick={() => copy(request.prompt, request.id)}>{copied === request.id ? "Copied" : "Copy line"}</Button> : null}
                    {request.status === "failed" || request.status === "claimed" ? <Button type="button" variant="quiet" size="sm" disabled={!canMake || retry.isPending} onClick={() => void retry.mutateAsync(request.id).catch(() => undefined)}>Run again</Button> : null}
                    {request.status === "open" || request.status === "claimed" || request.status === "running" ? <Button type="button" variant="quiet" size="sm" disabled={!canMake || cancel.isPending} onClick={() => void cancel.mutateAsync(request.id).catch(() => undefined)}>Cancel</Button> : null}
                    {request.lastError ? <p className="basis-full text-caption text-fg-muted">{request.lastError}</p> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

        </>
      ) : null}
    </section>
  );
}
