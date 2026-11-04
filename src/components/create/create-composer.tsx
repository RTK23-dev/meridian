import { useLayoutEffect, useRef } from "react";
import { ArrowUp, Check, ChevronDown, FileText, Film, Image as ImageIcon, Plus, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui";
import { MAX_MESSAGE_CHARS } from "@/lib/meridian/content-factory/model";
import { CREATE_MODE_COPY, CREATE_MODES, type CreateMode } from "./create-model";

export type ModelOption = { value: string; label: string };
export type ComposerFile = { id: string; name: string; kind: "video" | "image" | "document" | "text"; purpose: "reference_video" | "material" };

/*
 * Design rules for this composer, kept in one place so every part follows them:
 * - Square corners, as on every other control in the app (the 2px sharp radius). Controls take a strong hairline border, not a fill.
 * - One spacing grid of 4px. Text, attachments and the hint share one left edge, so the column reads straight.
 * - Icons are 20px in controls and 16px beside a label. Every target is at least 40px, and 44px on a touch screen.
 * - One accent. Only Send takes the accent, and only when it can send; everything else is hairline, ground or raised surface.
 * - Hairlines separate, shadows never do.
 */
const SHELL = "rounded-sharp";
const PILL = "inline-flex h-9 items-center gap-1.5 rounded-sharp border border-border-strong px-3.5 text-sm font-medium text-fg-primary transition-colors hover:bg-raised pointer-coarse:h-11 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

function KindIcon({ kind }: { kind: ComposerFile["kind"] }) {
  const Icon = kind === "video" ? Film : kind === "image" ? ImageIcon : FileText;
  return <Icon aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />;
}

/**
 * The input under the conversation, built as one shell: the attachments and the text on top, and one row beneath with the plus, the
 * mode, the model and Send. It sticks to the bottom of the page, so it is in reach on a phone.
 */
export function CreateComposer({
  text,
  onText,
  mode,
  onMode,
  models,
  model,
  onModel,
  files,
  onTogglePurpose,
  onRemoveFile,
  onAttach,
  canSend,
  hint,
  busy,
  onSend,
}: {
  text: string;
  onText: (text: string) => void;
  mode: CreateMode;
  onMode: (mode: CreateMode) => void;
  models: ModelOption[];
  model: string;
  onModel: (model: string) => void;
  files: ComposerFile[];
  onTogglePurpose: (id: string) => void;
  onRemoveFile: (id: string) => void;
  onAttach: () => void;
  canSend: boolean;
  hint: string;
  busy: boolean;
  onSend: () => void;
}) {
  const studio = mode === "studio";
  const field = useRef<HTMLTextAreaElement>(null);

  // The box grows with the text, up to a limit, then scrolls. Growing from the content keeps the first line in place.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const ModeIcon = mode === "studio" ? SlidersHorizontal : Sparkles;
  const modelLabel = models.find((option) => option.value === model)?.label ?? "Auto";

  return (
    <form
      aria-label="Compose"
      className="sticky bottom-0 z-10 -mx-4 bg-ground px-4 pb-4 pt-3 sm:-mx-6 sm:px-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend && !busy) onSend();
      }}
    >
      <div className={`${SHELL} border border-border-strong bg-overlay p-2 transition-colors has-[textarea:focus-visible]:border-fg-secondary`}>
        <div className="px-3 pt-1">
          {files.length > 0 ? (
            <ul aria-label="Attached files" className="mb-2 flex flex-wrap gap-2">
              {files.map((file) => (
                <li key={file.id} className="flex h-9 max-w-full items-center gap-2 rounded-sharp bg-raised py-0.5 pl-3 pr-0.5 text-caption text-fg-primary">
                  <KindIcon kind={file.kind} />
                  <span className="min-w-0 max-w-40 truncate">{file.name}</span>
                  <button
                    type="button"
                    onClick={() => onTogglePurpose(file.id)}
                    aria-label={`${file.name}: ${file.purpose === "reference_video" ? "a reference video" : "material"}. Change`}
                    className="h-7 rounded-sharp border border-border-strong px-2.5 text-caption text-fg-secondary hover:text-fg-primary"
                  >
                    {file.purpose === "reference_video" ? "Reference" : "Material"}
                  </button>
                  <button type="button" onClick={() => onRemoveFile(file.id)} aria-label={`Remove ${file.name}`} className="grid size-7 place-items-center rounded-sharp text-fg-muted hover:bg-overlay hover:text-fg-primary">
                    <X aria-hidden="true" className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <label htmlFor="create-message" className="sr-only">What should we make?</label>
          <textarea
            ref={field}
            id="create-message"
            value={text}
            rows={1}
            maxLength={MAX_MESSAGE_CHARS}
            disabled={studio}
            aria-describedby="create-hint"
            placeholder={studio ? "Studio uses the controls on this page." : "Describe the video, the product or the reference"}
            onChange={(event) => onText(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends and Shift+Enter starts a line, as in a chat app. Not while an input method is still composing a word.
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (canSend && !busy) onSend();
              }
            }}
            className="block w-full resize-none bg-transparent pb-2 pt-1 text-base leading-6 text-fg-primary placeholder:text-fg-muted focus:outline-none disabled:cursor-not-allowed disabled:text-fg-muted sm:text-body"
          />
        </div>

        <div className="flex items-center justify-between gap-2 pt-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <button
              type="button"
              onClick={onAttach}
              aria-label="Add photos, a video or a file"
              className="grid size-10 shrink-0 place-items-center rounded-sharp text-fg-primary transition-colors hover:bg-raised pointer-coarse:size-11 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <Plus aria-hidden="true" className="size-5" />
            </button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className={PILL} aria-label={`How it runs: ${CREATE_MODE_COPY[mode].label}`}>
                  <ModeIcon aria-hidden="true" className="size-4" />
                  {CREATE_MODE_COPY[mode].label}
                  <ChevronDown aria-hidden="true" className="size-3.5 text-fg-muted" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-72 p-1.5">
                {CREATE_MODES.map((id) => {
                  const Icon = id === "studio" ? SlidersHorizontal : Sparkles;
                  const selected = mode === id;
                  return (
                    <DropdownMenuItem key={id} onSelect={() => onMode(id)} className="items-start gap-3 rounded-sharp p-3">
                      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-secondary" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-fg-primary">{CREATE_MODE_COPY[id].label}</span>
                        <span className="block text-caption text-fg-muted">{CREATE_MODE_COPY[id].hint}</span>
                      </span>
                      {selected ? <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-primary" /> : null}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className={PILL} aria-label={`Model: ${modelLabel}`}>
                  {modelLabel}
                  <ChevronDown aria-hidden="true" className="size-3.5 text-fg-muted" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64 p-1.5">
                {models.map((option) => (
                  <DropdownMenuItem key={option.value} onSelect={() => onModel(option.value)} className="items-center gap-3 rounded-sharp p-3">
                    <span className="min-w-0 flex-1 text-sm text-fg-primary">{option.label}</span>
                    {model === option.value ? <Check aria-hidden="true" className="size-4 shrink-0 text-fg-primary" /> : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <button
            type="submit"
            aria-label={busy ? "Sending" : "Send"}
            aria-busy={busy || undefined}
            disabled={!canSend || busy}
            className={`grid size-10 shrink-0 place-items-center rounded-sharp transition-colors pointer-coarse:size-11 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg-primary disabled:cursor-not-allowed ${canSend ? "bg-accent text-on-accent hover:bg-accent-hover" : "bg-raised text-fg-muted"}`}
          >
            <ArrowUp aria-hidden="true" className="size-5" />
          </button>
        </div>
      </div>

      <p id="create-hint" role={canSend ? undefined : "status"} className="px-5 pt-2 text-caption text-fg-muted">{hint}</p>
    </form>
  );
}
