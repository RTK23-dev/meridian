import { useCallback, useEffect, useRef, useState } from "react";
import { plainError } from "@/lib/copy";
import type { BrainValues } from "@/lib/meridian/brain";
import { AUTOSAVE_DEBOUNCE_MS, autosaveDecision, sameFormValues } from "@/components/forms/form-rules";
import { readBrain, type AutosaveStatus } from "./brain-autosave";

type Options = {
  /** Viewers never autosave. */
  canEdit: boolean;
  /** The brain the server last returned. A refetch replaces the saved copy. */
  serverSaved: BrainValues | null;
  /** Changes whenever a field changes. Each change restarts the debounce. */
  watchKey: string;
  /** The form's raw values, read at the time the save runs. */
  readForm: () => unknown;
  /** Writes the brain through the same server call as the Save button. Throws on failure. */
  persist: (values: BrainValues) => Promise<void>;
  /** Shows the field errors for a form that failed validation. */
  onRejected: () => void;
};

/**
 * Autosave for the brain. It waits for a pause in typing, or for a field to lose focus, then saves through `persist`.
 * Saves run one at a time, so a manual Save and an autosave never overlap. An autosave that finds no change does nothing,
 * and one that finds an invalid brain is not sent; the field errors are shown instead.
 */
export function useBrainAutosave({ canEdit, serverSaved, watchKey, readForm, persist, onRejected }: Options) {
  const [saved, setSaved] = useState<BrainValues | null>(serverSaved);
  const [status, setStatus] = useState<AutosaveStatus>({ kind: "idle" });
  const savedRef = useRef<BrainValues | null>(serverSaved);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ canEdit, readForm, persist, onRejected });

  useEffect(() => {
    latest.current = { canEdit, readForm, persist, onRejected };
  });

  useEffect(() => {
    savedRef.current = serverSaved;
    setSaved(serverSaved);
  }, [serverSaved]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const enqueue = useCallback((task: () => Promise<void>): Promise<void> => {
    const run = queueRef.current.then(task);
    queueRef.current = run.catch(() => undefined);
    return run;
  }, []);

  /** One save, run inside the queue. A failed autosave is reported in the status; a failed manual save is left to its caller. */
  const runSave = useCallback(async (values: BrainValues, task: () => Promise<void>, source: "auto" | "manual") => {
    if (source === "auto") setStatus({ kind: "saving" });
    try {
      await task();
      savedRef.current = values;
      setSaved(values);
      setStatus({ kind: "saved", at: new Date() });
    } catch (error) {
      if (source === "auto") setStatus({ kind: "not-saved", message: `Not saved. ${plainError(error).message}` });
      throw error;
    }
  }, []);

  const autosaveTask = useCallback(async () => {
    const form = latest.current;
    // Until the saved brain has loaded, the form holds empty defaults. Those must never be written over the real brain.
    if (!form.canEdit || !savedRef.current) return;
    const read = readBrain(form.readForm());
    const changed = !read.ok || !savedRef.current || !sameFormValues(read.values, savedRef.current);
    const decision = autosaveDecision({ canEdit: form.canEdit, changed, valid: read.ok });
    if (decision === "skip-read-only" || decision === "skip-unchanged") return;
    if (!read.ok) {
      form.onRejected();
      setStatus({ kind: "not-saved", message: `Not saved. ${read.message}` });
      return;
    }
    const values = read.values;
    try {
      await runSave(values, () => form.persist(values), "auto");
    } catch {
      // The status already says the brain was not saved, with the reason.
    }
  }, [runSave]);

  const scheduleAutosave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void enqueue(autosaveTask);
    }, AUTOSAVE_DEBOUNCE_MS);
  }, [autosaveTask, enqueue]);

  /** A field lost focus. Save at once instead of waiting for the pause. */
  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    void enqueue(autosaveTask);
  }, [autosaveTask, enqueue]);

  useEffect(() => {
    if (latest.current.canEdit) scheduleAutosave();
  }, [watchKey, scheduleAutosave]);

  /** The manual Save button. It waits its turn behind any autosave already running, then saves through the caller's task. */
  const saveManual = useCallback((values: BrainValues, task: () => Promise<void>) => {
    return enqueue(() => runSave(values, task, "manual"));
  }, [enqueue, runSave]);

  return { saved, status, flush, saveManual };
}
