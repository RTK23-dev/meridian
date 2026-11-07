import { Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui";

/** The small info button. Details are there when a person wants them, never in the row itself. */
export function InfoButton({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" aria-label={`About ${label}`} className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-fg-muted hover:text-fg-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
          <Info aria-hidden="true" className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(20rem,calc(100vw-2rem))] space-y-2 text-sm">{children}</PopoverContent>
    </Popover>
  );
}
