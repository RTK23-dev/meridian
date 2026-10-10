import type { ReactNode } from "react";
import { Badge, Popover, PopoverContent, PopoverTrigger, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui";
import { IDEA_TO_TEST } from "@/lib/copy";

/**
 * Short definitions for the terms the screens use. Each one matches the code it describes. docs/GLOSSARY.md lists the same
 * terms with their sources.
 */
const TERMS = {
  jev: {
    label: "JEV",
    description: "The decision engine. It reads the stored evidence and returns a decision, a probability and a confidence. It recommends or routes work, and the configured approval steps still apply.",
  },
  hypit: {
    label: "Hypit",
    description: "The video production engine. It runs as a separate process and renders from an approved brief. A clip is stored only after it returns verified MP4 bytes.",
  },
  confidence: {
    label: "Confidence",
    description: "How strongly the stored evidence supports a decision. It is not a guarantee of future ad performance.",
  },
  probability: {
    label: "Probability",
    description: "The decision engine's estimate for its question, from 0% to 100%. It is not a measured result, and it is not calibrated against outcomes until a calibration report says so.",
  },
} as const;

export type TermId = keyof typeof TERMS;

const FOCUS = "rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/**
 * A term with a short definition in a popover. The trigger is a button, so it opens with Enter or Space, and Escape closes
 * it and returns focus to the trigger. The children replace the term's own label when a screen needs a different sentence.
 */
export function Term({ id, children }: { id: TermId; children?: ReactNode }) {
  const term = TERMS[id];
  return (
    <Popover>
      <PopoverTrigger className={`cursor-help underline decoration-dotted underline-offset-4 ${FOCUS}`}>{children ?? term.label}</PopoverTrigger>
      <PopoverContent side="top" className="max-w-xs text-sm">{term.description}</PopoverContent>
    </Popover>
  );
}

/** The badge for an idea that no stored data backs yet. Its tooltip says what the badge means, on hover and on keyboard focus. */
export function IdeaToTestBadge() {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" className={`inline-flex ${FOCUS}`}>
            <Badge variant="warning">{IDEA_TO_TEST.badge}</Badge>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-64">{IDEA_TO_TEST.tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** A rule behind a number or a state that the screen does not print. The tooltip opens on hover and on keyboard focus. */
export function InfoTip({ label, text }: { label: string; text: string }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" className={`cursor-help underline decoration-dotted underline-offset-4 ${FOCUS}`}>{label}</button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-72">{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
