/**
 * The workspace name offered before anyone types one: the person's first name and "'s workspace". A new person can accept it
 * with one click, and it is only a suggestion, so they can type over it.
 */
export function suggestedWorkspaceName(personName: string | null | undefined): string {
  const first = (personName ?? "").trim().split(/\s+/)[0] ?? "";
  // A display name that is really an email address is not a first name, so it gets the neutral suggestion.
  if (!first || first.includes("@")) return "My workspace";
  return `${first}'s workspace`.slice(0, 80);
}
