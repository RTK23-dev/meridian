import { useCallback, useState } from "react";
import { aspectRatio, assetSource, durationLabel, posterSource } from "./media-source.ts";

/**
 * A stored asset (by id, served from /api/assets/<id>) or an app-relative media URL. Not wired into a screen by itself.
 */
type MediaSource = { assetId: string; url?: never } | { url: string; assetId?: never };

type VideoOptions = {
  kind?: "video";
  /** Poster image URL. Defaults to the asset's stored still (?thumb=1) when an asset id is given. Pass null for none. */
  poster?: string | null;
  durationMs?: number | null;
  width?: number | null;
  height?: number | null;
};

type ImageOptions = {
  kind: "image";
  alt: string;
  width: number;
  height: number;
};

export type MediaPlayerProps = MediaSource & (VideoOptions | ImageOptions) & { className?: string };

type LoadState = "loading" | "ready" | "error";

/** Plain words for the failure. The browser does not say which check failed, so the message lists the likely causes. */
const VIDEO_ERROR = "This video could not be played. It may have been removed, you may not have access to this workspace, or your browser may not support the file.";
const IMAGE_ERROR = "This image could not be loaded. It may have been removed, or you may not have access to this workspace.";

/**
 * The media element's events are listened to on the element itself, when React mounts it. A prop handler can miss an event
 * that fired first, and then the box would read "Loading" for a file that plays. So the listeners are attached here, and an
 * element that has already loaded is read as ready at once.
 */
export function MediaPlayer(props: MediaPlayerProps) {
  const src = props.assetId !== undefined ? assetSource(props.assetId) : props.url;
  // The result is tied to the source it was measured for, so a new source starts in the loading state again.
  const [settled, setSettled] = useState<{ src: string; ok: boolean } | null>(null);
  const state: LoadState = settled?.src === src ? (settled.ok ? "ready" : "error") : "loading";
  const className = props.className ?? "";

  const imageRef = useCallback((image: HTMLImageElement | null) => {
    if (!image) return undefined;
    const loaded = () => setSettled({ src, ok: true });
    const failed = () => setSettled({ src, ok: false });
    image.addEventListener("load", loaded);
    image.addEventListener("error", failed);
    if (image.complete) (image.naturalWidth > 0 ? loaded : failed)();
    return () => {
      image.removeEventListener("load", loaded);
      image.removeEventListener("error", failed);
    };
  }, [src]);

  const videoRef = useCallback((video: HTMLVideoElement | null) => {
    if (!video) return undefined;
    const ready = () => setSettled({ src, ok: true });
    const failed = () => setSettled({ src, ok: false });
    video.addEventListener("loadedmetadata", ready);
    video.addEventListener("error", failed);
    if (video.readyState >= 1) ready();
    else if (video.error) failed();
    return () => {
      video.removeEventListener("loadedmetadata", ready);
      video.removeEventListener("error", failed);
    };
  }, [src]);

  if (props.kind === "image") {
    return (
      <div className={className}>
        <div className="relative w-full max-w-full" style={{ aspectRatio: `${props.width} / ${props.height}` }}>
          {state === "error" ? (
            <p role="status" className="absolute inset-0 grid place-items-center rounded-md border border-line p-4 text-center text-sm text-muted">{IMAGE_ERROR}</p>
          ) : (
            <img
              ref={imageRef}
              className="absolute inset-0 h-full w-full object-contain"
              src={src}
              alt={props.alt}
              width={props.width}
              height={props.height}
              loading="lazy"
              decoding="async"
            />
          )}
          {state === "loading" ? (
            <p role="status" className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-muted">Loading image...</p>
          ) : null}
        </div>
      </div>
    );
  }

  const poster = posterSource({ poster: props.poster, assetId: props.assetId });
  const ratio = aspectRatio(props.width, props.height);
  const seconds = durationLabel(props.durationMs);
  return (
    <div className={className}>
      <div className="relative w-full max-w-full" style={{ aspectRatio: ratio }}>
        {state === "error" ? (
          <p role="status" className="absolute inset-0 grid place-items-center rounded-md border border-line p-4 text-center text-sm text-muted">{VIDEO_ERROR}</p>
        ) : (
          <video
            ref={videoRef}
            className="absolute inset-0 h-full w-full rounded-md bg-black object-contain"
            src={src}
            poster={poster}
            controls
            preload="metadata"
            aria-label="Generated video"
          />
        )}
        {state === "loading" ? (
          <p role="status" className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-white/80">Loading video...</p>
        ) : null}
      </div>
      {state === "ready" ? (
        <div className="mt-1 flex flex-wrap items-center gap-x-4 text-xs text-muted">
          <span>Stored video · {seconds}</span>
          {props.assetId !== undefined ? (
            <a className="underline underline-offset-4" href={`${src}?download=1`}>Download video</a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
