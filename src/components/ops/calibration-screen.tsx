import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Clock3, XCircle } from "lucide-react";
import { Badge, Button, Card, EmptyState, PageHeader, ScreenSkeleton } from "@/components/ui";
import { PlainErrorState } from "@/components/plain-error";
import { hasRole } from "@/lib/meridian/access";
import { decideCalibration, proposeCalibration } from "@/lib/meridian/calibration/actions";
import { getDecisionCalibrationReport } from "@/lib/meridian/learning/calibration-report-actions";
import { calibrationStateText } from "@/lib/meridian/learning/calibration-report";
import { getQuestionCalibration, recomputeQuestionCalibration, type QuestionCalibrationView } from "@/lib/meridian/calibration/question-actions";
import { qk } from "@/lib/query/keys";
import { useCalibrationVersionsQuery, useLearningQuery, usePendingVariables, useScopedMutation } from "@/lib/query/hooks";
import { timestampLabel, pageSpan } from "./format";
import { AdminOnlyNotice, RefusalNotice } from "./ops-shared";
import {
  baselineCopy, baselineMatchText, changeText, decisionControls, DECISION_RULES, evidenceText, FIELD_LABELS, proposalStatusText, thresholdText,
} from "./calibration-model";
import type { CalibrationProposalView } from "@/lib/meridian/calibration/versions";

export function CalibrationScreen({ brandId }: { brandId: string }) {
  const learning = useLearningQuery(brandId);
  const role = learning.data?.role ?? null;
  const canAdmin = role ? hasRole(role, "admin") : false;
  const [page, setPage] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const versions = useCalibrationVersionsQuery(brandId, page, canAdmin);
  const decisionReport = useQuery({
    queryKey: ["calibration", "decision-report", brandId],
    queryFn: () => getDecisionCalibrationReport({ data: { brandId } }),
    enabled: canAdmin,
  });
  const calibrationKey = ["mutation", "calibration", brandId] as const;
  const questionCalibration = useQuery({
    queryKey: ["calibration", "question-reports", brandId],
    queryFn: () => getQuestionCalibration({ data: { brandId } }),
    enabled: canAdmin,
  });
  const recomputeQuestions = useScopedMutation({
    mutationKey: [...calibrationKey, "question-recompute"],
    mutationFn: () => recomputeQuestionCalibration({ data: { brandId } }),
    onSuccess: async () => {
      setNote("Grading calibration recomputed from the recorded outcomes. A report that matches the newest one is not stored again.");
      await questionCalibration.refetch();
    },
  });

  const propose = useScopedMutation({
    mutationKey: [...calibrationKey, "propose"],
    mutationFn: () => proposeCalibration({ data: { brandId } }),
    invalidate: () => [qk.calibration(brandId), qk.calibrationVersions(brandId)],
    onSuccess: (result) => {
      setNote("detail" in result && result.detail
        ? result.detail
        : result.status === "proposed"
          ? `Proposal recorded from ${result.samples} reviewer outcomes. Thresholds were not changed.`
          : "No proposal was stored.");
    },
  });
  const decide = useScopedMutation({
    mutationKey: [...calibrationKey, "decide"],
    mutationFn: (vars: { proposalId: string; decision: "approved" | "rejected" }) => decideCalibration({ data: { brandId, proposalId: vars.proposalId, decision: vars.decision } }),
    invalidate: () => [qk.calibration(brandId), qk.calibrationVersions(brandId)],
    onSuccess: (result, vars) => {
      if (vars.decision === "approved") {
        setNote(result.status === "approved" ? `Approved. Threshold version ${result.version} is now the active baseline.` : "The proposal was not approved.");
      } else {
        setNote("Proposal rejected. Thresholds were not changed.");
      }
    },
  });
  const deciding = usePendingVariables<{ proposalId: string }>([...calibrationKey, "decide"]).map((vars) => vars.proposalId);
  const busy = propose.isPending || decide.isPending || recomputeQuestions.isPending;

  if (learning.isError && !learning.data) return <PlainErrorState error={learning.error} onRetry={() => void learning.refetch()} />;
  if (!learning.data) return <ScreenSkeleton label="Loading calibration" shape="rows" />;
  if (!canAdmin) {
    return (
      <div className="space-y-6">
        <PageHeader title="Calibration" description="Proposed changes to the opportunity gate thresholds." />
        <AdminOnlyNotice screen="Calibration" role={role ?? "viewer"} />
      </div>
    );
  }
  if (versions.isError && !versions.data) return <PlainErrorState error={versions.error} onRetry={() => void versions.refetch()} />;
  if (!versions.data) return <ScreenSkeleton label="Loading calibration" shape="rows" />;

  const data = versions.data;
  const baseline = baselineCopy(data.baseline, data.codeDefault);
  const decisionLine = decisionReport.data
    ? calibrationStateText(decisionReport.data)
    : decisionReport.isError
      ? "The report could not be read."
      : "Checking the report.";
  const span = pageSpan(page, data.pageSize, data.total);

  return (
    <div className="space-y-10">
      <PageHeader
        title="Calibration"
        description="Proposed changes to the opportunity gate, made from recorded reviewer outcomes. A proposal changes no threshold until an admin approves it."
        actions={<Button type="button" variant="secondary" size="md" loading={propose.isPending} disabled={busy} onClick={() => void propose.mutateAsync().catch(() => undefined)}>Check reviewer outcomes</Button>}
      />

      {note ? <p role="status" className="text-sm">{note}</p> : null}
      {propose.error ? <RefusalNotice error={propose.error} /> : null}
      {decide.error ? <RefusalNotice error={decide.error} /> : null}

      <section aria-labelledby="baseline-heading" className="space-y-3">
        <h2 id="baseline-heading" className="text-section font-semibold">Active baseline</h2>
        <Card className="space-y-2">
          <p className="font-semibold">{baseline.title}</p>
          <p className="text-sm">{baseline.detail}</p>
          {baseline.warning ? (
            <p role="alert" className="flex items-start gap-2 text-sm text-danger"><AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />Check this version before you approve another one.</p>
          ) : null}
          <p className="text-sm">Decision calibration: {decisionLine}</p>
          <p className="text-sm text-fg-muted">Thresholds are stored per workspace, not per brand. The active version is the baseline for every brand in this workspace.</p>
        </Card>
      </section>

      <section aria-labelledby="grading-heading" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="grading-heading" className="text-section font-semibold">Grading questions</h2>
          <Button type="button" variant="secondary" size="md" loading={recomputeQuestions.isPending} disabled={busy} onClick={() => void recomputeQuestions.mutateAsync().catch(() => undefined)}>Recompute from outcomes</Button>
        </div>
        <p className="text-sm text-fg-muted">
          Each grading question is calibrated from this brand&apos;s own measured outcomes. Until a question has enough outcomes, its grades stay uncalibrated and go to review. A calibrated threshold applies to the grades made after its report; a grade already stored is not asked again.
        </p>
        {questionCalibration.isError && !questionCalibration.data ? <PlainErrorState error={questionCalibration.error} onRetry={() => void questionCalibration.refetch()} /> : null}
        {questionCalibration.data ? (
          <ul className="space-y-4">
            {questionCalibration.data.questions.map((question) => (
              <GradingQuestionCard key={question.questionId} question={question} minimumSample={questionCalibration.data.minimumSample} />
            ))}
          </ul>
        ) : questionCalibration.isLoading ? <p className="text-sm text-fg-muted">Checking the grading calibration.</p> : null}
      </section>

      <section aria-labelledby="rules-heading" className="space-y-3">
        <h2 id="rules-heading" className="text-section font-semibold">How proposals are decided</h2>
        <Card>
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            {DECISION_RULES.map((rule) => <li key={rule}>{rule}</li>)}
          </ol>
        </Card>
      </section>

      <section aria-labelledby="proposals-heading" className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="proposals-heading" className="text-section font-semibold">Proposals</h2>
          <p className="text-sm text-fg-muted" aria-live="polite">
            {data.total === 0 ? "No proposals yet" : `Showing ${span.first}–${span.last} of ${data.total.toLocaleString()}`}
          </p>
        </div>

        {data.proposals.length === 0 ? (
          <EmptyState title="No proposal yet" reason="No proposal has been recorded for this brand. A proposal appears here once the reviewer outcomes meet the rules above." />
        ) : (
          <ol className="space-y-4">
            {data.proposals.map((proposal) => (
              <ProposalCard
                key={proposal.id}
                proposal={proposal}
                canAdmin={canAdmin}
                busy={busy}
                deciding={deciding.includes(proposal.id)}
                onApprove={() => void decide.mutateAsync({ proposalId: proposal.id, decision: "approved" }).catch(() => undefined)}
                onReject={() => void decide.mutateAsync({ proposalId: proposal.id, decision: "rejected" }).catch(() => undefined)}
              />
            ))}
          </ol>
        )}

        {data.total > 0 ? (
          <div className="flex items-center justify-between gap-3">
            <Button type="button" variant="secondary" size="md" disabled={page === 0 || versions.isFetching} aria-describedby={page === 0 ? "versions-page-status" : undefined} onClick={() => setPage(page - 1)}>Previous page</Button>
            <p id="versions-page-status" className="text-sm text-fg-muted">Page {page + 1} of {span.pageCount}{page === 0 ? ". You are on the first page." : page + 1 >= span.pageCount ? ". You are on the last page." : ""}</p>
            <Button type="button" variant="secondary" size="md" disabled={page + 1 >= span.pageCount || versions.isFetching} aria-describedby={page + 1 >= span.pageCount ? "versions-page-status" : undefined} onClick={() => setPage(page + 1)}>Next page</Button>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="history-heading" className="space-y-3">
        <h2 id="history-heading" className="text-section font-semibold">Approved versions</h2>
        {data.versions.length === 0 ? (
          <EmptyState title="No approved version yet" reason="No version has been approved. The code defaults stay active." />
        ) : (
          <Card>
            <ul className="divide-y divide-border">
              {data.versions.map((version) => (
                <li key={version.id} className="space-y-1 py-3 first:pt-0 last:pb-0">
                  <p className="font-semibold">Version {version.version}</p>
                  <p className="text-sm">{version.thresholds ? thresholdText(version.thresholds) : "The stored values cannot be read."}</p>
                  <p className="text-xs text-fg-muted">Approved by {version.approvedBy || "an unknown approver"} · {timestampLabel(version.createdAt)}</p>
                </li>
              ))}
            </ul>
            {data.versions.length >= 50 ? <p className="mt-3 text-xs text-fg-muted">Showing the newest 50 versions.</p> : null}
          </Card>
        )}
      </section>
    </div>
  );
}

type ReliabilityBins = NonNullable<QuestionCalibrationView["latest"]>["reliability"];

/**
 * One grading question. A threshold is shown only for a calibrated report. Anything else says how many outcomes were measured
 * against how many are needed, and never shows a threshold.
 */
function GradingQuestionCard({ question, minimumSample }: { question: QuestionCalibrationView; minimumSample: number }) {
  if (!question.calibratable) {
    return (
      <li className="space-y-2 panel">
        <h3 className="font-semibold">{question.label}</h3>
        <p className="text-sm text-fg-muted">Not calibrated. This question answers with a category, not a probability, so it has no threshold to calibrate.</p>
      </li>
    );
  }
  const report = question.latest;
  if (report && report.status === "calibrated" && report.threshold !== null) {
    const registry = question.registryThreshold;
    const applyLine = report.applied
      ? "The gate applies this threshold to the grades it decides from now on."
      : registry === null
        ? "Not applied. This question has no registry approve threshold, so calibration cannot raise a bar here."
        : `Not applied. The calibrated value is below the registry threshold ${registry.toFixed(3)}. Calibration may only raise the bar, so the registry threshold stands.`;
    return (
      <li className="space-y-3 panel">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">{question.label}</h3>
          {report.applied ? (
            <Badge variant="success"><CheckCircle2 aria-hidden="true" className="size-3.5" /><span>Calibrated and applied</span></Badge>
          ) : (
            <Badge variant="info"><Clock3 aria-hidden="true" className="size-3.5" /><span>Calibrated, not applied</span></Badge>
          )}
        </div>
        <dl className="grid gap-2 text-sm sm:grid-cols-3">
          <div><dt className="font-semibold">Calibrated threshold</dt><dd className="tabular-nums">{report.threshold.toFixed(3)}</dd></div>
          <div><dt className="font-semibold">Registry threshold</dt><dd className="tabular-nums text-fg-muted">{registry === null ? "none" : registry.toFixed(3)}</dd></div>
          <div><dt className="font-semibold">Sample size</dt><dd className="text-fg-muted">{report.sampleSize} outcomes</dd></div>
          <div><dt className="font-semibold">Report date</dt><dd className="text-fg-muted">{timestampLabel(report.createdAt)}</dd></div>
          <div><dt className="font-semibold">Method</dt><dd className="text-fg-muted">{report.methodVersion}</dd></div>
        </dl>
        <p className="text-sm">{applyLine}</p>
        <p className="text-sm text-fg-muted">{report.reason}</p>
        <ReliabilityTable bins={report.reliability} />
      </li>
    );
  }
  const measured = report ? report.sampleSize : question.measured;
  let line: string;
  if (measured < minimumSample) line = `Not enough outcomes: ${measured} of ${minimumSample} measured.`;
  else if (report) line = report.reason;
  else line = `${measured} of ${minimumSample} outcomes measured. Recompute from outcomes to store a report.`;
  return (
    <li className="space-y-2 panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">{question.label}</h3>
        <Badge variant="info"><Clock3 aria-hidden="true" className="size-3.5" /><span>Uncalibrated</span></Badge>
      </div>
      <p className="text-sm">{line}</p>
      <p className="text-sm text-fg-muted">Grades on this question go to review until it is calibrated.</p>
    </li>
  );
}

function ReliabilityTable({ bins }: { bins: ReliabilityBins }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[32rem] text-left text-sm">
        <caption className="sr-only">Stated probability against observed success, by bin</caption>
        <thead className="text-fg-muted">
          <tr>
            <th scope="col" className="py-1 pr-3 font-medium">Stated probability</th>
            <th scope="col" className="py-1 pr-3 font-medium">Outcomes</th>
            <th scope="col" className="py-1 pr-3 font-medium">Succeeded</th>
            <th scope="col" className="py-1 pr-3 font-medium">Mean stated</th>
            <th scope="col" className="py-1 font-medium">Meets target</th>
          </tr>
        </thead>
        <tbody>
          {bins.map((bin) => (
            <tr key={bin.from} className="border-t border-border">
              <td className="py-1 pr-3 tabular-nums">{bin.from.toFixed(1)} to {bin.to.toFixed(1)}</td>
              <td className="py-1 pr-3 tabular-nums">{bin.count}</td>
              <td className="py-1 pr-3 tabular-nums">{bin.successRate === null ? "none" : `${Math.round(bin.successRate * 100)}%`}</td>
              <td className="py-1 pr-3 tabular-nums">{bin.meanPredicted === null ? "none" : bin.meanPredicted.toFixed(3)}</td>
              <td className="py-1">{bin.meetsTarget ? "Yes" : "No"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProposalCard({ proposal, canAdmin, busy, deciding, onApprove, onReject }: {
  proposal: CalibrationProposalView;
  canAdmin: boolean;
  busy: boolean;
  deciding: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const controls = decisionControls(proposal, canAdmin);
  const evidence = evidenceText(proposal.evidence);
  const StatusIcon = proposal.status === "approved" ? CheckCircle2 : proposal.status === "rejected" ? XCircle : Clock3;
  const tone = proposal.status === "approved" ? "success" : proposal.status === "rejected" ? "danger" : "info";
  return (
    <li className="space-y-4 panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge variant={tone}><StatusIcon aria-hidden="true" className="size-3.5" /><span>{proposalStatusText(proposal.status)}</span></Badge>
        <span className="text-xs text-fg-muted">Recorded {timestampLabel(proposal.createdAt)}</span>
      </div>

      <dl className="grid gap-2 text-sm sm:grid-cols-3">
        <div><dt className="font-semibold">Evidence</dt><dd className="text-fg-muted">{evidence.samples}</dd></div>
        <div><dt className="font-semibold">Gap between approvals and rejections</dt><dd className="text-fg-muted">{evidence.disagreement}</dd></div>
        <div><dt className="font-semibold">Baseline</dt><dd className="text-fg-muted">{baselineMatchText(proposal.baselineChanged)}</dd></div>
      </dl>

      {proposal.changes ? (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Change against the active baseline</h3>
          <div className="grid gap-2">
            {proposal.changes.map((change) => (
              <div key={change.field} className="grid grid-cols-2 gap-x-3 gap-y-1 border-t border-border pt-3 text-sm sm:grid-cols-4">
                <p className="col-span-2 font-semibold sm:col-span-1">{FIELD_LABELS[change.field]}</p>
                <p><span className="text-xs text-fg-muted">Active</span> <span className="tabular-nums">{change.baseline.toFixed(3)}</span></p>
                <p><span className="text-xs text-fg-muted">Proposed</span> <span className="tabular-nums">{change.proposed.toFixed(3)}</span></p>
                <p><span className="text-xs text-fg-muted">Change</span> <span className="tabular-nums">{changeText(change)}</span></p>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-sm text-fg-muted">The proposed values cannot be read from this record.</p>
      )}

      {proposal.baselineChanged === true && proposal.canDecide ? (
        <p className="flex items-start gap-2 text-sm"><AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />Review the change against the current baseline before you approve.</p>
      ) : null}

      {controls.note ? <p className="text-sm text-fg-muted">{controls.note}</p> : null}
      {controls.approve || controls.reject ? (
        <div className="flex flex-wrap items-center gap-2">
          {controls.approve ? (
            <Button type="button" size="md" loading={deciding} disabled={busy} aria-label={`Approve proposal and write version ${proposal.nextVersionIfApproved}`} onClick={onApprove}>
              Approve and write version {proposal.nextVersionIfApproved}
            </Button>
          ) : null}
          {controls.reject ? (
            <Button type="button" variant="secondary" size="md" disabled={busy} onClick={onReject}>Reject proposal</Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
