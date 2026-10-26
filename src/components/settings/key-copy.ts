/** Plain words for credential rows. A person should not have to read environment variable names to understand a key. */

export type SplitReason = { plain: string; operator: string | null };

// The resolver appends "Set NAME=value to use the deployment key." to a reason. It is for whoever runs the server.
const OPERATOR_TAIL = /\s*Set [A-Z][A-Z0-9_]*=\S+ to use the deployment key\.?\s*$/;

export function splitOperatorHint(reason: string): SplitReason {
  const match = OPERATOR_TAIL.exec(reason);
  if (!match) return { plain: reason, operator: null };
  return { plain: reason.slice(0, match.index).replace(/the deployment does not share one\.?$/i, "no shared key is set up.").trim(), operator: match[0].trim() };
}

/** Who owns a key, in one sentence. The same words for every keyed row, so it is never read as the studied brand's login. */
export function keyOwnerNote(label: string): string {
  return `This is your own developer key for ${label}, made in your account there. It lets this workspace make permitted requests. It never needs a password or token from any brand you study, and you can skip it unless you want what it unlocks.`;
}
