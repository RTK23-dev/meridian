import { Command } from "cmdk";
import type { PageCommand } from "@/components/page-commands";

export type PaletteBrand = { id: string; name: string };
export type PaletteWorkspace = { id: string; name: string };

/** Screens inside a brand. Every path needs a brand id, so the list is built per brand. */
export function brandScreenLinks(brandId: string): { label: string; to: string }[] {
  const base = `/brands/${brandId}`;
  return [
    { label: "Overview", to: base },
    { label: "Market", to: `${base}/market` },
    { label: "Intelligence", to: `${base}/intelligence` },
    { label: "Opportunities", to: `${base}/opportunities` },
    { label: "Reviews", to: `${base}/reviews` },
    { label: "Studio", to: `${base}/studio` },
    { label: "Library", to: `${base}/library` },
    { label: "Learning", to: `${base}/learning` },
    { label: "Calibration", to: `${base}/calibration` },
    { label: "Brand brain", to: `${base}/brain` },
    { label: "Products", to: `${base}/products` },
    { label: "Connected accounts", to: `${base}/accounts` },
    { label: "Factory", to: `${base}/factory` },
  ];
}

export const WORKSPACE_SCREEN_LINKS: { label: string; to: string }[] = [
  { label: "Workspace overview", to: "/" },
  { label: "Jobs & health", to: "/jobs" },
  { label: "Usage & cost", to: "/usage" },
  { label: "Alerts center", to: "/alerts" },
  { label: "Integrations", to: "/integrations" },
  { label: "Settings", to: "/settings" },
  { label: "Audit log", to: "/audit" },
  { label: "Exports", to: "/exports" },
  { label: "Webhook events", to: "/webhooks" },
  { label: "Notification preferences", to: "/notifications" },
];

// Menus inside Command.Group: the heading gets the eyebrow treatment, the items stay in normal case.
const GROUP_CLASS = "px-1 py-2 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-fg-muted";
const ITEM_CLASS = "cursor-pointer rounded-md px-3 py-2 text-sm text-fg aria-selected:bg-surface-2";

export function CommandPalette({
  open,
  onOpenChange,
  brands,
  workspaces,
  activeWorkspaceId,
  brandId,
  canCreateBrand,
  pageCommands,
  onNavigate,
  onSwitchWorkspace,
  onToggleTheme,
  onShowShortcuts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  brands: PaletteBrand[];
  workspaces: PaletteWorkspace[];
  activeWorkspaceId?: string;
  brandId?: string;
  canCreateBrand: boolean;
  pageCommands: PageCommand[];
  onNavigate: (to: string) => void;
  onSwitchWorkspace: (id: string) => void;
  onToggleTheme: () => void;
  onShowShortcuts: () => void;
}) {
  // Every action closes the palette first, so the destination is never hidden behind it.
  const choose = (action: () => void) => () => {
    onOpenChange(false);
    action();
  };
  const otherWorkspaces = workspaces.filter((workspace) => workspace.id !== activeWorkspaceId);
  return (
    <>
      <Command.Dialog open={open} onOpenChange={onOpenChange} label="Command palette" className="fixed left-1/2 top-[18vh] z-50 w-[min(38rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-surface shadow-lg">
        <Command.Input autoFocus placeholder="Search brands, screens and actions" className="h-14 w-full border-b border-border bg-transparent px-4 text-fg placeholder:text-fg-muted focus-visible:outline-offset-[-2px]" />
        <Command.List className="max-h-[60vh] overflow-auto p-2">
          <Command.Empty className="p-4 text-sm text-fg-muted">No matching command.</Command.Empty>
          {pageCommands.length ? (
            <Command.Group heading="This page" className={GROUP_CLASS}>
              {pageCommands.map((command) => (
                <Command.Item key={command.id} value={`${command.label} ${command.id}`} onSelect={choose(command.run)} className={ITEM_CLASS}>{command.label}</Command.Item>
              ))}
            </Command.Group>
          ) : null}
          {brands.length ? (
            <Command.Group heading="Switch brand" className={GROUP_CLASS}>
              {brands.map((brand) => (
                <Command.Item key={brand.id} value={`Switch brand ${brand.name} ${brand.id}`} onSelect={choose(() => onNavigate(`/brands/${brand.id}`))} className={ITEM_CLASS}>{brand.name}</Command.Item>
              ))}
            </Command.Group>
          ) : null}
          {otherWorkspaces.length ? (
            <Command.Group heading="Switch workspace" className={GROUP_CLASS}>
              {otherWorkspaces.map((workspace) => (
                <Command.Item key={workspace.id} value={`Switch workspace ${workspace.name} ${workspace.id}`} onSelect={choose(() => onSwitchWorkspace(workspace.id))} className={ITEM_CLASS}>{workspace.name}</Command.Item>
              ))}
            </Command.Group>
          ) : null}
          <Command.Group heading="Go to" className={GROUP_CLASS}>
            {brandId ? brandScreenLinks(brandId).map((screen) => (
              <Command.Item key={screen.to} value={`Go to ${screen.label}`} onSelect={choose(() => onNavigate(screen.to))} className={ITEM_CLASS}>{screen.label}</Command.Item>
            )) : null}
            {WORKSPACE_SCREEN_LINKS.map((screen) => (
              <Command.Item key={screen.to} value={`Go to ${screen.label}`} onSelect={choose(() => onNavigate(screen.to))} className={ITEM_CLASS}>{screen.label}</Command.Item>
            ))}
          </Command.Group>
          <Command.Group heading="Actions" className={GROUP_CLASS}>
            {canCreateBrand ? <Command.Item value="New brand" onSelect={choose(() => onNavigate("/brands/new"))} className={ITEM_CLASS}>New brand</Command.Item> : null}
            {brandId ? <Command.Item value="Open reviews" onSelect={choose(() => onNavigate(`/brands/${brandId}/reviews`))} className={ITEM_CLASS}>Open reviews</Command.Item> : null}
            <Command.Item value="Toggle theme" onSelect={choose(onToggleTheme)} className={ITEM_CLASS}>Toggle theme</Command.Item>
            <Command.Item value="Keyboard shortcuts" onSelect={choose(onShowShortcuts)} className={ITEM_CLASS}>Keyboard shortcuts</Command.Item>
          </Command.Group>
        </Command.List>
      </Command.Dialog>
      {open ? <button type="button" className="fixed inset-0 z-40 cursor-default bg-black/40" aria-label="Close command palette" onClick={() => onOpenChange(false)} /> : null}
    </>
  );
}
