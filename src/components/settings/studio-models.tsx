import { useEffect, useState } from "react";
import { Button, Field, SelectInput } from "@/components/ui";
import { qk } from "@/lib/query/keys";
import { useMediaModelsQuery, useScopedMutation } from "@/lib/query/hooks";
import { saveMediaModelChoice } from "@/lib/meridian/settings/server-actions";

type Seat = {
  task: string;
  label: string;
  description: string;
  kind: "image" | "video";
  saved: { modelId: string; updatedAt: string } | null;
  unavailable: string | null;
  models: Array<{ id: string; name: string; imageUsd: number | null; usdPerSecond: number | null }>;
};
type Listing = { seats: Seat[] };

const priceOf = (seat: Seat, model: Seat["models"][number]) =>
  seat.kind === "image" ? "" : model.usdPerSecond === null ? "" : ` · $${model.usdPerSecond.toFixed(3)} per second`;

/**
 * The Studio's image and video model seats: the model OpenRouter makes Studio images (and, once wired, videos) with, from the live
 * catalogue's models of that kind with a stated price. Without a choice, the Studio's own providers apply.
 */
export function StudioModels({ organizationId, canAdmin }: { organizationId: string; canAdmin: boolean }) {
  const listing = useMediaModelsQuery(organizationId);
  const data = (listing.data as Listing | undefined) ?? null;
  if (listing.isPending) return <p className="text-sm text-fg-muted">Reading the OpenRouter catalogue...</p>;
  if (!data) return <p className="text-sm text-warning">The Studio models could not be read.</p>;
  return (
    <div className="space-y-4">
      {data.seats.map((seat) => <SeatRow key={seat.task} seat={seat} organizationId={organizationId} canAdmin={canAdmin} />)}
    </div>
  );
}

function SeatRow({ seat, organizationId, canAdmin }: { seat: Seat; organizationId: string; canAdmin: boolean }) {
  const [draft, setDraft] = useState(seat.saved?.modelId ?? "");
  useEffect(() => setDraft(seat.saved?.modelId ?? ""), [seat.saved?.modelId]);
  const save = useScopedMutation({
    mutationKey: ["mutation", "models.studio", organizationId, seat.task],
    mutationFn: (modelId: string | null) => saveMediaModelChoice({ data: { organizationId, task: seat.task, modelId } }),
    invalidate: () => [qk.mediaModels(organizationId), qk.generationModels(organizationId), qk.providerSettings(organizationId)],
    success: (_modelId, result) => (result.ok ? (result.result.status === "saved" ? `${seat.label}: ${result.result.modelId} saved.` : `${seat.label} cleared.`) : ""),
  });
  const refusal = save.data && !save.data.ok ? save.data.reason : null;
  const unchanged = draft === (seat.saved?.modelId ?? "");
  return (
    <div className="space-y-2 rounded-sharp border border-hairline bg-raised p-4">
      <div className="space-y-1">
        <p className="text-sm font-semibold text-fg-primary">{seat.label}</p>
        <p className="text-sm text-fg-muted">{seat.description}</p>
        <p className="text-sm text-fg-muted">{seat.saved ? `Chosen: ${seat.saved.modelId}.` : "Not chosen: the Studio's own providers apply."}</p>
      </div>
      {seat.unavailable ? <p className="text-sm text-warning" role="status">{seat.unavailable} No model can be chosen until it can be read.</p> : null}
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-full sm:w-96">
          <Field label={seat.label}>
            <SelectInput value={draft} onChange={(event) => setDraft(event.target.value)} disabled={!canAdmin || save.isPending || seat.models.length === 0}>
              <option value="">Not chosen</option>
              {seat.models.map((model) => <option key={model.id} value={model.id}>{model.name} ({model.id}){priceOf(seat, model)}</option>)}
            </SelectInput>
          </Field>
        </div>
        <Button type="button" variant="secondary" size="sm" disabled={!canAdmin || save.isPending || unchanged} onClick={() => void save.mutateAsync(draft === "" ? null : draft).catch(() => undefined)}>
          {save.isPending ? "Saving..." : draft === "" && seat.saved ? "Clear" : "Save"}
        </Button>
      </div>
      {refusal ? <p role="alert" className="text-sm text-danger">Not saved: {refusal}</p> : null}
    </div>
  );
}
