import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Command } from "cmdk";
import { Activity, BarChart3, Bell, Brain, ChevronDown, Factory, FileClock, FlaskConical, House, Layers3, Menu, Moon, Package, Search, Settings, Sparkles, Sun, WandSparkles, X, type LucideIcon } from "lucide-react";
import { UserButton } from "@/lib/auth/gates";
import { setActiveOrganization } from "@/lib/meridian/api";
import { useWorkspace } from "@/components/workspace";
import { useMachineQuery } from "@/lib/query/hooks";
import { prefetchScreen } from "@/lib/query/prefetch";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { qk, userScopedQueryKey } from "@/lib/query/keys";
import { Button, Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, Kbd, Sheet, SheetContent, SheetTitle, useTheme } from "@/components/ui";

type NavLink = { label: string; to: string; icon: LucideIcon; badge?: number };

const PAGE_NAMES: Record<string, string> = {
  "": "Overview", factory: "Factory", market: "Market research", intelligence: "Intelligence", opportunities: "Opportunities",
  reviews: "Reviews", studio: "Studio", library: "Library", learning: "Learning", calibration: "Calibration", brain: "Brand brain", products: "Products", accounts: "Connected accounts",
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

// Menus inside Command.Group: the heading gets the eyebrow treatment, the items stay in normal case.
const GROUP_CLASS = "px-1 py-2 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-fg-muted";
const ITEM_CLASS = "cursor-pointer rounded-md px-3 py-2 text-sm text-fg aria-selected:bg-surface-2";
const SWITCHER_CLASS = "min-h-11 w-full rounded-md border border-border-strong bg-surface px-2 text-sm text-fg";

function navGroups(brandId: string | undefined, reviews: number): { label: string; links: NavLink[] }[] {
  if (!brandId) return [{ label: "Workspace", links: [{ label: "Overview", to: "/", icon: House }, ...WORKSPACE_LINKS] }];
  const b = `/brands/${brandId}`;
  return [
    { label: "Overview", links: [{ label: "Overview", to: b, icon: House }] },
    { label: "Factory", links: [{ label: "Factory", to: `${b}/factory`, icon: Factory }] },
    { label: "Research", links: [{ label: "Market", to: `${b}/market`, icon: FlaskConical }, { label: "Intelligence", to: `${b}/intelligence`, icon: Sparkles }] },
    { label: "Decide", links: [{ label: "Opportunities", to: `${b}/opportunities`, icon: Layers3 }, { label: "Reviews", to: `${b}/reviews`, icon: Bell, ...(reviews ? { badge: reviews } : {}) }] },
    { label: "Create", links: [{ label: "Studio", to: `${b}/studio`, icon: WandSparkles }, { label: "Library", to: `${b}/library`, icon: Package }] },
    { label: "Learn", links: [{ label: "Learning", to: `${b}/learning`, icon: Activity }, { label: "Calibration", to: `${b}/calibration`, icon: BarChart3 }] },
    { label: "Brand", links: [{ label: "Brand brain", to: `${b}/brain`, icon: Brain }, { label: "Products", to: `${b}/products`, icon: Package }, { label: "Accounts", to: `${b}/accounts`, icon: Layers3 }] },
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
  // The brand comes from the route only. Pages outside /brands/:id show workspace navigation.
  const routeBrandId = path.match(/^\/brands\/([^/]+)/)?.[1];
  const brandId = routeBrandId && routeBrandId !== "new" ? routeBrandId : undefined;
  const brand = data?.brands.find((item) => item.id === brandId);
  const machine = useMachineQuery(brandId ?? "", !!brandId);
  const links = useMemo(() => navGroups(brandId, machine.data?.counts.reviews ?? 0), [brandId, machine.data?.counts.reviews]);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const page = pageName(path);
  const activeOrganizationId = data?.active?.id;
  // Hover and focus warm the cache for the target screen, so the click renders from cache.
  const prefetch = useCallback((to: string) => prefetchScreen(queryClient, { userId: user?.id, organizationId: activeOrganizationId }, to), [queryClient, user?.id, activeOrganizationId]);

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

  const go = useCallback((to: string) => {
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
  }, [navigate]);

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
        const targetPath = {
          o: "/",
          s: brandId ? `/brands/${brandId}/studio` : "/",
          r: brandId ? `/brands/${brandId}/reviews` : "/",
          i: brandId ? `/brands/${brandId}/intelligence` : "/",
          l: brandId ? `/brands/${brandId}/learning` : "/",
          f: brandId ? `/brands/${brandId}/factory` : "/",
          a: brandId ? `/brands/${brandId}/accounts` : "/",
        }[event.key.toLowerCase()];
        if (targetPath) { event.preventDefault(); go(targetPath); }
        gPressedAt = 0; return;
      }
      if (event.key === "/") { event.preventDefault(); setPaletteOpen(true); }
      if (event.key === "?") { event.preventDefault(); setShortcutsOpen(true); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [brandId, go]);

  // Brand switcher: shown in the sidebar on brand-scoped pages only (the caller checks brandId).
  const brandSwitcher = (className: string) => data?.brands.length ? (
    <select aria-label="Brand" className={className} value={brandId ?? ""} onChange={(event) => { if (event.target.value) go(`/brands/${event.target.value}`); }}>
      {data.brands.map((item) => <option key={item.id} value={item.id}>{item.name} · {Math.round(item.completeness * 100)}%</option>)}
    </select>
  ) : null;
  // Workspace switcher: shown at the top of the sidebar on every page.
  const workspaceSwitcher = (className: string) => data?.organizations.length && active ? (
    <select aria-label="Workspace" className={className} value={active.id} onChange={(event) => { void setActiveOrganization({ data: { organizationId: event.target.value } }).then(() => reload()); }}>
      {data.organizations.map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}
    </select>
  ) : null;

  const quickLinks: Array<{ label: string; to: string; icon: LucideIcon }> = brandId
    ? [
      { label: "Overview", to: `/brands/${brandId}`, icon: House },
      { label: "Decide", to: `/brands/${brandId}/opportunities`, icon: Layers3 },
      { label: "Studio", to: `/brands/${brandId}/studio`, icon: WandSparkles },
      { label: "Reviews", to: `/brands/${brandId}/reviews`, icon: Bell },
    ]
    : [
      { label: "Overview", to: "/", icon: House },
      { label: "Alerts", to: "/alerts", icon: Bell },
      { label: "Integrations", to: "/integrations", icon: Activity },
      { label: "Settings", to: "/settings", icon: Settings },
    ];

  const sidebar = (mobile = false) => (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex h-16 items-center justify-between border-b border-border px-4">
        <Link to="/" onClick={() => setMobileNavOpen(false)} className="font-display text-lg font-semibold tracking-tight text-fg">Meridian</Link>
        {mobile ? <button className="grid size-11 place-items-center rounded-md text-fg-muted hover:bg-surface-2" type="button" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation"><X aria-hidden="true" className="size-5" /></button> : null}
      </div>
      {/* Workspace first, brand directly below it on brand-scoped pages. Hidden in the collapsed 5rem rail, which is too narrow for a select; the command palette still switches both. */}
      {(mobile || !collapsed) && data ? <div className="space-y-3 border-b border-border p-4">
        {workspaceSwitcher(SWITCHER_CLASS)}
        {brandId ? brandSwitcher(SWITCHER_CLASS) : null}
      </div> : null}
      <nav aria-label="Primary" className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
        {links.map((group) => <section key={group.label} className="mb-5">
          <h2 className={`eyebrow mb-1 px-2 ${collapsed && !mobile ? "sr-only" : ""}`}>{group.label}</h2>
          {group.links.map(({ label, to, icon: Icon, badge }) => {
            const current = path === to || (label === "Overview" && path === `${to}/`);
            return <Link key={to} to={to as never} params={to.includes("$brandId") && brandId ? { brandId } as never : undefined} aria-current={current ? "page" : undefined} title={collapsed && !mobile ? label : undefined} onClick={() => setMobileNavOpen(false)} onMouseEnter={() => prefetch(to)} onFocus={() => prefetch(to)} className={`mb-1 flex min-h-11 items-center gap-3 rounded-md px-3 text-sm transition-colors ${current ? "bg-accent-soft font-semibold text-fg" : "text-fg-muted hover:bg-surface-2 hover:text-fg"}`}>
              <Icon aria-hidden="true" className={`size-4 shrink-0 ${current ? "text-accent" : ""}`} />
              <span className={collapsed && !mobile ? "sr-only" : "flex-1"}>{label}</span>
              {badge ? <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-bold text-accent-fg">{badge}</span> : null}
            </Link>;
          })}
        </section>)}
        {!brandId ? <Link to="/brands/new" className="flex min-h-11 items-center gap-3 rounded-md px-3 text-sm text-fg-muted hover:bg-surface-2 hover:text-fg"><Sparkles aria-hidden="true" className="size-4" />New brand</Link> : null}
      </nav>
      <div className="border-t border-border p-3">
        <button type="button" onClick={() => { const next = !collapsed; setCollapsed(next); try { localStorage.setItem("meridian-nav-collapsed", String(next)); } catch { /* Keep the in-memory preference when storage is unavailable. */ } }} className="hidden min-h-11 w-full items-center gap-3 rounded-md px-3 text-left text-sm text-fg-muted hover:bg-surface-2 lg:flex" aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}>
          <ChevronDown aria-hidden="true" className={`size-4 transition ${collapsed ? "-rotate-90" : "rotate-90"}`} />{collapsed ? null : "Collapse navigation"}
        </button>
      </div>
    </div>
  );

  return <div className={`min-h-screen ${collapsed ? "lg:grid lg:grid-cols-[5rem_1fr]" : "lg:grid lg:grid-cols-[16rem_1fr]"}`}>
    <aside className="hidden border-r border-border lg:block">{sidebar()}</aside>
    <Sheet direction="left" open={mobileNavOpen} onOpenChange={setMobileNavOpen}><SheetContent className="inset-y-0 left-0 right-auto h-full max-h-none w-[min(20rem,88vw)] rounded-none border-r border-t-0 p-0"><SheetTitle className="sr-only">Primary navigation</SheetTitle>{sidebar(true)}</SheetContent></Sheet>
    <div className="flex min-h-screen min-w-0 flex-col">
      <header className="sticky top-0 z-20 border-b border-border bg-surface/95 backdrop-blur">
        {/* One row at every width: the breadcrumb truncates; the switchers live in the sidebar, not here. */}
        <div className="flex min-h-16 items-center gap-2 px-3 py-2 sm:px-5">
          <button type="button" className="grid size-11 shrink-0 place-items-center rounded-md text-fg-muted hover:bg-surface-2 lg:hidden" aria-label="Open navigation" onClick={() => setMobileNavOpen(true)}><Menu aria-hidden="true" className="size-5" /></button>
          <nav aria-label="Breadcrumb" className="hidden min-w-0 flex-1 items-center gap-2 text-sm md:flex">
            <Link to="/" className="shrink-0 text-fg-muted hover:text-fg">Workspace</Link>{brand ? <><span aria-hidden="true" className="shrink-0 text-border-strong">/</span><span className="min-w-0 max-w-40 truncate text-fg-muted">{brand.name}</span></> : null}<span aria-hidden="true" className="shrink-0 text-border-strong">/</span><span aria-current="page" className="max-w-[70%] shrink-0 truncate font-semibold text-fg">{page}</span>
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {active ? <span className="hidden text-xs uppercase tracking-wide text-fg-muted xl:inline">{active.role}</span> : null}
            <button type="button" onClick={() => setPaletteOpen(true)} className="inline-flex h-10 items-center gap-2 rounded-md border border-border-strong px-3 text-sm text-fg-muted hover:bg-surface-2" aria-label="Search and commands"><Search aria-hidden="true" className="size-4" /><span className="hidden sm:inline">Search</span><kbd className="hidden rounded border border-border px-1 text-[10px] sm:inline">⌘K</kbd></button>
            <Link to="/alerts" aria-label="Open alerts" title="Alerts" className="grid size-10 place-items-center rounded-md text-fg-muted hover:bg-surface-2"><Bell aria-hidden="true" className="size-4" /></Link>
            <button type="button" aria-label="Toggle theme" title="Toggle theme" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} className="grid size-10 place-items-center rounded-md text-fg-muted hover:bg-surface-2">{theme === "dark" ? <Sun aria-hidden="true" className="size-4" /> : <Moon aria-hidden="true" className="size-4" />}</button>
            <UserButton />
          </div>
        </div>
      </header>
      <div className="border-b border-border bg-surface px-4 py-2 text-sm text-fg-muted md:hidden" aria-hidden="true">{brand ? `${brand.name} / ` : ""}{page}</div>
      <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-4 py-6 pb-28 sm:px-6 lg:px-8 lg:pb-8">{children}</main>
      <nav aria-label="Quick navigation" className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-4 border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
        {quickLinks.map(({ label, to, icon: Icon }) => <Link key={label} to={to as never} aria-current={path === to ? "page" : undefined} onMouseEnter={() => prefetch(to)} onFocus={() => prefetch(to)} className={`flex min-h-14 flex-col items-center justify-center gap-1 text-[11px] ${path === to ? "font-semibold text-accent" : "text-fg-muted"}`}><Icon aria-hidden="true" className="size-5" />{label}</Link>)}
      </nav>
      <p className="sr-only" aria-live="polite" aria-atomic="true">{page}</p>
    </div>
    <Command.Dialog open={paletteOpen} onOpenChange={setPaletteOpen} label="Command palette" className="fixed left-1/2 top-[18vh] z-50 w-[min(38rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-surface shadow-lg">
      <Command.Input autoFocus placeholder="Search screens, brands, and operator actions…" className="h-14 w-full border-b border-border bg-transparent px-4 text-fg outline-none placeholder:text-fg-muted" />
      <Command.List className="max-h-[60vh] overflow-auto p-2"><Command.Empty className="p-4 text-sm text-fg-muted">No matching command.</Command.Empty>
        {data?.brands && data.brands.length > 0 ? (
          <Command.Group heading="Switch Brand" className={GROUP_CLASS}>
            {data.brands.map((b) => (
              <Command.Item
                key={b.id}
                value={`Switch Brand ${b.name}`}
                onSelect={() => go(`/brands/${b.id}`)}
                className={ITEM_CLASS}
              >
                {b.name}
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}
        {brandId ? (
          <Command.Group heading="Operator Actions" className={GROUP_CLASS}>
            <Command.Item value="Queue and Schedule Multi-Account Publish" onSelect={() => go(`/brands/${brandId}/studio`)} className={ITEM_CLASS}>
              Multi-Account Publishing Queue
            </Command.Item>
            <Command.Item value="JEV Whitespace and Account DNA" onSelect={() => go(`/brands/${brandId}/intelligence`)} className={ITEM_CLASS}>
              JEV Multimodal Account Intelligence
            </Command.Item>
            <Command.Item value="Telemetry and Bayesian Flywheel" onSelect={() => go(`/brands/${brandId}/learning`)} className={ITEM_CLASS}>
              Multi-Channel Performance Telemetry
            </Command.Item>
            <Command.Item value="Connected Accounts and Vault" onSelect={() => go(`/brands/${brandId}/accounts`)} className={ITEM_CLASS}>
              Encrypted Credential Vault &amp; Accounts
            </Command.Item>
            <Command.Item value="Factory Pipeline" onSelect={() => go(`/brands/${brandId}/factory`)} className={ITEM_CLASS}>
              Content Factory Pipeline
            </Command.Item>
          </Command.Group>
        ) : null}
        <Command.Group heading="Navigate Screens" className={GROUP_CLASS}>
          {brandId ? <>
            {[["Overview", `/brands/${brandId}`], ["Factory", `/brands/${brandId}/factory`], ["Market", `/brands/${brandId}/market`], ["Intelligence", `/brands/${brandId}/intelligence`], ["Opportunities", `/brands/${brandId}/opportunities`], ["Reviews", `/brands/${brandId}/reviews`], ["Studio", `/brands/${brandId}/studio`], ["Library", `/brands/${brandId}/library`], ["Learning", `/brands/${brandId}/learning`], ["Brand brain", `/brands/${brandId}/brain`], ["Products", `/brands/${brandId}/products`], ["Accounts", `/brands/${brandId}/accounts`]].map(([label, to]) => <Command.Item key={to} value={label} onSelect={() => go(to)} className={ITEM_CLASS}>{label}</Command.Item>)}
          </> : null}
          <Command.Item value="Workspace overview" onSelect={() => go("/")} className={ITEM_CLASS}>Workspace overview</Command.Item>
          <Command.Item value="Usage and cost" onSelect={() => go("/usage")} className={ITEM_CLASS}>Usage &amp; cost</Command.Item>
          <Command.Item value="Alerts center" onSelect={() => go("/alerts")} className={ITEM_CLASS}>Alerts center</Command.Item>
          <Command.Item value="Audit log" onSelect={() => go("/audit")} className={ITEM_CLASS}>Audit log</Command.Item>
          <Command.Item value="Webhook events" onSelect={() => go("/webhooks")} className={ITEM_CLASS}>Webhook events</Command.Item>
          <Command.Item value="Notification preferences" onSelect={() => go("/notifications")} className={ITEM_CLASS}>Notification preferences</Command.Item>
          <Command.Item value="New brand" onSelect={() => go("/brands/new")} className={ITEM_CLASS}>New brand</Command.Item>
          <Command.Item value="Settings" onSelect={() => go("/settings")} className={ITEM_CLASS}>Settings</Command.Item>
          <Command.Item value="Integrations" onSelect={() => go("/integrations")} className={ITEM_CLASS}>Integrations</Command.Item>
        </Command.Group>
        <Command.Group heading="Preferences &amp; System" className={GROUP_CLASS}>
          <Command.Item value="Toggle theme" onSelect={() => { setPaletteOpen(false); setTheme(theme === "dark" ? "light" : "dark"); }} className={ITEM_CLASS}>Toggle theme</Command.Item>
          {brandId ? <Command.Item value="Refresh opportunities" onSelect={() => { setPaletteOpen(false); void queryClient.invalidateQueries({ queryKey: userScopedQueryKey(user?.id, qk.opportunities(brandId)) }); }} className={ITEM_CLASS}>Refresh opportunities</Command.Item> : null}
          {brandId ? <Command.Item value="Open reviews" onSelect={() => go(`/brands/${brandId}/reviews`)} className={ITEM_CLASS}>Open reviews</Command.Item> : null}
          {data && data.organizations.length > 1 && active ? <Command.Item value="Switch workspace" onSelect={() => { setPaletteOpen(false); const index = data.organizations.findIndex((item) => item.id === active.id); const next = data.organizations[(index + 1) % data.organizations.length]; void setActiveOrganization({ data: { organizationId: next.id } }).then(() => reload()); }} className={ITEM_CLASS}>Switch workspace</Command.Item> : null}
          <Command.Item value="Keyboard shortcuts" onSelect={() => { setPaletteOpen(false); setShortcutsOpen(true); }} className={ITEM_CLASS}>Keyboard shortcuts</Command.Item>
        </Command.Group>
      </Command.List>
    </Command.Dialog>
    {paletteOpen ? <button className="fixed inset-0 z-40 cursor-default bg-black/40" aria-label="Close command palette" onClick={() => setPaletteOpen(false)} /> : null}
    <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
      <DialogContent aria-describedby="shortcut-description" className="max-w-md">
        <DialogTitle className="text-section font-semibold">Keyboard shortcuts</DialogTitle>
        <DialogDescription id="shortcut-description" className="mt-1 text-sm text-fg-muted">Single-key shortcuts work when no text field has focus.</DialogDescription>
        <dl className="mt-4 grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-3 text-sm">
          <dt>Open search and commands</dt><dd><Kbd>⌘ / Ctrl K</Kbd></dd>
          <dt>Overview</dt><dd><Kbd>G O</Kbd></dd>
          <dt>Studio</dt><dd><Kbd>G S</Kbd></dd>
          <dt>Reviews</dt><dd><Kbd>G R</Kbd></dd>
          <dt>Intelligence</dt><dd><Kbd>G I</Kbd></dd>
          <dt>Learning</dt><dd><Kbd>G L</Kbd></dd>
          <dt>Factory</dt><dd><Kbd>G F</Kbd></dd>
          <dt>Connected accounts</dt><dd><Kbd>G A</Kbd></dd>
          <dt>Focus search</dt><dd><Kbd>/</Kbd></dd>
          <dt>Show this help</dt><dd><Kbd>?</Kbd></dd>
        </dl>
        <div className="mt-5 flex justify-end"><DialogClose asChild><Button variant="secondary" size="md">Close</Button></DialogClose></div>
      </DialogContent>
    </Dialog>
  </div>;
}

function pageName(path: string) {
  if (path === "/") return PAGE_NAMES[""];
  // /brands/:id is the brand overview. Without this, the brand UUID became the page name.
  if (/^\/brands\/(?!new$)[^/]+$/.test(path)) return PAGE_NAMES[""];
  const parts = path.split("/").filter(Boolean);
  const last = parts.at(-1) ?? "";
  return PAGE_NAMES[last] ?? last.replaceAll("-", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function readCollapsed() {
  try { return typeof window !== "undefined" && window.localStorage.getItem("meridian-nav-collapsed") === "true"; }
  catch { return false; }
}
