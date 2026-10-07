import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Command } from "cmdk";
import { Activity, BarChart3, Bell, Brain, ChevronDown, Factory, FileClock, FlaskConical, House, Layers3, Menu, Moon, Package, Search, Settings, Sparkles, Sun, WandSparkles, type LucideIcon } from "lucide-react";
import { UserButton } from "@/lib/auth/gates";
import { setActiveOrganization } from "@/lib/meridian/api";
import { useWorkspace } from "@/components/workspace";
import { useMachineQuery } from "@/lib/query/hooks";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { userScopedQueryKey } from "@/lib/query/keys";
import { useTheme, Sheet, SheetContent, SheetTitle } from "@/components/ui";

type NavLink = { label: string; to: string; icon: LucideIcon; badge?: number };

const PAGE_NAMES: Record<string, string> = {
  "": "Overview", factory: "Factory", market: "Market research", intelligence: "Intelligence", opportunities: "Opportunities",
  reviews: "Reviews", studio: "Studio", library: "Library", learning: "Learning", calibration: "Calibration", brain: "Brand brain", products: "Products",
  integrations: "Integrations", settings: "Settings", jobs: "Jobs & health", usage: "Usage & cost", alerts: "Alerts center", audit: "Audit log", webhooks: "Webhook events", notifications: "Notification preferences", new: "New brand",
};

const WORKSPACE_LINKS: NavLink[] = [
  { label: "Jobs & health", to: "/jobs", icon: Activity },
  { label: "Usage & cost", to: "/usage", icon: BarChart3 },
  { label: "Alerts center", to: "/alerts", icon: Bell },
  { label: "Audit log", to: "/audit", icon: FileClock },
  { label: "Webhook events", to: "/webhooks", icon: FileClock },
  { label: "Notification preferences", to: "/notifications", icon: Bell },
  { label: "Integrations", to: "/integrations", icon: Activity },
  { label: "Settings", to: "/settings", icon: Settings },
];

function navGroups(brandId: string | undefined, reviews: number): { label: string; links: NavLink[] }[] {
  if (!brandId) return [{ label: "Workspace", links: [{ label: "Overview", to: "/", icon: House }, ...WORKSPACE_LINKS] }];
  const b = `/brands/${brandId}`;
  return [
    { label: "Overview", links: [{ label: "Overview", to: b, icon: House }] },
    { label: "Factory", links: [{ label: "Factory", to: `${b}/factory`, icon: Factory }] },
    { label: "Research", links: [{ label: "Market", to: `${b}/market`, icon: FlaskConical }, { label: "Intelligence", to: `${b}/intelligence`, icon: Sparkles }] },
    { label: "Decide", links: [{ label: "Opportunities", to: `${b}/opportunities`, icon: Layers3 }, { label: "Reviews", to: `${b}/reviews", icon: Bell, ...(reviews ? { badge: reviews } : {}) }] },
    { label: "Create", links: [{ label: "Studio", to: `${b}/studio`, icon: WandSparkles }, { label: "Library", to: `${b}/library`, icon: Package }] },
    { label: "Learn", links: [{ label: "Learning", to: `${b}/learning`, icon: Activity }, { label: "Calibration", to: `${b}/calibration`, icon: BarChart3 }] },
    { label: "Brand", links: [{ label: "Brand brain", to: `${b}/brain`, icon: Brain }, { label: "Products", to: `${b}/products`, icon: Package }] },
    { label: "Workspace", links: WORKSPACE_LINKS },
  ];
}

export function Shell({ children }: { children: ReactNode }) {
  const { data, reload } = useWorkspace();
  const path = useRouterState({ select: (state) => state.location.pathname.replace(/\/$/, "") || "/" });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useCurrentUserState();
  const { theme, setTheme } = useTheme();
  const active = data?.active;
  const routeBrandId = path.match(/^\/brands\/([^/]+)/)?.[1];
  const brandId = routeBrandId && routeBrandId !== "new" ? routeBrandId : data?.brands[0]?.id;
  const brand = data?.brands.find((item) => item.id === brandId);
  const machine = useMachineQuery(brandId ?? "", !!brandId);
  const links = useMemo(() => navGroups(brandId, machine.data?.counts.reviews ?? 0), [brandId, machine.data?.counts.reviews]);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const page = pageName(path);

  useEffect(() => {
    document.title = `${page} · Meridian`;
    const focusHeading = () => {
      const heading = document.querySelector<HTMLElement>("#main h1");
      if (heading) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      }
    };
    const frame = requestAnimationFrame(focusHeading);
    return () => cancelAnimationFrame(frame);
  }, [page, path]);

  useEffect(() => {
    let gPressedAt = 0;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "");
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault(); setPaletteOpen(true); return;
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.toLowerCase() === "g") { gPressedAt = Date.now(); return; }
      if (Date.now() - gPressedAt < 900) {
        const targetPath = { o: "/", s: brandId ? `/brands/${brandId}/studio` : "/", r: brandId ? `/brands/${brandId}/reviews` : "/" }[event.key.toLowerCase()];
        if (targetPath) { event.preventDefault(); void navigatePath(targetPath); }
        gPressedAt = 0; return;
      }
      if (event.key === "/") { event.preventDefault(); setPaletteOpen(true); }
      if (event.key === "?") { event.preventDefault(); setShortcutsOpen(true); }
    };
    const navigatePath = (to: string) => {
      if (to === "/") return navigate({ to: "/" });
      if (brandId && to.endsWith("/studio")) return navigate({ to: "/brands/$brandId/studio", params: { brandId } });
      if (brandId && to.endsWith("/reviews")) return navigate({ to: "/brands/$brandId/reviews", params: { brandId } });
      return Promise.resolve();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [brandId, navigate]);

  function go(to: string) {
    setPaletteOpen(false);
    if (to === "/") { void navigate({ to: "/" }); return; }
    if (to === "/integrations") { void navigate({ to: "/integrations" }); return; }
    if (to === "/usage") { void navigate({ to: "/usage" }); return; }
    if (to === "/alerts") { void navigate({ to: "/alerts" }); return; }
    if (to === "/audit") { void navigate({ to: "/audit" }); return; }
    if (to === "/webhooks") { void navigate({ to: "/webhooks" }); return; }
    if (to === "/notifications") { void navigate({ to: "/notifications" }); return; }
    if (to === "/settings") { void navigate({ to: "/settings" }); return; }
    if (to === "/brands/new") { void navigate({ to: "/brands/new" }); return; }
    const match = to.match(/^\/brands\/([^/]+)(?:\/(.*))?$/);
    if (!match) return;
    const id = match[1];
    const suffix = match[2] ?? "";
    const route = suffix ? `/brands/$brandId/${suffix}` : "/brands/$brandId";
    void navigate({ to: route as never, params: { brandId: id } as never });
  }

  const sidebar = (mobile = false) => (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex h-16 items-center justify-between border-b border-line px-4">
        <Link to="/" onClick={() => setMobileNavOpen(false)} className="font-display text-lg font-semibold tracking-tight">Meridian</Link>
        {mobile ? <button className="rounded p-2 lg:hidden" type="button" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation">×</button> : null}
      </div>
      {brandId && data?.brands.length ? <label className="px-4 pt-4 text-[11px] font-semibold uppercase tracking-[.16em] text-muted">Brand
        <select aria-label="Switch brand" className="mt-2 min-h-10 w-full rounded-md border border-line bg-surface px-2 text-sm text-ink" value={brandId} onChange={(event) => go(`/brands/${event.target.value}`)}>
          {data.brands.map((item) => <option key={item.id} value={item.id}>{item.name} · {Math.round(item.completeness * 100)}%</option>)}
        </select>
      </label> : null}
      <nav aria-label="Primary" className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
        {links.map((group) => <section key={group.label} className="mb-5">
          <h2 className={`mb-1 px-2 text-[10px] font-bold uppercase tracking-[.16em] text-muted ${collapsed && !mobile ? "sr-only" : ""}`}>{group.label}</h2>
          {group.links.map(({ label, to, icon: Icon, badge }) => {
            const current = path === to || (label === "Overview" && path === `${to}/`);
            return <Link key={to} to={to as never} params={to.includes("$brandId") && brandId ? { brandId } as never : undefined} aria-current={current ? "page" : undefined} title={collapsed && !mobile ? label : undefined} onClick={() => setMobileNavOpen(false)} className={`mb-1 flex min-h-10 items-center gap-3 rounded-md px-3 text-sm font-medium transition ${current ? "bg-ink text-paper" : "text-muted hover:bg-paper hover:text-ink"}`}>
              <Icon aria-hidden="true" className="size-4 shrink-0" />
              <span className={collapsed && !mobile ? "sr-only" : "flex-1"}>{label}</span>
              {badge ? <span className="rounded-full bg-brass px-2 py-0.5 text-[10px] font-bold text-paper">{badge}</span> : null}
            </Link>;
          })}
        </section>)}
        {!brandId ? <Link to="/brands/new" className="flex min-h-10 items-center gap-3 rounded-md px-3 text-sm text-muted hover:bg-paper hover:text-ink"><Sparkles className="size-4" />New brand</Link> : null}
      </nav>
      <div className="border-t border-line p-3">
        <button type="button" onClick={() => { const next = !collapsed; setCollapsed(next); try { localStorage.setItem("meridian-nav-collapsed", String(next)); } catch { /* Keep the in-memory preference when storage is unavailable. */ } }} className="hidden min-h-10 w-full items-center gap-3 rounded-md px-3 text-left text-sm text-muted hover:bg-paper lg:flex" aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}>
          <ChevronDown aria-hidden="true" className={`size-4 transition ${collapsed ? "-rotate-90" : "rotate-90"}`} />{collapsed ? null : "Collapse navigation"}
        </button>
      </div>
    </div>
  );

  return <div className={`min-h-screen ${collapsed ? "lg:grid lg:grid-cols-[5rem_1fr]" : "lg:grid lg:grid-cols-[16rem_1fr]"}`}>
    <aside className="hidden border-r border-line lg:block">{sidebar()}</aside>
      <Sheet direction="left" open={mobileNavOpen} onOpenChange={setMobileNavOpen}><SheetContent className="inset-y-0 left-0 right-auto h-full max-h-none w-[min(20rem,88vw)] rounded-none border-r border-t-0 p-0"><SheetTitle className="sr-only">Primary navigation</SheetTitle>{sidebar(true)}</SheetContent></Sheet>
    <div className="flex min-h-screen min-w-0 flex-col">
      <header className="sticky top-0 z-20 border-b border-line bg-panel/95 backdrop-blur">
        <div className="flex min-h-16 flex-wrap items-center gap-2 px-3 sm:px-5">
          <button type="button" className="min-h-10 rounded-md p-2 lg:hidden" aria-label="Open navigation" onClick={() => setMobileNavOpen(true)}><Menu className="size-5" /></button>
          <div className="hidden min-w-0 items-center gap-2 text-sm md:flex" aria-label="Breadcrumb">
            <Link to="/" className="text-muted hover:text-ink">Workspace</Link>{brand ? <><span className="text-line">/</span><span className="max-w-36 truncate text-muted">{brand.name}</span></> : null}<span className="text-line">/</span><span className="font-semibold text-ink">{page}</span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {data?.organizations.length && active ? <select aria-label="Switch workspace" className="hidden min-h-10 max-w-48 rounded-md border border-line bg-surface px-2 text-sm sm:block" value={active.id} onChange={(event) => { void setActiveOrganization({ data: { organizationId: event.target.value } }).then(() => reload()); }}>
              {data.organizations.map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}
            </select> : null}
            {active ? <span className="hidden text-xs uppercase tracking-wide text-muted xl:inline">{active.role}</span> : null}
            <button type="button" onClick={() => setPaletteOpen(true)} className="inline-flex min-h-10 items-center gap-2 rounded-md border border-line px-3 text-sm text-muted hover:bg-paper" aria-label="Search and commands"><Search className="size-4" /><span className="hidden sm:inline">Search</span><kbd className="hidden rounded border border-line px-1 text-[10px] sm:inline">⌘K</kbd></button>
            <Link to="/alerts" aria-label="Open alerts" title="Alerts" className="grid size-10 place-items-center rounded-md text-muted hover:bg-paper"><Bell className="size-4" /></Link>
            <button type="button" aria-label="Toggle theme" title="Toggle theme" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} className="grid size-10 place-items-center rounded-md text-muted hover:bg-paper">{theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}</button>
            <UserButton />
          </div>
        </div>
      </header>
      <div className="border-b border-line px-4 py-2 text-sm text-muted md:hidden" aria-hidden="true">{brand ? `${brand.name} / ` : ""}{page}</div>
      <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-4 py-6 pb-24 sm:px-6 lg:px-8 lg:pb-8">{children}</main>
      <nav aria-label="Quick navigation" className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-4 border-t border-line bg-panel/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
        {[{ label: "Overview", to: brandId ? `/brands/${brandId}` : "/", icon: House }, { label: "Decide", to: brandId ? `/brands/${brandId}/opportunities` : "/", icon: Layers3 }, { label: "Studio", to: brandId ? `/brands/${brandId}/studio` : "/", icon: WandSparkles }, { label: "Reviews", to: brandId ? `/brands/${brandId}/reviews` : "/", icon: Bell }].map(({ label, to, icon: Icon }) => <Link key={label} to={to as never} params={to.includes("/brands/") && brandId ? { brandId } as never : undefined} className={`flex min-h-14 flex-col items-center justify-center gap-1 text-[10px] ${path === to ? "font-semibold text-brass" : "text-muted"}`}><Icon className="size-4" aria-hidden="true" />{label}</Link>)}
      </nav>
      <p className="sr-only" aria-live="polite" aria-atomic="true">{page}</p>
    </div>
    <Command.Dialog open={paletteOpen} onOpenChange={setPaletteOpen} label="Command palette" className="fixed left-1/2 top-[18vh] z-50 w-[min(38rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-xl border border-line bg-panel shadow-2xl">
      <Command.Input autoFocus placeholder="Search screens and actions…" className="h-14 w-full border-b border-line bg-transparent px-4 outline-none" />
      <Command.List className="max-h-[60vh] overflow-auto p-2"><Command.Empty className="p-4 text-sm text-muted">No matching command.</Command.Empty>
        <Command.Group heading="Navigate" className="px-2 py-2 text-xs font-semibold uppercase tracking-wide text-muted">
          {brandId ? <>
            {[["Overview", `/brands/${brandId}`], ["Market", `/brands/${brandId}/market`], ["Intelligence", `/brands/${brandId}/intelligence`], ["Opportunities", `/brands/${brandId}/opportunities`], ["Reviews", `/brands/${brandId}/reviews`], ["Studio", `/brands/${brandId}/studio`], ["Library", `/brands/${brandId}/library`], ["Learning", `/brands/${brandId}/learning`], ["Brand brain", `/brands/${brandId}/brain`], ["Products", `/brands/${brandId}/products`]].map(([label, to]) => <Command.Item key={to} value={label} onSelect={() => go(to)} className="cursor-pointer rounded px-3 py-2 text-sm aria-selected:bg-paper">{label}</Command.Item>)}
          </> : null}
          <Command.Item value="Workspace overview" onSelect={() => go("/")} className="cursor-pointer rounded px-3 py-2 text-sm aria-selected:bg-paper">Workspace overview</Command.Item>
          <Command.Item value="Usage and cost" onSelect={() => go("/usage")} className="cursor-pointer rounded px-3 py-2 text-sm aria-selected:bg-paper">Usage &amp; cost</Command.Item>
          <Command.Item value="Alerts center" onSelect={() => go("/alerts")} className="cursor-pointer rounded px-3 py-2 text-sm aria-selected:bg-paper">Alerts center</Command.Item>
          <Command.Item value="Audit log" onSelect={() => go("/audit")} className="cursor-pointer rounded px-3 py-2 text-sm aria-selected:bg-paper">Audit log</Command.Item>
          <Command.Item value="Webhook events" onSelect={() => go("/webhooks")} className="cursor-pointer rounded px-3 py-2 text-sm aria-selected:bg-paper">Webhook events</Command.Item>
          <Command.Item value="Notification preferences" onSelect={() => go("/notifications")} className="cursor-pointer rounded px-3 py-2 text-sm aria-selected:bg-paper">Notification preferences</Command.Item>
          <Command.Item value="New brand" onSelect={() => go("/brands/new")} className="cursor-pointer rounded px-3 py-2 text-sm aria-selected:bg-paper">New brand</Command.Item>
          <Command.Item value="Settings" onSelect={() => go("/settings")} className="cursor-pointer rounded px-3 py-2 text-sm aria-selected:bg-paper">Settings</Command.Item>
          <Command.Item value="Integrations" onSelect={() => go("/integrations")} className="cursor-pointer rounded px-3 py-2 text-sm aria-selected:bg-paper">Integrations</Command.Item>
        </Command.Group>
        <Command.Group heading="Actions" className="px-2 py-2 text-xs font-semibold uppercase tracking-wide text-muted">
          <Command.Item value="Toggle theme" onSelect={() => { setPaletteOpen(false); setTheme(theme === "dark" ? "light" : "dark"); }} className="cursor-pointer rounded px-3 py-2 text-sm aria-selected:bg-paper">Toggle theme</Command.Item>
          {brandId ? <Command.Item value="Refresh opportunities" onSelect={() => { setPaletteOpen(false); void queryClient.invalidateQueries({ queryKey: userScopedQueryKey(user?.id, ["opportunities", brandId]) }); }} className="cursor-pointer rounded px-3 py-2 text-sm aria-selected:bg-paper">Refresh opportunities</Command.Item> : null}
          {brandId ? <Command.Item value="Open reviews" onSelect={() => go(`/brands/${brandId}/reviews`)} className="cursor-pointer rounded px-3 py-2 text-sm aria-selected:bg-paper">Open reviews</Command.Item> : null}
          {data && data.organizations.length > 1 && active ? <Command.Item value="Switch workspace" onSelect={() => { setPaletteOpen(false); const index = data.organizations.findIndex((item) => item.id === active.id); const next = data.organizations[(index + 1) % data.organizations.length]; void setActiveOrganization({ data: { organizationId: next.id } }).then(() => reload()); }} className="cursor-pointer rounded px-3 py-2 text-sm aria-selected:bg-paper">Switch workspace</Command.Item> : null}
          <Command.Item value="Keyboard shortcuts" onSelect={() => { setPaletteOpen(false); setShortcutsOpen(true); }} className="cursor-pointer rounded px-3 py-2 text-sm aria-selected:bg-paper">Keyboard shortcuts</Command.Item>
        </Command.Group>
      </Command.List>
    </Command.Dialog>
    {paletteOpen ? <button className="fixed inset-0 z-40 cursor-default bg-black/40" aria-label="Close command palette" onClick={() => setPaletteOpen(false)} /> : null}
    {shortcutsOpen ? <div role="presentation" className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setShortcutsOpen(false); }}><section role="dialog" aria-modal="true" aria-labelledby="shortcut-title" className="w-full max-w-md rounded-xl border border-line bg-panel p-6 shadow-xl"><div className="flex items-center justify-between"><h2 id="shortcut-title" className="font-display text-xl">Keyboard shortcuts</h2><button type="button" onClick={() => setShortcutsOpen(false)} aria-label="Close shortcuts">×</button></div><dl className="mt-4 grid grid-cols-[1fr_auto] gap-3 text-sm"><dt>Open search and commands</dt><dd><kbd>⌘ / Ctrl K</kbd></dd><dt>Overview</dt><dd><kbd>G O</kbd></dd><dt>Studio</dt><dd><kbd>G S</kbd></dd><dt>Reviews</dt><dd><kbd>G R</kbd></dd><dt>Focus search</dt><dd><kbd>/</kbd></dd><dt>Show this help</dt><dd><kbd>?</kbd></dd></dl></section></div> : null}
  </div>;
}

function pageName(path: string) {
  if (path === "/") return PAGE_NAMES[""];
  const parts = path.split("/").filter(Boolean);
  const last = parts.at(-1) ?? "";
  return PAGE_NAMES[last] ?? last.replaceAll("-", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function readCollapsed() {
  try { return typeof window !== "undefined" && window.localStorage.getItem("meridian-nav-collapsed") === "true"; }
  catch { return false; }
}
