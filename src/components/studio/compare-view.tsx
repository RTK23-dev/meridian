import { useRef, type RefObject } from "react";
import { LazyMediaPlayer } from "@/components/lazy-media-player";
import { Field, SelectInput } from "@/components/ui";
import { variantMetadataDiff } from "./compare-diff.ts";
import { frameWidthClass, frameShape } from "./aspect.ts";
import { useSyncedVideos } from "./use-synced-videos.ts";
import { hasStoredFile, kindLabel, mediaPhase, showsMedia } from "./variant-state.ts";
import type { StudioVariant } from "./types.ts";

type CompareViewProps = {
  variants: StudioVariant[];
  first: string;
  second: string;
  onChangeFirst: (assetId: string) => void;
  onChangeSecond: (assetId: string) => void;
};

function optionLabel(variant: StudioVariant, position: number): string {
  return `${kindLabel(variant.kind)} ${position}: ${variant.title || "untitled"}`;
}

/**
 * Two variants side by side. Two videos play linked: play, pause and seeking apply to both. The metadata table says, row by
 * row, which values match. Each pane shows its own stored media, or its state when the media is not stored.
 */
export function CompareView({ variants, first, second, onChangeFirst, onChangeSecond }: CompareViewProps) {
  const firstPane = useRef<HTMLDivElement | null>(null);
  const secondPane = useRef<HTMLDivElement | null>(null);
  const a = variants.find((variant) => variant.assetId === first);
  const b = variants.find((variant) => variant.assetId === second);
  const bothPlayable = !!a && !!b && a.kind === "video" && b.kind === "video"
    && showsMedia(mediaPhase(a.mediaStatus)) && showsMedia(mediaPhase(b.mediaStatus)) && hasStoredFile(a) && hasStoredFile(b);
  useSyncedVideos(firstPane, secondPane, bothPlayable);

  return (
    <section aria-labelledby="compare-heading" className="space-y-4">
      <h3 id="compare-heading" className="font-display text-xl">Compare two variants</h3>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="First variant">
          <SelectInput value={first} onChange={(event) => onChangeFirst(event.currentTarget.value)}>
            <option value="">Choose a variant</option>
            {variants.map((variant, index) => <option key={variant.assetId} value={variant.assetId}>{optionLabel(variant, index + 1)}</option>)}
          </SelectInput>
        </Field>
        <Field label="Second variant">
          <SelectInput value={second} onChange={(event) => onChangeSecond(event.currentTarget.value)}>
            <option value="">Choose a variant</option>
            {variants.map((variant, index) => <option key={variant.assetId} value={variant.assetId}>{optionLabel(variant, index + 1)}</option>)}
          </SelectInput>
        </Field>
      </div>

      {!a || !b ? <p className="text-sm text-fg-muted">Choose two variants to compare them side by side.</p> : null}
      {a && b && a.assetId === b.assetId ? <p className="text-sm text-fg-muted">Choose two different variants.</p> : null}

      {a && b && a.assetId !== b.assetId ? (
        <>
          <p className="text-sm">
            {a.promptVersion || "Prompt version not stored"} beside {b.promptVersion || "Prompt version not stored"}. They stay separate versions.
          </p>
          {bothPlayable ? (
            <p className="text-sm text-fg-muted">Linked playback is on. Play, pause and seeking on one video apply to the other. Each keeps its own controls.</p>
          ) : null}
          <div className="grid gap-4 md:grid-cols-2">
            <ComparePane label="A" variant={a} position={variants.indexOf(a) + 1} paneRef={firstPane} />
            <ComparePane label="B" variant={b} position={variants.indexOf(b) + 1} paneRef={secondPane} />
          </div>
          <div className="hidden overflow-x-auto rounded-md border border-border md:block">
            <table className="w-full min-w-[32rem] text-left text-sm">
              <caption className="sr-only">Metadata compared for the two variants. Each row says whether the values match.</caption>
              <thead className="bg-surface-2 text-xs uppercase tracking-wider text-fg-muted">
                <tr>
                  <th scope="col" className="px-3 py-2 font-semibold">Field</th>
                  <th scope="col" className="px-3 py-2 font-semibold">A</th>
                  <th scope="col" className="px-3 py-2 font-semibold">B</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Match</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {variantMetadataDiff(a, b).map((row) => (
                  <tr key={row.field} className="align-top">
                    <th scope="row" className="px-3 py-2 font-normal">{row.field}</th>
                    <td className="px-3 py-2 break-words">{row.a}</td>
                    <td className="px-3 py-2 break-words">{row.b}</td>
                    <td className="px-3 py-2 font-semibold">{row.same ? "Same" : "Different"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="grid gap-3 md:hidden">
            {variantMetadataDiff(a, b).map((row) => (
              <li key={row.field} className="space-y-2 rounded-md border border-border p-3 text-sm">
                <p className="font-semibold">{row.field}</p>
                <dl className="grid gap-2">
                  <div><dt className="text-xs font-semibold text-fg-muted">A</dt><dd className="break-words">{row.a}</dd></div>
                  <div><dt className="text-xs font-semibold text-fg-muted">B</dt><dd className="break-words">{row.b}</dd></div>
                  <div><dt className="text-xs font-semibold text-fg-muted">Match</dt><dd className="font-semibold">{row.same ? "Same" : "Different"}</dd></div>
                </dl>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function ComparePane({ label, variant, position, paneRef }: { label: string; variant: StudioVariant; position: number; paneRef: RefObject<HTMLDivElement | null> }) {
  const phase = mediaPhase(variant.mediaStatus);
  const frame = frameShape(variant.width, variant.height);
  const title = `${kindLabel(variant.kind)} ${position}`;
  return (
    <div className="space-y-2">
      <p className="text-sm font-semibold">{label} · {title} · {variant.promptVersion || "prompt version not stored"}</p>
      <div ref={paneRef} className={frameWidthClass(frame.orientation)}>
        {showsMedia(phase) && hasStoredFile(variant) ? (
          variant.kind === "video" ? (
            <LazyMediaPlayer assetId={variant.assetId} durationMs={variant.durationMs} width={variant.width} height={variant.height} />
          ) : (
            <LazyMediaPlayer kind="image" assetId={variant.assetId} alt={`${label}: ${title}`} width={variant.width ?? 16} height={variant.height ?? 9} />
          )
        ) : (
          <p role="status" className="rounded-md border border-dashed border-border p-4 text-sm text-fg-muted">
            {phase === "failed" ? "This generation failed. There is no media to compare." : showsMedia(phase) ? "The file is not stored yet, so there is nothing to compare." : "This media is still being generated. It is not stored yet."}
          </p>
        )}
      </div>
    </div>
  );
}
