import { useCallback, useEffect, useRef, useState } from "react";
import { plainError } from "@/lib/copy";
import { trimmedBrain, type BrainValues } from "@/lib/meridian/brain";
import { AUTOSAVE_DEBOUNCE_MS, autosaveDecision } from "@/components/forms/form-rules";
import { readBrain, changesFrom, type AutosaveStatus } from "./brain-autosave";

/** What the server returns after a save: the brain as it now stands, and its version. */
export type SavedBrain = { brain: BrainValues; version: number };

type Options = {
  /** Viewers never autosave. */
  canEdit: boolean;
  /** The brain the server last returned, and its version. A newer version replaces the baseline; an older one is ignored. */
  serverSaved: BrainValues | null;
  serverVersion: number;
  /** Changes whenever a field changes. Each change restarts the debounce. */
  watchKey: string;
  /** The form's raw values, read at the time the save runs. */
  readForm: () => unknown;
  /** Sends only the fields that changed. Throws on failure. */
  persist: (changes: Partial<BrainValues>, autosave: boolean) => Promise<SavedBrain>;
  /**
   * The saved baseline moved. The form takes the new server value for every field the person has not changed, and keeps the
   * edits they have made. `previous` is null on the first load.
   */
  onBaselineChange: (next: BrainValues, previous: BrainValues | null) => void;
  /** Shows the field errors for a form that failed validation. */
  onRejected: () => void;
};

/**
 * Autosave for the brain. It waits for a pause in typing, or for a field to lose focus, then sends the fields that differ
 * from the saved brain through `persist`. Saves run one at a time, so a manual Save and an autosave never overlap. An
 * autosave that finds no change does nothing, and one that finds an invalid brain is not sent; the field errors are shown.
 */
export function useBrainAutosave({ canEdit, serverSaved, serverVersion, watchKey, readForm, persist, onBaselineChange, onRejected }: Options) {
  const [saved, setSaved] = useState<BrainValues | null>(null);
  const [status, setStatus] = useState<AutosaveStatus>({ kind: "idle" });
  // The newest saved brain this screen knows about. Changes are measured against it, so an unchanged field is never sent.
  const baselineRef = useRef<{ brain: BrainValues; version: number } | null>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ canEdit, readForm, persist, onBaselineChange, onRejected });

  useEffect(() => {
    latest.current = { canEdit, readForm, persist, onBaselineChange, onRejected };
  });

  /** Moves the baseline to a saved brain. A version that is not newer than the baseline is ignored, so a late refetch cannot undo a save. */
  const adopt = useCallback((next: BrainValues, version: number) => {
    const previous = baselineRef.current;
    if (previous && version <= previous.version) return;
    const brain = trimmedBrain(next);
    baselineRef.current = { brain, version };
    setSaved(brain);
    latest.current.onBaselineChange(brain, previous?.brain ?? null);
  }, []);

  useEffect(() => {
    if (serverSaved) adopt(serverSaved, serverVersion);
  }, [serverSaved, serverVersion, adopt]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const enqueue = useCallback((task: () => Promise<void>): Promise<void> => {
    const run = queueRef.current.then(task);
    queueRef.current = run.catch(() => undefined);
    return run;
  }, []);

  /** Sends the changes and adopts the brain the server returns. */
  const send = useCallback(async (changes: Partial<BrainValues>, autosave: boolean) => {
    const result = await latest.current.persist(changes, autosave);
    adopt(result.brain, result.version);
  }, [adopt]);

  const autosaveTask = useCallback(async () => {
    const form = latest.current;
    const baseline = baselineRef.current;
    // Until the saved brain has loaded, the form holds empty defaults. Those must never be written over the real brain.
    if (!form.canEdit || !baseline) return;
    const raw = form.readForm();
    const read = readBrain(raw);
    const changes = changesFrom(raw, baseline.brain);
    const changed = changes === null || Object.keys(changes).length > 0;
    const decision = autosaveDecision({ canEdit: form.canEdit, changed, valid: read.ok });
    if (decision === "skip-read-only" || decision === "skip-unchanged") return;
    if (decision === "report-invalid" || changes === null) {
      form.onRejected();
      setStatus({ kind: "not-saved", message: `Not saved. ${read.ok ? "A field cannot be saved as entered." : read.message}` });
      return;
    }
    setStatus({ kind: "saving" });
    try {
      await send(changes, true);
      setStatus({ kind: "saved", at: new Date() });
    } catch (error) {
      setStatus({ kind: "not-saved", message: `Not saved. ${plainError(error).message}` });
    }
  }, [send]);

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

  /**
   * The manual Save button. It waits its turn behind any autosave in progress, then sends the fields that differ from the
   * saved brain as they are at that moment. It rejects when the save fails, so the caller can show the error.
   */
  const saveManual = useCallback((values: BrainValues) => enqueue(async () => {
    const baseline = baselineRef.current;
    if (!baseline) throw new Error("The saved brain has not loaded yet.");
    const changes = changesFrom(values, baseline.brain) ?? {};
    await send(changes, false);
  }), [enqueue, send]);

  return { saved, status, flush, saveManual };
}
