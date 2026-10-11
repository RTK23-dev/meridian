import { useState, type KeyboardEvent } from "react";
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui";
import { assetRoute } from "./asset-url.ts";

export type LightboxTarget = { assetId: string; title: string; alt: string; width?: number | null; height?: number | null };

const ZOOM_STEPS = [1, 1.5, 2, 3] as const;

/**
 * A stored image at full size, with zoom. The image is read through the asset route. Zoom has buttons, and the plus, minus
 * and zero keys work while the dialog is open. The parent remounts it for each image, so zoom and load state start fresh.
 */
export function ImageLightbox({ target, onClose }: { target: LightboxTarget | null; onClose: () => void }) {
  const [zoomIndex, setZoomIndex] = useState(0);
  const [failed, setFailed] = useState(false);
  const zoom = ZOOM_STEPS[zoomIndex];

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "+" || event.key === "=") setZoomIndex((index) => Math.min(index + 1, ZOOM_STEPS.length - 1));
    else if (event.key === "-") setZoomIndex((index) => Math.max(index - 1, 0));
    else if (event.key === "0") setZoomIndex(0);
    else return;
    event.preventDefault();
  }

  return (
    <Dialog open={!!target} onOpenChange={(open) => { if (!open) onClose(); }}>
      {target ? (
        <DialogContent className="max-w-4xl" onKeyDown={onKeyDown}>
          <DialogTitle className="font-display text-xl">{target.title}</DialogTitle>
          <DialogDescription className="mt-1 text-sm text-fg-muted">
            Zoom {Math.round(zoom * 100)}%. Use the buttons, or the plus, minus and zero keys.
          </DialogDescription>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="secondary" aria-label="Zoom out" disabled={zoomIndex === 0} aria-describedby={zoomIndex === 0 ? "lightbox-zoom-level" : undefined} onClick={() => setZoomIndex((index) => Math.max(index - 1, 0))}>−</Button>
            <span id="lightbox-zoom-level" aria-live="polite" className="min-w-16 text-center text-sm">
              {Math.round(zoom * 100)}%{zoomIndex === 0 ? " (smallest)" : zoomIndex === ZOOM_STEPS.length - 1 ? " (largest)" : ""}
            </span>
            <Button type="button" size="sm" variant="secondary" aria-label="Zoom in" disabled={zoomIndex === ZOOM_STEPS.length - 1} aria-describedby={zoomIndex === ZOOM_STEPS.length - 1 ? "lightbox-zoom-level" : undefined} onClick={() => setZoomIndex((index) => Math.min(index + 1, ZOOM_STEPS.length - 1))}>+</Button>
            <Button type="button" size="sm" variant="quiet" disabled={zoomIndex === 0} aria-describedby={zoomIndex === 0 ? "lightbox-zoom-level" : undefined} onClick={() => setZoomIndex(0)}>Reset zoom</Button>
          </div>
          <div className="mt-3 max-h-[70vh] overflow-auto rounded-md border border-border bg-surface-2">
            {failed ? (
              <p role="status" className="p-6 text-sm text-fg-muted">This image could not be loaded. It may have been removed, or you may not have access to this workspace.</p>
            ) : (
              <img
                src={assetRoute(target.assetId)}
                alt={target.alt}
                width={target.width ?? undefined}
                height={target.height ?? undefined}
                decoding="async"
                className="block h-auto max-w-none"
                style={{ width: `${zoom * 100}%` }}
                onError={() => setFailed(true)}
              />
            )}
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
