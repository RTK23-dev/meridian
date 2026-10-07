export type KillSwitchScope = "brand" | "workspace";

export type KillSwitchEvent = {
  scope: KillSwitchScope;
  organizationId: string;
  brandId: string | null;
  engaged: boolean;
  actorId: string;
  at: string;
};

export function killSwitchCommand(input: {
  organizationId: string;
  brandId?: string | null;
  engage: boolean;
  actorId: string;
  now?: string;
}): KillSwitchEvent {
  const organizationId = input.organizationId.trim();
  const actorId = input.actorId.trim();
  if (!organizationId || !actorId) throw new Error("A kill switch needs an organization and an actor.");
  const brandId = input.brandId?.trim() || null;
  return {
    scope: brandId ? "brand" : "workspace",
    organizationId,
    brandId,
    engaged: input.engage,
    actorId,
    at: input.now ?? new Date().toISOString(),
  };
}

export function adsMustPause(switchState: { workspaceEngaged: boolean; brandEngaged: boolean }): boolean {
  return switchState.workspaceEngaged || switchState.brandEngaged;
}
