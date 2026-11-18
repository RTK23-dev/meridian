import { ArrowRight, AudioLines, Bot, Film, ImageIcon, Scale, User } from "lucide-react";
import type { CanvasFile } from "@/lib/meridian/mcp/project-actions";
import type { Brief, Decider } from "@/lib/meridian/mcp/workflow";
import { cn } from "@/components/ui/cn";
import { CARD_H, CARD_W, DECIDER_WORDS, fileCounts, NODE_STATE_WORDS, type CanvasNode } from "./canvas-model";
import { DotMatrix } from "./dot-matrix";

/** The round puck at a card's corner: who settled the step, or who will. */
export function DeciderPuck({ who, settled, className }: { who: Decider; settled: boolean; className?: string }) {
  const Icon = who === "person" ? User : who === "chat" ? Bot : Scale;
  const words = settled
    ? `Settled by ${who === "person" ? "you" : DECIDER_WORDS[who].toLowerCase()}`
    : who === "person" ? "You choose this step" : `${DECIDER_WORDS[who]} decides this step`;
  return (
    <span className={cn("kc-puck", className)} title={words}>
      <Icon aria-hidden="true" className="size-4" />
      <span className="sr-only">{words}</span>
    </span>
  );
}

function when(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

const pad = (n: number) => String(n).padStart(2, "0");

/** One step of the video as a card. The whole card opens the step; its words come from what is stored, never from a guess. */
export function StepCard({ node, files, empty = false, onOpen, style }: { node: CanvasNode; files: CanvasFile[]; empty?: boolean; onOpen: () => void; style?: React.CSSProperties }) {
  const tone = node.state === "settled" || node.state === "working" || node.state === "options" ? "kc-card" : node.state === "yours" ? "kc-card-yours" : "kc-card-later";
  // Black on vermilion reads at 4.6:1, so the choice card's words stay full black; a faded black would not.
  const muted = tone === "kc-card" ? "kc-card-muted" : "";
  const video = node.phase === "render" || node.phase === "deliver" ? files.find((file) => file.kind === "video" && file.url) : undefined;
  const image = node.phase === "assets" ? files.find((file) => file.kind === "image" && file.url) : undefined;
  const words = NODE_STATE_WORDS[node.state];
  const titleId = `kc-step-${node.phase}`;
  const body = node.excerpt ?? (node.state === "yours" ? `${node.optionCount} options are ready for you.` : node.state === "working" ? "The chat is making this step now." : node.state === "options" ? "The chat is writing the options for you." : `Settles ${node.settles}.`);
  return (
    <article aria-labelledby={titleId} className={cn("absolute flex flex-col gap-2 p-4", tone)} style={{ width: CARD_W, height: CARD_H, ...style }}>
      {node.state === "settled" && node.decidedBy ? <DeciderPuck who={node.decidedBy} settled className="absolute -left-3 -top-3" /> : node.state !== "later" && node.state !== "stopped" ? <DeciderPuck who={node.decides === "person" ? "person" : "chat"} settled={false} className="absolute -left-3 -top-3" /> : null}
      <div className="flex items-start justify-between gap-2">
        <DotMatrix text={pad(node.index + 1)} dot={2.4} gap={1.2} label={`Step ${node.index + 1}`} />
        <span className={cn("kc-chip inline-flex items-center gap-1.5 px-2 py-0.5 text-caption font-semibold", tone === "kc-card" ? "bg-black/25" : tone === "kc-card-yours" ? "bg-black text-white" : "bg-black/10")}>
          {node.state === "working" || node.state === "options" ? <span aria-hidden="true" className="size-1.5 rounded-full bg-[var(--kc-vermilion)]" /> : null}
          {words}
        </span>
      </div>
      {video?.url ? (
        <video src={video.url} muted playsInline preload="metadata" aria-hidden="true" tabIndex={-1} className="h-16 w-full rounded-[12px] bg-black object-cover" />
      ) : image?.url ? (
        <img src={image.url} alt="" className="h-16 w-full rounded-[12px] object-cover" />
      ) : null}
      <h3 id={titleId} className="font-display text-heading font-semibold">{node.label}</h3>
      <p className={cn("line-clamp-3 text-small", muted)}>{body}</p>
      <div className="mt-auto flex items-center justify-between gap-2 text-caption">
        <span className={muted}>{empty ? "Not started" : node.state === "settled" ? when(node.resolvedAt) ?? "" : node.decides === "person" ? "You choose" : "The chat decides"}</span>
        {node.state === "yours" ? (
          <span className="kc-chip inline-flex items-center gap-1 bg-black px-2.5 py-1 font-semibold text-white">Choose <ArrowRight aria-hidden="true" className="size-3.5" /></span>
        ) : null}
      </div>
      {/* The whole card is one control, so a click anywhere on it opens the step. */}
      <button type="button" onClick={onOpen} aria-label={`Open ${node.label}: ${words}`} className="absolute inset-0 rounded-[18px]" />
    </article>
  );
}

/** The brief the video was started from, as the reference's note card: a light frame round a darker body, with the format below. */
export function BriefCard({ brief, onOpen, style }: { brief: Brief | null; onOpen: () => void; style?: React.CSSProperties }) {
  const facts = brief ? [brief.platform, brief.seconds ? `${brief.seconds} s` : null, brief.language].filter(Boolean).join(" · ") : null;
  return (
    <article aria-labelledby="kc-brief" className="kc-note absolute flex flex-col" style={{ width: CARD_W, height: CARD_H, ...style }}>
      <div className="kc-note-body flex flex-1 flex-col gap-1.5 p-3">
        <h3 id="kc-brief" className="text-small font-semibold">BRIEF · What to make</h3>
        <p className="kc-card-muted line-clamp-5 text-caption">{brief?.idea?.trim() || "No brief yet. A video starts from a short Q&A in a chat or in Claude Code."}</p>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 px-1">
        <span className="kc-chip truncate bg-black/10 px-3 py-1 text-caption">{facts || "No format yet"}</span>
        <button type="button" onClick={onOpen} aria-label="Open the brief" className="kc-plus size-8 shrink-0 rounded-full">
          <ArrowRight aria-hidden="true" className="size-4" />
        </button>
      </div>
    </article>
  );
}

/** What the video made: voice, images and the video, as three small tiles under one wire, as in the reference's file row. */
export function FilesCard({ files, onOpen, style }: { files: CanvasFile[]; onOpen: () => void; style?: React.CSSProperties }) {
  const counts = fileCounts(files);
  const tiles = [
    { id: "voice", label: "Voice", chip: "mp3", count: counts.voiceover, Icon: AudioLines, tone: "bg-[var(--kc-vermilion)] text-black" },
    { id: "images", label: "Images", chip: "png", count: counts.image, Icon: ImageIcon, tone: "bg-[var(--kc-card-top)] text-[var(--kc-card-ink)]" },
    { id: "video", label: "Video", chip: "mp4", count: counts.video, Icon: Film, tone: "bg-[var(--kc-room)] text-[var(--kc-room-ink)]" },
  ] as const;
  return (
    <article aria-labelledby="kc-files" className="absolute flex flex-col" style={{ width: CARD_W, height: CARD_H, ...style }}>
      <h3 id="kc-files" className="sr-only">Files this video made</h3>
      <div className="grid flex-1 grid-cols-3 gap-2">
        {tiles.map(({ id, label, chip, count, Icon, tone }) => (
          <button key={id} type="button" onClick={onOpen} aria-label={`${label}: ${count} ${count === 1 ? "file" : "files"}`} className="kc-tile flex flex-col items-stretch gap-1.5 p-1.5 text-left">
            <span className={cn("grid flex-1 place-items-center rounded-[12px]", tone)}>
              <span className="flex flex-col items-center gap-1">
                <Icon aria-hidden="true" className="size-6" />
                <span className="kc-chip bg-black px-1.5 text-caption text-white">{chip}</span>
              </span>
            </span>
            <span className="px-0.5 text-caption font-semibold">{label}</span>
            <span className="kc-tile-muted px-0.5 font-mono text-caption">{count} {count === 1 ? "file" : "files"}</span>
          </button>
        ))}
      </div>
    </article>
  );
}
