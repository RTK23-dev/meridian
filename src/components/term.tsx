import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui";

const TERMS = {
  jev: { label: "JEV", description: "The decision engine that evaluates evidence, confidence, and policy. It recommends or routes a decision; people retain the configured approval steps." },
  hypit: { label: "Hypit", description: "The video production engine. It renders from an approved brief and stores the returned video artifact." },
  confidence: { label: "Confidence", description: "How strongly the stored evidence supports a decision. It is not a guarantee of future ad performance." },
} as const;

export function Term({ id }: { id: keyof typeof TERMS }) {
  const term = TERMS[id];
  return (
    <Popover>
      <PopoverTrigger className="cursor-help underline decoration-dotted underline-offset-4">{term.label}</PopoverTrigger>
      <PopoverContent side="top" className="max-w-xs text-sm">{term.description}</PopoverContent>
    </Popover>
  );
}
