import { Button } from "@/components/ui";
import { CreativeThumb } from "./creative-thumb";
import { downloadHref, primaryMedia, type LibraryCreative, type LibraryMediaVariant, type MediaLoad } from "./library-model";

function formatDay(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? "Date not recorded" : new Date(time).toLocaleDateString();
}

/** What the media area says when there is no stored file to preview. Each state is a sentence, not a stand-in picture. */
function MediaPlaceholder({ load, variants }: { load: MediaLoad; variants: readonly LibraryMediaVariant[] }) {
  const text = load === "loading"
    ? "Loading media"
    : load === "unavailable"
      ? "Media status is unavailable right now. Try again shortly."
      : variants.length === 0
        ? "No stored media for this creative yet."
        : `Media ${variants[0]?.mediaStatus || "not recorded"}. No stored file to preview yet.`;
  return (
    <div className="grid aspect-video place-items-center rounded-md border border-dashed border-border-strong bg-surface-2 p-4 text-center text-sm text-fg-muted">
      {text}
    </div>
  );
}

export function CreativeCard({
  item,
  variants,
  mediaLoad,
  onTrace,
}: {
  item: LibraryCreative;
  variants: readonly LibraryMediaVariant[];
  mediaLoad: MediaLoad;
  onTrace: () => void;
}) {
  const label = item.title || item.hook || "Untitled creative";
  const media = primaryMedia(variants);
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      {media ? (
        <CreativeThumb variant={media} alt={`${media.kind === "video" ? "Poster of video" : "Stored image of"} ${label}`} />
      ) : (
        <MediaPlaceholder load={mediaLoad} variants={variants} />
      )}
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="font-display text-xl">{label}</h3>
        <span className="text-xs font-semibold uppercase tracking-widest text-brass">{item.status}</span>
      </div>
      <p className="text-sm text-muted">{item.angle} · {item.origin} · {formatDay(item.createdAt)}</p>
      <p className="line-clamp-3 text-sm">{item.hook}</p>
      <div className="mt-auto flex flex-wrap gap-2">
        <Button variant="quiet" size="md" aria-label={`Trace ${label}`} onClick={onTrace}>Trace</Button>
        {media ? (
          <Button asChild variant="quiet" size="md">
            <a href={downloadHref(media.assetId)} aria-label={`Download ${media.kind === "video" ? "video" : "image"} for ${label}`}>Download</a>
          </Button>
        ) : null}
      </div>
    </li>
  );
}
