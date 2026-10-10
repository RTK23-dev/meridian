import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useCalibrationQuery, useLearningQuery, usePendingVariables, useScopedMutation } from "@/lib/query/hooks";
import { decideCalibration, proposeCalibration } from "@/lib/meridian/calibration/actions";
import { hasRole } from "@/lib/meridian/access";
import { qk } from "@/lib/query/keys";
import { Button, Panel, ScreenSkeleton } from "@/components/ui";
import { PlainErrorNotice, PlainErrorState } from "@/components/plain-error";
import { StatusText } from "@/components/status";

export const Route = createFileRoute("/_app/brands/$brandId/calibration")({ staticData: { pageTitle: "Calibration" }, component: CalibrationPage });

function CalibrationPage() {
  const { brandId } = Route.useParams();
  const calibration = useCalibrationQuery(brandId);
  const learning = useLearningQuery(brandId);
  const [note, setNote] = useState<string | null>(null);
  const calibrationKey = ["mutation", "calibration", brandId] as const;
  const propose = useScopedMutation({
    mutationKey: [...calibrationKey, "propose"],
    mutationFn: () => proposeCalibration({ data: { brandId } }),
    invalidate: () => [qk.calibration(brandId)],
    onSuccess: (result) => {
      setNote("detail" in result && result.detail ? result.detail : result.status === "proposed" ? `Proposal recorded from ${result.samples} reviewer outcomes. Thresholds were not changed.` : "No proposal was stored.");
    },
  });
  const decide = useScopedMutation({
    mutationKey: [...calibrationKey, "decide"],
    mutationFn: (vars: { proposalId: string; decision: "approved" | "rejected" }) => decideCalibration({ data: { brandId, proposalId: vars.proposalId, decision: vars.decision } }),
    invalidate: () => [qk.calibration(brandId)],
    onSuccess: (result, vars) => {
      if (vars.decision === "approved") {
        setNote(result.status === "approved" ? `Approved threshold version ${result.version}.` : "Proposal was not approved.");
      } else {
        setNote("Proposal rejected. Thresholds were not changed.");
      }
    },
  });
  const deciding = usePendingVariables<{ proposalId: string }>([...calibrationKey, "decide"]).map((vars) => vars.proposalId);
  const failures = [propose.error, decide.error].filter((error): error is Error => Boolean(error));

  if (calibration.isError && !calibration.data) return <PlainErrorState error={calibration.error} onRetry={() => void calibration.refetch()} />;
  if (learning.isError && !learning.data) return <PlainErrorState error={learning.error} onRetry={() => void learning.refetch()} />;
  if (!calibration.data || !learning.data) return <ScreenSkeleton label="Loading calibration" shape="rows" />;
  const canAdmin = hasRole(learning.data.role, "admin");

  return <div className="space-y-6">
    <header><p className="text-xs font-semibold uppercase tracking-widest text-brass">JEV governance</p><h1 className="font-display text-4xl">Calibration</h1><p className="mt-2 max-w-2xl text-muted">Review proposals based on recorded reviewer outcomes. A proposal changes no threshold until an admin approves it.</p></header>
    {note ? <p role="status" className="text-sm text-muted">{note}</p> : null}{failures.map((error, index) => <PlainErrorNotice key={index} error={error} />)}
    <Panel><h2 className="font-display text-2xl">Active threshold history</h2><p className="mt-2 text-sm text-muted">Each approved version records its approver and stored threshold values. Defaults remain active until a version is approved.</p>
      {calibration.data.versions.length ? <ul className="mt-3 space-y-3">{calibration.data.versions.map((version) => <li key={version.id} className="rounded border border-line p-3"><StatusText status={`Version ${version.version}`} description={`${version.questionId} · approved by ${version.approvedBy} · ${version.thresholds}`} /></li>)}</ul> : <p className="mt-3 text-sm text-muted">No approved threshold version. Code defaults remain active.</p>}
    </Panel>
    <Panel><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-display text-2xl">Proposals</h2><p className="mt-2 text-sm text-muted">Evidence includes the reviewer sample count and disagreement. Compare current and proposed values before deciding.</p></div>
      {canAdmin ? <Button type="button" variant="quiet" disabled={propose.isPending} onClick={() => void propose.mutateAsync().catch(() => undefined)}>Propose from reviewer outcomes</Button> : null}
    </div>
    {calibration.data.proposals.length ? <ul className="mt-4 space-y-3">{calibration.data.proposals.map((proposal) => <li key={proposal.id} className="rounded border border-line p-4">
      <StatusText status={`${proposal.questionId} · ${proposal.status}`} description={proposal.samples == null ? proposal.proposed : `${proposal.samples} reviewer outcomes · disagreement ${proposal.disagreement ?? "not recorded"}`} />
      <div className="mt-3 grid gap-3 md:grid-cols-2"><div><h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Current thresholds</h3><pre className="mt-1 whitespace-pre-wrap break-words rounded bg-paper p-3 text-xs">{proposal.current || "No current threshold snapshot"}</pre></div><div><h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Proposed thresholds</h3><pre className="mt-1 whitespace-pre-wrap break-words rounded bg-paper p-3 text-xs">{proposal.proposedThresholds || proposal.proposed}</pre></div></div>
      {proposal.status === "proposed" ? canAdmin ? <div className="mt-3 flex flex-wrap gap-2"><Button type="button" disabled={deciding.includes(proposal.id)} onClick={() => void decide.mutateAsync({ proposalId: proposal.id, decision: "approved" }).catch(() => undefined)}>Approve thresholds</Button><Button type="button" variant="quiet" disabled={deciding.includes(proposal.id)} onClick={() => void decide.mutateAsync({ proposalId: proposal.id, decision: "rejected" }).catch(() => undefined)}>Reject proposal</Button></div> : <p className="mt-3 text-sm text-muted">An admin must approve or reject this proposal.</p> : null}
    </li>)}</ul> : <p className="mt-3 text-sm text-muted">No calibration proposals have been recorded.</p>}
    </Panel>
  </div>;
}
