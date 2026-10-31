import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button, Card, Field, SelectInput } from "@/components/ui";
import { checkExportPackage } from "@/lib/meridian/distribution/export-package-actions";
import type { ExportCheck } from "@/lib/meridian/distribution/export-package-actions";
import { listLibrary } from "@/lib/meridian/machine";
import { RefusalNotice } from "./ops-shared";

function downloadJson(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/** One creative's export package, checked for disclosure before it can be downloaded. Blocked creatives say why, in plain words. */
export function ExportPackagePanel({ organizationId, brandId }: { organizationId: string; brandId: string }) {
  const [creativeChoice, setCreativeChoice] = useState("");
  const library = useQuery({
    queryKey: ["exports", "library-for-package", brandId],
    enabled: brandId !== "",
    queryFn: () => listLibrary({ data: { brandId } }),
  });
  const creatives = library.data?.creatives ?? [];
  const creativeId = creatives.some((creative) => creative.id === creativeChoice) ? creativeChoice : (creatives[0]?.id ?? "");

  const check = useMutation<ExportCheck, Error, void>({
    mutationFn: () => checkExportPackage({ data: { organizationId, brandId, creativeId } }),
  });

  return (
    <Card className="space-y-4 p-6" id="export-package">
      <h2 className="text-section font-semibold">Export package</h2>
      <p className="text-small text-fg-muted">
        The files and copy for one creative, for posting by hand. Before the package can be downloaded, it must pass the disclosure check:
        generated video needs an AI label, a provenance record and the platform's AI flag. If it fails, the reasons are listed here.
      </p>
      {library.error ? <RefusalNotice error={library.error} /> : null}
      {creatives.length === 0 ? (
        <p className="text-small text-fg-muted">This brand has no creatives to package yet.</p>
      ) : (
        <Field label="Creative">
          <SelectInput value={creativeId} onChange={(event) => { setCreativeChoice(event.target.value); check.reset(); }}>
            {creatives.map((creative) => <option key={creative.id} value={creative.id}>{creative.title}</option>)}
          </SelectInput>
        </Field>
      )}
      <Button type="button" variant="secondary" size="md" disabled={creativeId === ""} loading={check.isPending} onClick={() => check.mutate()}>
        Check export package
      </Button>

      {check.error ? <RefusalNotice error={check.error} /> : null}
      {check.data && check.data.passed && check.data.package ? (
        <div className="space-y-3">
          <p role="status" className="text-small">The package passed the disclosure check.</p>
          <Button type="button" variant="secondary" size="md" onClick={() => downloadJson(`${creativeId}-export-package.json`, check.data?.package)}>
            Download package (JSON)
          </Button>
        </div>
      ) : null}
      {check.data && !check.data.passed ? (
        <div className="space-y-2">
          <p role="status" className="text-small font-semibold">The package is blocked. Nothing was downloaded.</p>
          <ul className="list-disc space-y-1 pl-5 text-small">
            {check.data.reasons.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}
