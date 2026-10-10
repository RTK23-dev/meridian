import { useEffect, type RefObject } from "react";
import { isEcho, syncPlan } from "./playback-sync.ts";

function videoIn(container: HTMLElement | null): HTMLVideoElement | null {
  return container?.querySelector("video") ?? null;
}

/**
 * Links the playback of two video players, one inside each container. Play, pause and seeking on one apply to the other.
 * Listeners sit on the document in the capture phase, so they keep working when a player remounts. A change this hook made
 * is ignored for a short window, so two players cannot send the same change back and forth.
 */
export function useSyncedVideos(first: RefObject<HTMLElement | null>, second: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const lastApplied = new WeakMap<HTMLVideoElement, number>();
    const eventNames = ["play", "pause", "seeked"] as const;

    function pairFor(node: EventTarget | null): { source: HTMLVideoElement; target: HTMLVideoElement } | null {
      if (!(node instanceof HTMLVideoElement)) return null;
      const a = first.current;
      const b = second.current;
      if (!a || !b) return null;
      if (a.contains(node)) {
        const other = videoIn(b);
        return other ? { source: node, target: other } : null;
      }
      if (b.contains(node)) {
        const other = videoIn(a);
        return other ? { source: node, target: other } : null;
      }
      return null;
    }

    function onMediaEvent(event: Event) {
      const pair = pairFor(event.target);
      if (!pair) return;
      const now = Date.now();
      if (isEcho(lastApplied.get(pair.source), now)) return;
      const step = syncPlan(
        { paused: pair.source.paused, time: pair.source.currentTime },
        { paused: pair.target.paused, time: pair.target.currentTime },
      );
      if (!step.play && !step.pause && step.seekTo === null) return;
      lastApplied.set(pair.target, now);
      if (step.seekTo !== null) pair.target.currentTime = step.seekTo;
      if (step.play) pair.target.play().catch(() => undefined);
      if (step.pause) pair.target.pause();
    }

    for (const name of eventNames) document.addEventListener(name, onMediaEvent, true);
    return () => {
      for (const name of eventNames) document.removeEventListener(name, onMediaEvent, true);
    };
  }, [first, second, enabled]);
}
