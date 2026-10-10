import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui";
import { describeQuestion } from "./jev-question-text.ts";
import { decisionPlainLabel, formatUnitInterval, summarizeEvidence } from "./evidence.ts";
import type { StudioVariant } from "./types.ts";

/** The JEV rows stored for one variant, with a plain-language summary above the table. Read-only. */
export function EvidenceDrawer({ variant, onClose }: { variant: StudioVariant | null; onClose: () => void }) {
  const questions = variant?.questions ?? [];
  return (
    <Sheet open={!!variant} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent className="left-auto right-0 top-0 bottom-0 max-h-none w-full max-w-3xl rounded-none border-l border-t-0">
        {variant ? (
          <>
            <SheetTitle className="font-display text-2xl">Evidence for {variant.title || variant.kind}</SheetTitle>
            <SheetDescription className="mt-2 text-sm">{summarizeEvidence(questions)}</SheetDescription>
            <div className="mt-4 overflow-x-auto rounded-md border border-border">
              <table className="w-full min-w-[44rem] text-left text-sm">
                <caption className="sr-only">JEV questions stored for this variant</caption>
                <thead className="bg-surface-2 text-xs uppercase tracking-wider text-fg-muted">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-semibold">ID</th>
                    <th scope="col" className="px-3 py-2 font-semibold">Question</th>
                    <th scope="col" className="px-3 py-2 font-semibold">Answer</th>
                    <th scope="col" className="px-3 py-2 font-semibold">Decision</th>
                    <th scope="col" className="px-3 py-2 font-semibold">Probability</th>
                    <th scope="col" className="px-3 py-2 font-semibold">Confidence</th>
                    <th scope="col" className="px-3 py-2 font-semibold">Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {questions.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-3 py-4 text-fg-muted">No JEV row is stored for this variant.</td>
                    </tr>
                  ) : questions.map((question) => (
                    <tr key={question.id} className="align-top">
                      <th scope="row" className="px-3 py-2 font-mono text-xs font-normal">{question.id}</th>
                      <td className="px-3 py-2">{describeQuestion(question.id)}</td>
                      <td className="px-3 py-2">{question.answer || "Unrecorded"}</td>
                      <td className="px-3 py-2 font-semibold">
                        {decisionPlainLabel(question.decision)}
                        <span className="block font-mono text-xs font-normal text-fg-muted">{question.decision || "none"}</span>
                      </td>
                      <td className="px-3 py-2 tabular-nums">{formatUnitInterval(question.probability)}</td>
                      <td className="px-3 py-2 tabular-nums">{formatUnitInterval(question.confidence)}</td>
                      <td className="px-3 py-2">{question.reasons.length > 0 ? question.reasons.join(" ") : "No reason stored."}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
