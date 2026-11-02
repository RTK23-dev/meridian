// Who may do what to a cookbook (round 3, K7). Pure, so each rule has a test. The server functions ask these questions after the brand's
// membership check (requireBrand), and they never write a cookbook the answer forbids.
//
// The rules (decision D5, and the role order of access.ts: viewer, member, admin, owner):
//   - every member who can see a brand can read its cookbooks, built-ins and shared ones;
//   - a member can create and fork cookbooks, and share a fork with the workspace (D3);
//   - a member edits or archives a cookbook they created;
//   - a copy of a built-in is maintained by an admin or above, not by a member who did not make it;
//   - an admin or owner edits or archives any cookbook of the workspace.

import type { Role } from "../access.ts";
import { hasRole } from "../access.ts";
import { isBuiltinId } from "./builtin/index.ts";
import type { StoredCookbook } from "./store.ts";

export function canView(role: Role): boolean {
  return hasRole(role, "viewer");
}

export function canCreate(role: Role): boolean {
  return hasRole(role, "member");
}

/** Whether a stored cookbook may get a new version, or be archived, by this person. */
export function canEdit(role: Role, userId: string, cookbook: StoredCookbook): boolean {
  if (hasRole(role, "admin")) return true;
  if (!hasRole(role, "member")) return false;
  const copyOfBuiltin = cookbook.parent !== null && isBuiltinId(cookbook.parent.cookbookId);
  if (copyOfBuiltin) return false;
  return cookbook.createdBy === userId;
}

/** Whether a person may share a fork with the whole workspace. Members may (D3: by the creator's choice). */
export function canShareWithWorkspace(role: Role): boolean {
  return hasRole(role, "member");
}
