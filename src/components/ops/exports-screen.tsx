import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button, Card, Field, PageHeader, SelectInput } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { downloadCsvText } from "@/lib/csv";
import { hasRole } from "@/lib/meridian/access";
import { libraryCsv, opportunitiesCsv, performanceCsv } from "@/lib/meridian/exports/csv";
import { listLibrary, listOpportunities } from "@/lib/meridian/machine";
import { exportAuditCsv } from "@/lib/meridian/observability/actions";
import { getPerformanceRowsForExport } from "@/lib/meridian/performance/actions";
import { auditExportNote } from "./audit-model";
import { exportFilename } from "./format";
import { RefusalNotice } from "./ops-shared";
import { libraryExportRows, opportunityExportRows, rowsNote } from "./exports-model";

export function ExportsScreen() {
  const { data: workspace } = useWorkspace();
  const organizationId = workspace?.active?.id ?? "";
  const role = workspace?.active?.role ?? "viewer";
  const canAdmin = hasRole(role, "admin");
  const brands = workspace?.brands ?? [];
  const [brandChoice, setBrandChoice] = useState("");
  const brandId = brands.some((brand) => brand.id === brandChoice) ? brandChoice : (brands[0]?.id ?? "");

  // Each export is built only when its button is pressed. Nothing is cached, so each press reads the rows again.
  const opportunityExport = useMutation({
    mutationFn: async () => {
      const result = await listOpportunities({ data: { brandId } });
      const rows = opportunityExportRows(result.opportunities);
      downloadCsvText(exportFilename("meridian-opportunities", new Date()), opportunitiesCsv(rows));
      return rows.length;
    },
  });
  const libraryExport = useMutation({
    mutationFn: async () => {
      const result = await listLibrary({ data: { brandId } });
      const rows = libraryExportRows(result.creatives);
      downloadCsvText(exportFilename("meridian-library", new Date()), libraryCsv(rows));
      return rows.length;
    },
  });
  const performanceExport = useMutation({
    mutationFn: async () => {
      const rows = await getPerformanceRowsForExport({ data: { brandId } });
      downloadCsvText(exportFilename("meridian-performance", new Date()), performanceCsv(rows));
      return rows.length;
    },
  });
  const auditExport = useMutation({
    mutationFn: () => exportAuditCsv({ data: { organizationId } }),
    onSuccess: (result) => downloadCsvText(exportFilename("meridian-audit", new Date()), result.csv),
  });

  if (!workspace?.active) return null;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Exports"
        description="Exports are generated when you click. Each file is built from the records in this workspace and downloads to this device."
      />

      {brands.length > 0 ? (
        <Field label="Brand for opportunities and library" hint="Each brand is exported on its own.">
          <SelectInput value={brandId} onChange={(event) => setBrandChoice(event.target.value)}>
            {brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
          </SelectInput>
        </Field>
      ) : (
        <Card><p className="text-sm text-fg-muted">Create a brand to export its opportunities and library.</p></Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <ExportPanel
          id="opportunities-export"
          title="Opportunities"
          description="One row per opportunity for the selected brand, with its rank score, JEV decision, probability, evidence confidence, risk and reason. An empty cell means the value is not stored."
          action={<Button type="button" variant="secondary" size="md" disabled={!brandId} loading={opportunityExport.isPending} onClick={() => opportunityExport.mutate()}>Export opportunities</Button>}
          result={opportunityExport.data !== undefined ? rowsNote(opportunityExport.data, "opportunity", "opportunities") : null}
          error={opportunityExport.error}
        />
        <ExportPanel
          id="library-export"
          title="Library"
          description="The newest 50 creative records for the selected brand: ID, title, hook, angle, status, origin and creation time. Media files are not included."
          action={<Button type="button" variant="secondary" size="md" disabled={!brandId} loading={libraryExport.isPending} onClick={() => libraryExport.mutate()}>Export library</Button>}
          result={libraryExport.data !== undefined ? rowsNote(libraryExport.data, "creative record") : null}
          error={libraryExport.error}
        />
        {canAdmin ? (
          <ExportPanel
            id="audit-export"
            title="Audit log"
            description="The newest audit entries for this workspace, up to the export cap of 5,000 rows. Filter the audit log first to export a narrower set."
            action={<div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" size="md" loading={auditExport.isPending} onClick={() => auditExport.mutate()}>Export audit log</Button><Link to="/audit" className="inline-flex min-h-11 items-center text-sm font-semibold text-accent underline-offset-4 hover:underline">Filter the audit log first</Link></div>}
            result={auditExport.data ? auditExportNote(auditExport.data) : null}
            error={auditExport.error}
          />
        ) : (
          <ExportPanel
            id="audit-export"
            title="Audit log"
            description="Audit exports are for workspace admins. Ask an admin if you need the log."
          />
        )}
        <ExportPanel
          id="performance-export"
          title="Performance rows"
          description="One row per stored performance observation for the selected brand. A spend, impression, reach, click, conversion or revenue value that was never recorded is an empty cell, not 0."
          action={<Button type="button" variant="secondary" size="md" disabled={!brandId} loading={performanceExport.isPending} onClick={() => performanceExport.mutate()}>Export performance rows</Button>}
          result={performanceExport.data !== undefined ? rowsNote(performanceExport.data, "performance row") : null}
          error={performanceExport.error}
        />
      </div>
    </div>
  );
}

function ExportPanel({ id, title, description, action, result, error }: {
  id: string;
  title: string;
  description: string;
  action?: ReactNode;
  result?: string | null;
  error?: unknown;
}) {
  return (
    <Card aria-labelledby={`${id}-title`} className="space-y-3">
      <h2 id={`${id}-title`} className="text-section font-semibold">{title}</h2>
      <p className="text-sm text-fg-muted">{description}</p>
      {action ? <div>{action}</div> : null}
      {error ? <RefusalNotice error={error} /> : null}
      {result ? <p role="status" className="text-sm">{result}</p> : null}
    </Card>
  );
}
