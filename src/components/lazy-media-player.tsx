import { lazy, Suspense } from "react";
import { Skeleton } from "@/components/ui";
import type { MediaPlayerProps } from "./media-player";

const MediaPlayerModule = lazy(() => import("./media-player").then((module) => ({ default: module.MediaPlayer })));

/**
 * The media player for a stored video or image. It loads on the first screen that shows media, so a screen without
 * media does not download it. The skeleton keeps a 16:9 frame until the player arrives.
 */
export function LazyMediaPlayer(props: MediaPlayerProps) {
  return <Suspense fallback={<Skeleton variant="media" />}><MediaPlayerModule {...props} /></Suspense>;
}
