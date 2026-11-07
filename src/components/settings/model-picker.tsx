import { useState } from "react";
import { Command } from "cmdk";
import { Check, ChevronsUpDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui";
import { cn } from "@/components/ui/cn";
import { matchesSearch } from "./models-model";

export type PickerOption = {
  id: string;
  /** What the person reads: the model's name. The id is searchable too. */
  title: string;
  /** One short line under the name, such as the price. */
  detail?: string | null;
  /** The heading the option sits under (its provider). Options arrive already in order. */
  group: string;
  /** A word or two beside the name, such as "latest". */
  tag?: string | null;
  /** Shown instead of the detail, and the option cannot be picked. */
  disabledReason?: string | null;
};

export type PickerTone = "chosen" | "muted" | "warning";

const GROUP_CLASS = "px-1 py-1.5 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-fg-muted";
const ITEM_CLASS = "flex cursor-pointer items-start gap-2 rounded-sharp px-2 py-1.5 text-sm text-fg-primary pointer-coarse:min-h-11 aria-selected:bg-raised data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-60";

/**
 * A model choice as one compact button: it shows what is used now, and opens a searchable list grouped by provider. Picking a model hands
 * it to `onPick` at once (the caller saves it through the server, which checks it again); `clear` adds the way back to Auto at the top.
 */
export function ModelPicker({
  label,
  valueId,
  valueText,
  tone = "chosen",
  options,
  clear,
  onPick,
  onClear,
  disabled,
  busy,
  emptyText = "No model matches.",
  className,
}: {
  label: string;
  /** The model in use now; null means none is chosen (the clear option is ticked); left out when there is no single current one. */
  valueId?: string | null;
  valueText: string;
  tone?: PickerTone;
  options: PickerOption[];
  clear?: { label: string; detail?: string } | null;
  onPick: (id: string) => void;
  onClear?: () => void;
  disabled?: boolean;
  busy?: boolean;
  emptyText?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const groups: Array<{ group: string; options: PickerOption[] }> = [];
  for (const option of options) {
    const last = groups[groups.length - 1];
    if (last && last.group === option.group) last.options.push(option);
    else groups.push({ group: option.group, options: [option] });
  }
  const choose = (run: () => void) => () => {
    setOpen(false);
    run();
  };

  return (
    // While a save runs the list stays shut, but the button stays focusable: a disabled button would drop the focus Radix hands back.
    <Popover open={open} onOpenChange={(next) => setOpen(next && !busy)}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${label}: ${busy ? "saving" : valueText}`}
          aria-busy={busy || undefined}
          disabled={disabled}
          className={cn(
            "inline-flex h-9 min-w-0 max-w-full items-center gap-2 rounded-sharp border border-border-strong bg-overlay px-3 text-sm hover:border-fg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:border-hairline disabled:hover:border-hairline pointer-coarse:min-h-11",
            tone === "chosen" ? "text-fg-primary" : tone === "warning" ? "text-warning" : "text-fg-muted",
            className,
          )}
        >
          <span className="min-w-0 flex-1 truncate text-left">{busy ? "Saving..." : valueText}</span>
          <ChevronsUpDown aria-hidden="true" className="size-3.5 shrink-0 text-fg-muted" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} collisionPadding={16} className="w-[min(24rem,calc(100vw-2rem))] p-0">
        <Command label={label} filter={matchesSearch}>
          <Command.Input placeholder="Search models" className="h-11 w-full border-b border-hairline bg-transparent px-3 text-base text-fg-primary placeholder:text-fg-muted focus-visible:outline-offset-[-2px] sm:text-sm" />
          <Command.List className="max-h-[min(20rem,50vh)] overflow-y-auto overscroll-contain p-1">
            <Command.Empty className="p-3 text-sm text-fg-muted">{emptyText}</Command.Empty>
            {clear && onClear ? (
              <Command.Group className={GROUP_CLASS}>
                <Command.Item value={`__clear ${clear.label}`} onSelect={choose(onClear)} className={ITEM_CLASS}>
                  <Check aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", valueId === null ? "opacity-100" : "opacity-0")} />
                  <span className="min-w-0 flex-1">
                    <span className="block">{clear.label}</span>
                    {clear.detail ? <span className="block text-xs text-fg-muted">{clear.detail}</span> : null}
                  </span>
                </Command.Item>
              </Command.Group>
            ) : null}
            {groups.map((group) => (
              <Command.Group key={group.group} heading={group.group} className={GROUP_CLASS}>
                {group.options.map((option) => (
                  <Command.Item
                    key={option.id}
                    value={`${option.title} ${option.id}`}
                    disabled={Boolean(option.disabledReason)}
                    onSelect={choose(() => onPick(option.id))}
                    className={ITEM_CLASS}
                  >
                    <Check aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", valueId === option.id ? "opacity-100" : "opacity-0")} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">
                        {option.title}
                        {option.tag ? <span className="ml-2 text-xs text-fg-muted">{option.tag}</span> : null}
                      </span>
                      <span className="block truncate text-xs text-fg-muted">{option.disabledReason ?? option.detail ?? option.id}</span>
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            ))}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
