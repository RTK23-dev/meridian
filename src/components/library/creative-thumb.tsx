import { useState } from "react";
import { previewBox, thumbnailSrc, type LibraryMediaVariant } from "./library-model";

/**
 * A still of a stored asset from the asset route. Lazy loaded, with width and height set so the box is reserved before the
 * bytes arrive. When the file cannot be loaded, the box says so in text. It never shows a stand-in image.
 */
export function CreativeThumb({ variant, alt }: { variant: LibraryMediaVariant; alt: string }) {
  const src = thumbnailSrc(variant);
  const box = previewBox(variant);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const state = failedSrc === src ? "error" : loadedSrc === src ? "ready" : "loading";

  return (
    <div className="relative w-full max-w-full overflow-hidden rounded-md border border-border bg-surface-2" style={{ aspectRatio: `${box.width} / ${box.height}` }}>
      {state === "error" ? null : (
        <img
          className="absolute inset-0 h-full w-full object-contain"
          src={src}
          alt={alt}
          width={box.width}
          height={box.height}
          loading="lazy"
          decoding="async"
          onLoad={() => setLoadedSrc(src)}
          onError={() => setFailedSrc(src)}
        />
      )}
      {state === "loading" ? (
        <span className="pointer-events-none absolute inset-0 grid place-items-center p-4 text-center text-sm text-fg-muted">Loading preview</span>
      ) : null}
      {state === "error" ? (
        <span className="absolute inset-0 grid place-items-center p-4 text-center text-sm text-fg-muted">Preview unavailable. The stored file could not be loaded.</span>
      ) : null}
    </div>
  );
}
