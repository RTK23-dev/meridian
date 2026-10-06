import { useState } from "react";

export function MediaPlayer({ assetId, poster, durationMs, width, height, className = "" }: {
  assetId: string;
  poster?: string;
  durationMs?: number | null;
  width?: number | null;
  height?: number | null;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={className}>
      {failed ? <p role="status" className="rounded-md border border-line p-4 text-sm text-muted">This stored video could not be loaded. Check your workspace access and try again.</p> : (
        <video
          className="max-h-[70vh] w-full rounded-md bg-black object-contain"
          style={{ aspectRatio: width && height ? `${width} / ${height}` : "16 / 9" }}
          src={`/api/assets/${encodeURIComponent(assetId)}`}
          poster={poster}
          controls
          preload="metadata"
          aria-label="Stored generated video"
          onError={() => setFailed(true)}
          {...(durationMs ? { "data-duration-ms": durationMs } : {})}
        />
      )}
      {!failed ? <p role="status" className="mt-1 text-xs text-muted">Stored MP4 · {durationMs ? `${(durationMs / 1000).toFixed(1)} seconds` : "duration not stored"}</p> : null}
      {!failed ? <a className="mt-1 inline-block text-sm underline underline-offset-4" href={`/api/assets/${encodeURIComponent(assetId)}?download=1`}>Download stored video</a> : null}
    </div>
  );
}
