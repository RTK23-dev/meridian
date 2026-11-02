// The settings the person may change before confirming the pick (round 3, K18d2). It draws the pick's controls with the settings panel and keeps
// each change as the person's unsent draft (settings-draft.ts). It starts from the values the proposal resolved for the pick, so the
// selector's choice is not overridden by the defaults. The parent sends the values with the confirm.

import { useCallback, useEffect, useMemo, useState } from "react";
import { createSettingsDraft, type SettingsDraft } from "@/components/cookbooks/settings-draft";
import { SettingsPanel } from "@/components/cookbooks/settings-panel";
import { settingRows } from "@/components/cookbooks/settings-model";
import type { Control, ControlValue } from "@/lib/meridian/cookbooks/controls";
import type { DebounceTimers } from "@/lib/progress/debounce";
import type { DraftStorage } from "@/lib/progress/draft-store";

// Browser storage holds only the person's unsent draft. Every call is wrapped by the draft store, so a blocked store never breaks the step.
const storage: DraftStorage = {
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
  removeItem: (key) => window.localStorage.removeItem(key),
};

const timers: DebounceTimers<unknown> = {
  setTimer: (run, ms) => window.setTimeout(run, ms),
  clearTimer: (handle) => window.clearTimeout(handle as number),
};

export function CookbookSettingsStep({
  userId,
  workspaceId,
  cookbookId,
  controls,
  base,
  onValues,
}: {
  userId: string;
  workspaceId: string;
  cookbookId: string;
  controls: Control[];
  /** The values the proposal resolved for the pick. */
  base: Record<string, ControlValue>;
  /** Reports the values now shown, after each change, so the parent can send them with the confirm. */
  onValues: (cookbookId: string, values: Record<string, ControlValue>) => void;
}) {
  const draft: SettingsDraft = useMemo(
    () =>
      createSettingsDraft({
        cookbook: { controls },
        base,
        scope: { userId, workspaceId, screen: `content-factory:cookbook:${cookbookId}` },
        storage,
        timers,
      }),
    [controls, base, userId, workspaceId, cookbookId],
  );
  const [values, setValues] = useState<Record<string, ControlValue>>(() => draft.values());

  useEffect(() => {
    const current = draft.values();
    setValues(current);
    onValues(cookbookId, current);
    // A change still waiting to be saved is saved when the step moves to another cookbook or unmounts.
    return () => draft.flush();
  }, [draft, cookbookId, onValues]);

  const change = useCallback(
    (id: string, value: boolean | number | string) => {
      draft.change(id, value as ControlValue);
      const next = draft.values();
      setValues(next);
      onValues(cookbookId, next);
    },
    [draft, cookbookId, onValues],
  );

  if (controls.length === 0) return null;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">Settings</h3>
      <SettingsPanel rows={settingRows({ controls }, values)} onChange={change} />
    </div>
  );
}
