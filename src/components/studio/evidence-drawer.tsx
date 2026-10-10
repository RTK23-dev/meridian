import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui";
import { TechnicalDetails } from "@/components/plain-error";
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
            <div className="mt-4 hidden overflow-x-auto rounded-md border border-border md:block">
              <table className="w-full min-w-[44rem] text-left text-sm">
                <caption className="sr-only">Decision questions stored for this variant</caption>
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
                      <td colSpan={7} className="px-3 py-4 text-fg-muted">No decision record is stored for this variant.</td>
                    </tr>
                  ) : questions.map((question) => (
                    <tr key={question.id} className="align-top">
                      <th scope="row" className="px-3 py-2 font-mono text-xs font-normal">{question.id}</th>
                      <td className="px-3 py-2">{describeQuestion(question.id)}</td>
                      <td className="px-3 py-2">{question.answer || "Unrecorded"}</td>
                      <td className="px-3 py-2 font-semibold">
                        {decisionPlainLabel(question.decision)}
                        <TechnicalDetails>Decision code: {question.decision || "none"}</TechnicalDetails>
                      </td>
                      <td className="px-3 py-2 tabular-nums">{formatUnitInterval(question.probability)}</td>
                      <td className="px-3 py-2 tabular-nums">{formatUnitInterval(question.confidence)}</td>
                      <td className="px-3 py-2">{question.reasons.length > 0 ? question.reasons.join(" ") : "No reason stored."}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="mt-4 grid gap-3 md:hidden">
              {questions.length === 0 ? (
                <li className="rounded-md border border-border p-3 text-sm text-fg-muted">No decision record is stored for this variant.</li>
              ) : questions.map((question) => (
                <li key={question.id} className="space-y-2 rounded-md border border-border p-3 text-sm">
                  <p className="font-mono text-xs text-fg-muted">{question.id}</p>
                  <p>{describeQuestion(question.id)}</p>
                  <dl className="grid gap-2">
                    <div><dt className="text-xs font-semibold text-fg-muted">Answer</dt><dd>{question.answer || "Unrecorded"}</dd></div>
                    <div><dt className="text-xs font-semibold text-fg-muted">Decision</dt><dd className="font-semibold">{decisionPlainLabel(question.decision)}<TechnicalDetails>Decision code: {question.decision || "none"}</TechnicalDetails></dd></div>
                    <div><dt className="text-xs font-semibold text-fg-muted">Probability</dt><dd className="tabular-nums">{formatUnitInterval(question.probability)}</dd></div>
                    <div><dt className="text-xs font-semibold text-fg-muted">Confidence</dt><dd className="tabular-nums">{formatUnitInterval(question.confidence)}</dd></div>
                    <div><dt className="text-xs font-semibold text-fg-muted">Reason</dt><dd>{question.reasons.length > 0 ? question.reasons.join(" ") : "No reason stored."}</dd></div>
                  </dl>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
