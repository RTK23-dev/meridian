import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { AudioLines, Film, ImageIcon } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle,
  Button, DisabledReason, Drawer, RadioGroup, RadioGroupItem, Textarea,
} from "@/components/ui";
import type { CanvasFile, CanvasProject, CanvasProjectSummary } from "@/lib/meridian/mcp/project-actions";
import { clearedByReopen } from "@/lib/meridian/mcp/canvas-decisions";
import { MODE_COPY, PHASE_COPY, PHASES, type Phase } from "@/lib/meridian/mcp/workflow";
import { deciderWords, NODE_STATE_WORDS, settledText, type CanvasNode } from "./canvas-model";

const TEXT = "whitespace-pre-wrap break-words text-small text-fg-secondary";

function when(iso: string | null | undefined): string {
  if (!iso) return "an unknown time";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "an unknown time" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * One step in full: what it settles, what was settled and by whom, and, when the step is the person's and the chat has offered options,
 * the choice itself. Checkpoint text was written by a chat: it is shown as plain text, never as markup.
 */
export function StepDrawer({
  open, onOpenChange, project, node, canEdit, busy, onDecide, onReopen,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: CanvasProject | null;
  node: CanvasNode | null;
  canEdit: boolean;
  busy: boolean;
  onDecide: (phase: Phase, answer: { choice: string | null; input: string | null }) => Promise<unknown>;
  onReopen: (phase: Phase) => Promise<unknown>;
}) {
  const [choice, setChoice] = useState("");
  const [own, setOwn] = useState("");
  const [confirmReopen, setConfirmReopen] = useState(false);
  useEffect(() => {
    setChoice("");
    setOwn("");
  }, [node?.phase, project?.id]);
  if (!node) return <Drawer open={open} onOpenChange={onOpenChange} title="Step" />;
  const checkpoint = project?.checkpoints[node.phase];
  const text = settledText(checkpoint);
  const active = project?.status === "active";
  const modeLabel = project ? MODE_COPY[project.mode].label : "";
  const cleared = project ? clearedByReopen(project, node.phase).map((phase) => PHASE_COPY[phase].label) : [];
  const canSettle = canEdit && active && node.state === "yours" && (choice !== "" || own.trim() !== "");
  const previous = node.index > 0 ? PHASE_COPY[PHASES[node.index - 1]!].label : null;

  return (
    <Drawer open={open} onOpenChange={onOpenChange} title={`${node.index + 1}. ${node.label}`} description={`Settles ${node.settles}.`}>
      <p className="text-small text-fg-primary">
        <span className="font-semibold">{NODE_STATE_WORDS[node.state]}.</span>{" "}
        {node.decides === "person" ? `You choose this step in ${modeLabel} mode.` : `The chat settles this step in ${modeLabel} mode.`}
      </p>

      {node.state === "settled" ? (
        <section className="space-y-3" aria-label="What was settled">
          <p className="text-small text-fg-muted">Settled by {checkpoint?.decidedBy ? deciderWords(checkpoint.decidedBy).toLowerCase() : "an unknown decider"} on {when(checkpoint?.resolvedAt)}.{checkpoint?.choice ? ` Chosen option: ${checkpoint.choice}.` : ""}</p>
          {text ? <div className={`${TEXT} max-h-[50vh] overflow-y-auto border-l-2 border-hairline pl-3`}>{text}</div> : <p className="text-small text-fg-muted">Nothing was written down for this step.</p>}
          {checkpoint && checkpoint.options.length > 0 ? (
            <details className="text-small">
              <summary className="cursor-pointer text-fg-muted">The {checkpoint.options.length} options that were offered</summary>
              <ul className="mt-2 space-y-2">
                {checkpoint.options.map((option) => (
                  <li key={option.label}><span className="font-semibold text-fg-primary">{option.label}{option.label === checkpoint.choice ? " (chosen)" : ""}.</span> <span className={TEXT}>{option.summary}</span></li>
                ))}
              </ul>
            </details>
          ) : null}
          {active ? (
            <div className="space-y-2 pt-2">
              <Button type="button" variant="secondary" disabled={!canEdit || busy} aria-describedby={!canEdit ? "kc-reopen-reason" : undefined} onClick={() => setConfirmReopen(true)}>Reopen this step</Button>
              {!canEdit ? <DisabledReason id="kc-reopen-reason">Only a member of the workspace can reopen a step.</DisabledReason> : null}
            </div>
          ) : null}
        </section>
      ) : node.state === "yours" && checkpoint ? (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSettle) return;
            void onDecide(node.phase, { choice: own.trim() ? null : choice || null, input: own.trim() || null }).then(() => onOpenChange(false), () => undefined);
          }}
        >
          <RadioGroup label="The options the chat offered" value={choice} onValueChange={setChoice} className="space-y-2">
            {checkpoint.options.map((option, index) => (
              <label key={option.label} htmlFor={`kc-option-${index}`} className="flex cursor-pointer items-start gap-3 rounded-sharp border border-hairline p-3 has-[[data-state=checked]]:border-fg-primary">
                <RadioGroupItem id={`kc-option-${index}`} value={option.label} className="mt-1" />
                <span className="min-w-0 space-y-1">
                  <span className="block font-semibold text-fg-primary">{option.label}</span>
                  <span className={`${TEXT} block`}>{option.summary}</span>
                </span>
              </label>
            ))}
          </RadioGroup>
          <Textarea label="Or write your own" hint="Your words win over a picked option, and the next step builds on them." value={own} onChange={(event) => setOwn(event.target.value)} maxLength={20_000} />
          <div className="space-y-2">
            <Button type="submit" loading={busy} disabled={!canSettle} aria-describedby={!canEdit ? "kc-settle-reason" : undefined}>Settle the {node.label.toLowerCase()}</Button>
            {!canEdit ? <DisabledReason id="kc-settle-reason">Only a member of the workspace can choose.</DisabledReason> : null}
          </div>
        </form>
      ) : node.state === "options" ? (
        <p className="text-small text-fg-secondary">The chat is writing the options for this step. They appear here as soon as they are offered; this page checks every few seconds.</p>
      ) : node.state === "working" ? (
        <div className="space-y-2 text-small text-fg-secondary">
          <p>The chat is making this step now. The canvas follows it and shows the result when it is settled.</p>
          {project?.maker && (project.maker.status === "running" || project.maker.status === "claimed") ? (
            <p>Claude Code{project.maker.runnerName ? ` on ${project.maker.runnerName}` : ""}: {project.maker.progress || "working"}.</p>
          ) : null}
        </div>
      ) : node.state === "stopped" ? (
        <p className="text-small text-fg-secondary">This video was stopped before this step was settled.</p>
      ) : (
        <p className="text-small text-fg-secondary">{previous ? `This step comes after the ${previous.toLowerCase()}.` : "This is the first step."} {node.decides === "person" ? "You will choose it." : "The chat will settle it."}</p>
      )}

      <AlertDialog open={confirmReopen} onOpenChange={setConfirmReopen}>
        <AlertDialogContent>
          <AlertDialogTitle>Reopen the {node.label.toLowerCase()}?</AlertDialogTitle>
          <AlertDialogDescription>This clears {cleared.join(", ").toLowerCase() || "this step"}, so the chat makes {cleared.length > 1 ? "them" : "it"} again. Files already made stay listed.</AlertDialogDescription>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <AlertDialogCancel asChild><Button type="button" variant="secondary">Cancel</Button></AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button type="button" variant="danger" onClick={() => { void onReopen(node.phase).then(() => onOpenChange(false), () => undefined); }}>Reopen</Button>
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </Drawer>
  );
}

/** The workspace's videos, to open one on the canvas, and the way to stop the open one. */
export function ProjectsDrawer({
  open, onOpenChange, projects, currentId, onPick, canEdit, current, busy, onStop,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: CanvasProjectSummary[] | undefined;
  currentId: string | null;
  onPick: (id: string) => void;
  canEdit: boolean;
  current: CanvasProject | null;
  busy: boolean;
  onStop: () => Promise<unknown>;
}) {
  const [confirmStop, setConfirmStop] = useState(false);
  return (
    <Drawer open={open} onOpenChange={onOpenChange} title="Videos" description="Every video a chat or Claude Code is making with Meridian, newest first.">
      <Button asChild variant="secondary"><Link to="/create" search={{ way: "claude_code" }}>Make a new video</Link></Button>
      {projects === undefined ? <p className="text-small text-fg-muted">Loading the videos.</p> : projects.length === 0 ? (
        <p className="text-small text-fg-muted">No video yet. Start one from Create, or from a chat with the Meridian connector.</p>
      ) : (
        <ul className="divide-y divide-hairline border-y border-hairline">
          {projects.map((item) => (
            <li key={item.id}>
              <button type="button" onClick={() => onPick(item.id)} aria-current={item.id === currentId ? "true" : undefined} className="flex w-full flex-col gap-1 px-1 py-3 text-left hover:bg-raised aria-[current=true]:bg-raised">
                <span className="font-semibold text-fg-primary">{item.title}</span>
                <span className="text-caption text-fg-muted">
                  {MODE_COPY[item.mode].label} · {item.status === "active" ? (item.phase ? `at ${PHASE_COPY[item.phase as Phase]?.label ?? item.phase}` : "settled") : item.status} · {item.brandName ?? "No brand"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {current && current.status === "active" ? (
        <div className="space-y-2 pt-2">
          <Button type="button" variant="danger" disabled={!canEdit || busy} aria-describedby={!canEdit ? "kc-stop-reason" : undefined} onClick={() => setConfirmStop(true)}>Stop this video</Button>
          {!canEdit ? <DisabledReason id="kc-stop-reason">Only a member of the workspace can stop a video.</DisabledReason> : null}
        </div>
      ) : null}
      <AlertDialog open={confirmStop} onOpenChange={setConfirmStop}>
        <AlertDialogContent>
          <AlertDialogTitle>Stop “{current?.title}”?</AlertDialogTitle>
          <AlertDialogDescription>Nothing more is made or paid for this video. What is settled and the files stay. This cannot be undone.</AlertDialogDescription>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <AlertDialogCancel asChild><Button type="button" variant="secondary">Keep making it</Button></AlertDialogCancel>
            <AlertDialogAction asChild><Button type="button" variant="danger" onClick={() => void onStop()}>Stop the video</Button></AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </Drawer>
  );
}

function size(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

/** The files the video made, each playable here when the server can sign a link for it. */
export function FilesDrawer({ open, onOpenChange, files }: { open: boolean; onOpenChange: (open: boolean) => void; files: CanvasFile[] }) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange} title="Files" description="What Meridian stored for this video: voiceovers, images and the finished video.">
      {files.length === 0 ? <p className="text-small text-fg-muted">No file is stored for this video yet.</p> : (
        <ul className="space-y-4">
          {files.map((file) => {
            const Icon = file.kind === "voiceover" ? AudioLines : file.kind === "image" ? ImageIcon : Film;
            return (
              <li key={file.id} className="space-y-2 border-b border-hairline pb-4">
                <p className="flex items-center gap-2 text-small font-semibold text-fg-primary"><Icon aria-hidden="true" className="size-4" />{file.kind === "voiceover" ? "Voiceover" : file.kind === "image" ? "Image" : "Video"}</p>
                <p className="font-mono text-caption text-fg-muted">
                  {file.mediaType} · {size(file.bytes)} · {file.costUsd === null ? "cost not reported" : `$${file.costUsd.toFixed(4)}`} · {when(file.createdAt)}
                </p>
                {file.url ? (
                  file.kind === "video" ? <video src={file.url} controls preload="metadata" className="w-full rounded-sharp bg-black" />
                    : file.kind === "voiceover" ? <audio src={file.url} controls preload="none" className="w-full" />
                      : <img src={file.url} alt="An image made for this video" className="w-full rounded-sharp" />
                ) : (
                  <p className="text-small text-fg-muted">This server has no key to sign file links, so the file cannot be opened here.</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Drawer>
  );
}

/** The brief the video started from: the person's answers to the chat's short Q&A. */
export function BriefDrawer({ open, onOpenChange, project }: { open: boolean; onOpenChange: (open: boolean) => void; project: CanvasProject | null }) {
  const brief = project?.brief;
  const rows: Array<[string, string | null | undefined]> = brief ? [
    ["Idea", brief.idea],
    ["Goal", brief.goal],
    ["Platform", brief.platform],
    ["Length", brief.seconds ? `${brief.seconds} seconds` : null],
    ["Language", brief.language],
    ["Audience", brief.audience],
    ["Style", brief.style?.label],
    ["Voice", brief.voice ? (brief.voice.wanted ? `Yes: ${brief.voice.tone || "no tone given"}` : "No voiceover") : null],
    ["Render", brief.render === "chat" ? "An MP4, rendered by the chat" : brief.render === "code_only" ? "The code and the files" : null],
    ["Brand", project?.brandName ?? (project?.brandId ? "A brand of this workspace" : "No brand: paid from the monthly budget")],
  ] : [];
  return (
    <Drawer open={open} onOpenChange={onOpenChange} title="Brief" description="The answers the video started from.">
      {rows.length === 0 ? <p className="text-small text-fg-muted">No video is open.</p> : (
        <dl className="space-y-3">
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt className="eyebrow">{label}</dt>
              <dd className={TEXT}>{value?.toString().trim() || "Not given"}</dd>
            </div>
          ))}
        </dl>
      )}
    </Drawer>
  );
}
