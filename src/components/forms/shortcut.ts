import type { KeyboardEvent } from "react";
import { isSubmitShortcut } from "./form-rules";

/**
 * Form onKeyDown. Cmd+Enter or Ctrl+Enter submits through the form's own submit button, so the button's disabled state
 * still applies and a form with no submit button (a viewer's) does nothing. An optional scope limits the shortcut to
 * fields inside a matching element, for forms that hold a non-form text box.
 */
export function submitOnShortcut(event: KeyboardEvent<HTMLFormElement>, scope?: string) {
  if (!isSubmitShortcut(event)) return;
  if (scope && !(event.target as HTMLElement).closest(scope)) return;
  const submit = event.currentTarget.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!submit || submit.disabled) return;
  event.preventDefault();
  event.currentTarget.requestSubmit(submit);
}
