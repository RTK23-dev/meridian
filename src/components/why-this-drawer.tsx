import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
  Badge,
} from "@/components/ui";

export interface DecisionInspectionData {
  questionId: string;
  questionVersion?: string;
  provider: string;
  model: string;
  engineType?: "remoteJev" | "ruleEngine" | "deterministic";
  status: string;
  abstainReason?: string;
  answer?: unknown;
  probability?: number | null;
  confidence?: number | null;
  policyVersion?: string;
  calibrationVersion?: string | null;
  decidedAt?: string;
  evidenceRefs?: Array<{
    field?: string;
    artifactId?: string;
    summary?: string;
    capturedAt?: string;
  }>;
  facts?: Array<{
    label: string;
    value: string | number;
    state: "OBSERVED" | "COMPUTED" | "INFERRED" | "VALIDATED";
  }>;
  reasons?: string[];
}

interface WhyThisDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: DecisionInspectionData | null;
}

export function WhyThisDrawer({ open, onOpenChange, data }: WhyThisDrawerProps) {
  if (!data) return null;

  const isRemote = data.engineType === "remoteJev" || data.provider === "typesafe_direct" || data.provider === "openrouter";
  const isAbstain = data.status.startsWith("abstain");

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto space-y-6 p-6">
        <div>
          <Badge variant={isRemote ? "info" : "neutral"} className="uppercase mb-2">
            {isRemote ? "Model-Backed JEV Decision" : "Deterministic Rule Engine"}
          </Badge>
          <SheetTitle className="font-display text-2xl font-bold">
            Why this decision?
          </SheetTitle>
          <SheetDescription className="text-muted text-sm mt-1">
            Structured provenance, cited evidence, and decision lineage.
          </SheetDescription>
        </div>

        {/* Engine and Provider Identity */}
        <div className="rounded border border-line bg-panel p-4 space-y-2 text-sm">
          <div className="flex justify-between items-center">
            <span className="text-muted">Decision Question:</span>
            <strong className="font-mono text-xs">{data.questionId} (v{data.questionVersion || "1.0"})</strong>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-muted">Evaluated By:</span>
            <span className="font-semibold">{data.provider}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-muted">Model ID:</span>
            <span className="font-mono text-xs">{data.model}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-muted">Status:</span>
            <span className={`px-2 py-0.5 rounded text-xs font-semibold ${
              data.status === "answered" ? "bg-success/20 text-success" : "bg-warning/20 text-warning"
            }`}>
              {data.status.toUpperCase()}
            </span>
          </div>
        </div>

        {/* Abstention or Result */}
        {isAbstain ? (
          <div className="rounded border border-warning/40 bg-warning/10 p-4 text-sm text-warning space-y-1">
            <strong className="block font-semibold">Typed Abstention / Review Required</strong>
            <p className="text-xs">{data.abstainReason || "Insufficient evidence was available to form a valid decision."}</p>
          </div>
        ) : (
          <div className="rounded border border-line p-4 space-y-3">
            <h4 className="font-semibold text-sm">Decision Output</h4>
            <div className="grid grid-cols-2 gap-3 text-sm">
              {data.probability !== undefined && data.probability !== null ? (
                <div className="rounded bg-panel p-2">
                  <span className="text-xs text-muted block">Noul Probability</span>
                  <span className="text-lg font-mono font-bold">{(data.probability * 100).toFixed(1)}%</span>
                </div>
              ) : null}
              {data.confidence !== undefined && data.confidence !== null ? (
                <div className="rounded bg-panel p-2">
                  <span className="text-xs text-muted block">Confidence</span>
                  <span className="text-lg font-mono font-bold">{(data.confidence * 100).toFixed(1)}%</span>
                </div>
              ) : null}
            </div>
            {data.answer !== undefined ? (
              <div className="text-xs font-mono bg-panel p-2 rounded">
                <strong>Answer: </strong> {JSON.stringify(data.answer)}
              </div>
            ) : null}
          </div>
        )}

        {/* Cited Evidence References */}
        <div className="space-y-2">
          <h4 className="font-semibold text-sm">Cited Evidence References ({data.evidenceRefs?.length || 0})</h4>
          {data.evidenceRefs && data.evidenceRefs.length > 0 ? (
            <ul className="divide-y divide-line border border-line rounded text-xs">
              {data.evidenceRefs.map((ref, idx) => (
                <li key={idx} className="p-2.5 flex justify-between items-center">
                  <div>
                    <span className="font-semibold uppercase text-brass mr-2">{ref.field || "source"}</span>
                    <span className="text-muted">{ref.summary || ref.artifactId || "Artifact payload"}</span>
                  </div>
                  {ref.capturedAt ? <span className="text-muted font-mono">{ref.capturedAt.slice(0, 10)}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted italic">No external evidence references were cited.</p>
          )}
        </div>

        {/* Fact breakdown with Epistemic State */}
        {data.facts && data.facts.length > 0 ? (
          <div className="space-y-2">
            <h4 className="font-semibold text-sm">Epistemic Breakdown</h4>
            <div className="space-y-1.5 text-xs">
              {data.facts.map((fact, idx) => (
                <div key={idx} className="flex justify-between items-center p-2 rounded bg-panel">
                  <span>{fact.label}: <strong>{String(fact.value)}</strong></span>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold ${
                    fact.state === "OBSERVED" ? "bg-info/20 text-info" :
                    fact.state === "COMPUTED" ? "bg-success/20 text-success" :
                    fact.state === "VALIDATED" ? "bg-brass/20 text-brass" :
                    "bg-muted/20 text-muted"
                  }`}>
                    {fact.state}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* Reasons */}
        {data.reasons && data.reasons.length > 0 ? (
          <div className="space-y-1.5">
            <h4 className="font-semibold text-sm">Decision Rationale</h4>
            <ul className="list-disc list-inside text-xs text-muted space-y-1">
              {data.reasons.map((r, idx) => (
                <li key={idx}>{r}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* Footer Metadata */}
        <div className="border-t border-line pt-3 text-[11px] text-muted flex justify-between">
          <span>Policy: {data.policyVersion || "code:v1"}</span>
          <span>Calibration: {data.calibrationVersion || "uncalibrated"}</span>
          {data.decidedAt ? <span>{new Date(data.decidedAt).toLocaleString()}</span> : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
