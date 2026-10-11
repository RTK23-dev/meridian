/**
 * Classifies one control for the button audit. Pure: the browser collects the facts (see button-audit.mjs), and this file
 * decides what they mean, so the rule can be tested under plain Node.
 *
 * A control has a click target when React attached a pointer handler to it (onClick, onMouseDown, onPointerDown or
 * onSelect; Radix tabs and menus use the last three), or when it submits a form that has a submit handler. A link is its
 * own target. A disabled control must state its reason in visible text, linked from the control with aria-describedby.
 */

export const STATUSES = ["action", "submit", "link", "no_target", "disabled_reason", "disabled_no_reason", "hidden"];

/** The statuses that fail the audit: an enabled control with nothing to click, and a disabled control with no visible reason. */
export const FAILING_STATUSES = ["no_target", "disabled_no_reason"];

const CLICK_HANDLERS = ["onClick", "onMouseDown", "onPointerDown", "onSelect"];

/**
 * @param {{
 *   visible: boolean,
 *   disabled: boolean,
 *   reasonText?: string | null,
 *   isLink?: boolean,
 *   handlers?: string[],
 *   submitsForm?: boolean,
 *   formHasSubmitHandler?: boolean,
 * }} facts
 * @returns {{ status: string }}
 */
export function classifyControl(facts) {
  if (!facts.visible) return { status: "hidden" };
  if (facts.disabled) {
    return { status: (facts.reasonText ?? "").trim() ? "disabled_reason" : "disabled_no_reason" };
  }
  if (facts.isLink) return { status: "link" };
  const handlers = facts.handlers ?? [];
  if (handlers.some((name) => CLICK_HANDLERS.includes(name))) return { status: "action" };
  if (facts.submitsForm && facts.formHasSubmitHandler) return { status: "submit" };
  return { status: "no_target" };
}

/**
 * Counts per status, and the failing controls, for one screen. Controls keep the order the page gave them. A screen that
 * did not load, or that showed no controls at all, carries an error, so an empty visit cannot pass.
 */
export function summarizeScreen(screen, controls, loadError = null) {
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  const failing = [];
  const reasons = [];
  for (const control of controls) {
    counts[control.status] += 1;
    if (FAILING_STATUSES.includes(control.status)) failing.push({ ...control });
    if (control.status === "disabled_reason") reasons.push({ name: control.name, reason: control.reasonText });
  }
  let error = loadError;
  if (!error && controls.length === 0) error = "no buttons or links were found on this screen";
  return { screen, total: controls.length, counts, failing, reasons, error };
}

/** The whole run. ok is true only when every screen was visited, showed controls, and no control fails. */
export function summarizeRun(screens) {
  const failing = screens.flatMap((screen) => screen.failing.map((control) => ({ screen: screen.screen, ...control })));
  const screenErrors = screens.filter((screen) => screen.error).map((screen) => ({ screen: screen.screen, error: screen.error }));
  const checked = screens.reduce((sum, screen) => sum + screen.total, 0);
  const reasons = screens.flatMap((screen) => (screen.reasons ?? []).map((item) => ({ screen: screen.screen, ...item })));
  return {
    ok: failing.length === 0 && screenErrors.length === 0 && screens.length > 0,
    screens: screens.length,
    controlsChecked: checked,
    failingCount: failing.length,
    failing,
    disabledWithReason: reasons,
    screenErrors,
  };
}
