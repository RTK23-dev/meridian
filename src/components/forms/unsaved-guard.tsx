import { useBlocker } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle, Button,
} from "@/components/ui";
import { shouldBlockNavigation } from "./form-rules";

/**
 * Stops a person leaving a screen while a form on it has unsaved edits. Mount it once per screen with the screen's
 * combined dirty state. A clean screen never blocks. The browser's own warning covers closing or reloading the tab,
 * and only while the screen is dirty.
 */
export function UnsavedChangesGuard({ dirty }: { dirty: boolean }) {
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  const shouldBlockFn = useCallback(() => shouldBlockNavigation(dirtyRef.current), []);
  const enableBeforeUnload = useCallback(() => shouldBlockNavigation(dirtyRef.current), []);
  const blocker = useBlocker({ shouldBlockFn, enableBeforeUnload, withResolver: true });
  const blocked = blocker.status === "blocked";

  function stay() {
    if (blocker.status === "blocked") blocker.reset();
  }
  function leave() {
    if (blocker.status === "blocked") blocker.proceed();
  }

  return (
    <AlertDialog open={blocked} onOpenChange={(open) => { if (!open) stay(); }}>
      <AlertDialogContent>
        <AlertDialogTitle className="font-display text-2xl">Leave without saving?</AlertDialogTitle>
        <AlertDialogDescription className="mt-2 text-sm text-fg-muted">
          This page has unsaved changes. Leaving now discards them.
        </AlertDialogDescription>
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <AlertDialogCancel asChild>
            <Button type="button" variant="secondary" onClick={stay}>Keep editing</Button>
          </AlertDialogCancel>
          <AlertDialogAction asChild>
            <Button type="button" variant="danger" onClick={leave}>Leave without saving</Button>
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
