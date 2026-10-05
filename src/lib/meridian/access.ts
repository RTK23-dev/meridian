export const ROLES = ["viewer", "member", "admin", "owner"] as const;
export type Role = (typeof ROLES)[number];

const RANK: Record<Role, number> = {
  viewer: 1,
  member: 2,
  admin: 3,
  owner: 4,
};

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** True when `actual` may perform an action that requires `minimum`. */
export function hasRole(actual: Role, minimum: Role): boolean {
  return RANK[actual] >= RANK[minimum];
}

export function assertRole(actual: Role, minimum: Role): void {
  if (!hasRole(actual, minimum)) {
    throw new Error("You do not have permission to do that.");
  }
}

/**
 * Owners cannot be demoted or removed when they are the only owner.
 * Returns the next role, or null when the member should be removed.
 */
export function nextOwnerCount(
  owners: number,
  from: Role,
  to: Role | null,
): number {
  const was = from === "owner" ? 1 : 0;
  const will = to === "owner" ? 1 : 0;
  return owners - was + will;
}
