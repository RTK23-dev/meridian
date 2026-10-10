import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useMatches, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Activity, BarChart3, Bell, BellRing, Brain, ChevronDown, ClipboardCheck, Download, FileClock, FlaskConical, GraduationCap, House, Layers3, Library, Menu, MoreHorizontal, Moon, Package, Plug, Search, Settings, Sparkles, Sun, Webhook, WandSparkles, X, type LucideIcon } from "lucide-react";
import { UserButton } from "@/lib/auth/gates";
import { setActiveOrganization } from "@/lib/meridian/api";
import { hasRole } from "@/lib/meridian/access";
import { useWorkspace } from "@/components/workspace";
import { useAlertsQuery, useMachineQuery } from "@/lib/query/hooks";
import { prefetchScreen } from "@/lib/query/prefetch";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { Button, Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, Kbd, Sheet, SheetContent, SheetTitle, useTheme } from "@/components/ui";
import { CommandPalette } from "@/components/command-palette";
import { PageCommandProvider, usePageCommandRegistry } from "@/components/page-commands";
import { bottomTabs, brandIdFromPath, documentTitle, isCurrentPath, LAST_BRAND_KEY, resolveLastBrand, sidebarGroups, unreadAlertLabel, type NavGroup } from "@/lib/navigation/model";
import { chordPath, INITIAL_SHORTCUT_STATE, nextShortcutState, type ShortcutState } from "@/lib/navigation/shortcuts";
import { readLocal, writeLocal } from "@/lib/navigation/local-storage";
import { routePageTitle } from "@/lib/navigation/route-data";

const COLLAPSED_KEY = "meridian-nav-collapsed";
const SWITCHER_CLASS = "min-h-11 w-full rounded-md border border-border-strong bg-surface px-2 text-sm text-fg";

/** One icon per sidebar and tab item. Items without an entry fall back to the overview icon. */
const NAV_ICONS: Record<string, LucideIcon> = {
  overview: House,
  "brand-overview": House,
  market: FlaskConical,
  intelligence: Sparkles,
  opportunities: Layers3,
  reviews: ClipboardCheck,
  studio: WandSparkles,
  library: Library,
  learning: GraduationCap,
  brain: Brain,
  products: Package,
  jobs: Activity,
  usage: BarChart3,
  alerts: Bell,
  integrations: Plug,
  settings: Settings,
  audit: FileClock,
  exports: Download,
  webhooks: Webhook,
  notifications: BellRing,
};

/** The shell owns the page-command registry, so screens inside it can register actions. */
export function Shell({ children }: { children: ReactNode }) {
  return <PageCommandProvider><ShellChrome>{children}</ShellChrome></PageCommandProvider>;
}

function ShellChrome({ children }: { children: ReactNode }) {
  const { data, reload } = useWorkspace();
  const path = useRouterState({ select: (state) => state.location.pathname.replace(/\/$/, "") || "/" });
  const matches = useMatches();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useCurrentUserState();
  const { theme, setTheme } = useTheme();
  const registry = usePageCommandRegistry();
  const active = data?.active;
  // The brand comes from the route only. Pages outside /brands/:id show workspace navigation.
  const brandId = brandIdFromPath(path);
  const brand = data?.brands.find((item) => item.id === brandId);
  const machine = useMachineQuery(brandId ?? "", !!brandId);
  const alerts = useAlertsQuery(active?.id ?? "", !!active);
  // A count is passed only once it has loaded. Null means "unknown", and the sidebar shows no badge for it.
  const reviewCount = machine.data ? machine.data.counts.reviews : null;
  const groups = useMemo(() => sidebarGroups({ brandId, reviewCount }), [brandId, reviewCount]);
  const bellLabel = alerts.data ? unreadAlertLabel(alerts.data.alerts) : null;
  const tabs = bottomTabs(brandId);
  const canAddBrand = active ? hasRole(active.role, "member") : false;
  const pageTitle = routePageTitle(matches);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const shortcutState = useRef<ShortcutState>(INITIAL_SHORTCUT_STATE);
  const activeOrganizationId = active?.id;
  // Hover and focus warm the cache for the target screen, so the click renders from cache.
  const prefetch = useCallback((to: string) => prefetchScreen(queryClient, { userId: user?.id, organizationId: activeOrganizationId }, to), [queryClient, user?.id, activeOrganizationId]);

  const go = useCallback((to: string) => {
    setPaletteOpen(false);
    setMobileNavOpen(false);
    void navigate({ to: to as never });
  }, [navigate]);

  const switchWorkspace = useCallback((organizationId: string) => {
    setPaletteOpen(false);
    void setActiveOrganization({ data: { organizationId } })
      .then(() => reload())
      .then(() => {
        // A brand belongs to one workspace, so leave a brand page when the workspace changes.
        if (brandId) void navigate({ to: "/" });
      });
  }, [brandId, navigate, reload]);

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    writeLocal(COLLAPSED_KEY, String(next));
  };

  // Remember the brand the user opened, so the next app open without a brand in the URL can return to it.
  useEffect(() => {
    if (brandId) writeLocal(LAST_BRAND_KEY, brandId);
  }, [brandId]);

  // On the first load with the workspace known, open the remembered brand instead of the workspace home.
  const entryHandled = useRef(false);
  useEffect(() => {
    if (entryHandled.current || !data) return;
    entryHandled.current = true;
    if (path !== "/") return;
    const remembered = resolveLastBrand(readLocal(LAST_BRAND_KEY), data.brands.map((item) => item.id));
    if (remembered) void navigate({ to: `/brands/${remembered}` as never, replace: true });
  }, [data, navigate, path]);

  useEffect(() => {
    document.title = documentTitle({ page: pageTitle, brandName: brand?.name });
  }, [pageTitle, brand?.name]);

  // Focus the page heading on every route change. A page without a heading yet gets the main landmark.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const heading = document.querySelector<HTMLElement>("#main h1");
      const target = heading ?? document.getElementById("main");
      if (heading) heading.tabIndex = -1;
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [path]);

  const overlayOpen = paletteOpen || shortcutsOpen || mobileNavOpen;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }
      const ignore = event.metaKey || event.ctrlKey || event.altKey || overlayOpen || isTypingTarget(event.target);
      const { state, action } = nextShortcutState(shortcutState.current, { key: event.key, now: Date.now(), ignore });
      shortcutState.current = state;
      if (!action) return;
      event.preventDefault();
      if (action.kind === "palette") setPaletteOpen(true);
      else if (action.kind === "help") setShortcutsOpen(true);
      else {
        const to = chordPath(action.target, brandId);
        if (to) go(to);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [brandId, go, overlayOpen]);

  // Brand switcher: shown in the sidebar on brand-scoped pages only (the caller checks brandId).
  const brandSwitcher = (className: string) => data?.brands.length ? (
    <select aria-label="Brand" className={className} value={brandId ?? ""} onChange={(event) => { if (event.target.value) go(`/brands/${event.target.value}`); }}>
      {data.brands.map((item) => <option key={item.id} value={item.id}>{item.name} · {Math.round(item.completeness * 100)}%</option>)}
    </select>
  ) : null;
  // Workspace switcher: shown at the top of the sidebar on every page.
  const workspaceSwitcher = (className: string) => data?.organizations.length && active ? (
    <select aria-label="Workspace" className={className} value={active.id} onChange={(event) => switchWorkspace(event.target.value)}>
      {data.organizations.map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}
    </select>
  ) : null;

  const sidebar = (mobile = false) => {
    const iconOnly = collapsed && !mobile;
    return <div className="flex h-full flex-col bg-surface">
      <div className="flex h-16 items-center justify-between border-b border-border px-4">
        <Link to="/" onClick={() => setMobileNavOpen(false)} className="font-display text-lg font-semibold tracking-tight text-fg">Meridian</Link>
        {mobile ? <button className="grid size-11 place-items-center rounded-md text-fg-muted hover:bg-surface-2" type="button" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation"><X aria-hidden="true" className="size-5" /></button> : null}
      </div>
      {/* Workspace first, brand directly below it on brand-scoped pages. Hidden in the collapsed rail, which is too narrow for a select; the command palette still switches both. */}
      {(mobile || !collapsed) && data ? <div className="space-y-3 border-b border-border p-4">
        {workspaceSwitcher(SWITCHER_CLASS)}
        {brandId ? brandSwitcher(SWITCHER_CLASS) : null}
      </div> : null}
      <nav aria-label="Primary" className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
        {groups.map((group: NavGroup) => <section key={group.id} className="mb-5">
          <h2 className={`eyebrow mb-1 px-2 ${iconOnly ? "sr-only" : ""}`}>{group.label}</h2>
          {group.items.map((item) => {
            const Icon = NAV_ICONS[item.id] ?? House;
            const current = isCurrentPath(path, item.to);
            return <Link key={item.id} to={item.to as never} aria-current={current ? "page" : undefined} title={iconOnly ? item.label : undefined} onClick={() => setMobileNavOpen(false)} onMouseEnter={() => prefetch(item.to)} onFocus={() => prefetch(item.to)} className={`mb-1 flex min-h-11 items-center gap-3 rounded-md px-3 text-sm transition-colors ${current ? "bg-accent-soft font-semibold text-fg" : "text-fg-muted hover:bg-surface-2 hover:text-fg"}`}>
              <Icon aria-hidden="true" className={`size-4 shrink-0 ${current ? "text-accent" : ""}`} />
              <span className={iconOnly ? "sr-only" : "flex-1"}>{item.label}</span>
              {item.badge ? <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-bold text-accent-fg">{item.badge}<span className="sr-only"> open</span></span> : null}
            </Link>;
          })}
        </section>)}
        {!brandId && canAddBrand ? <Link to="/brands/new" className="flex min-h-11 items-center gap-3 rounded-md px-3 text-sm text-fg-muted hover:bg-surface-2 hover:text-fg"><Sparkles aria-hidden="true" className="size-4" />New brand</Link> : null}
      </nav>
      <div className="border-t border-border p-3">
        <button type="button" onClick={toggleCollapsed} className="hidden min-h-11 w-full items-center gap-3 rounded-md px-3 text-left text-sm text-fg-muted hover:bg-surface-2 lg:flex" aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}>
          <ChevronDown aria-hidden="true" className={`size-4 transition ${collapsed ? "-rotate-90" : "rotate-90"}`} />{collapsed ? null : "Collapse navigation"}
        </button>
      </div>
    </div>;
  };

  return <div className={`min-h-screen ${collapsed ? "lg:grid lg:grid-cols-[5rem_1fr]" : "lg:grid lg:grid-cols-[16rem_1fr]"}`}>
    <aside className="hidden border-r border-border lg:block">{sidebar()}</aside>
    <Sheet direction="left" open={mobileNavOpen} onOpenChange={setMobileNavOpen}><SheetContent className="inset-y-0 left-0 right-auto h-full max-h-none w-[min(20rem,88vw)] rounded-none border-r border-t-0 p-0"><SheetTitle className="sr-only">Primary navigation</SheetTitle>{sidebar(true)}</SheetContent></Sheet>
    <div className="flex min-h-screen min-w-0 flex-col">
      <header className="sticky top-0 z-20 border-b border-border bg-surface/95 backdrop-blur">
        {/* One row at every width, never wrapping: the breadcrumb truncates on the left, the actions stay on the right. */}
        <div className="flex min-h-16 flex-nowrap items-center gap-2 px-3 py-2 sm:px-5">
          <button type="button" className="grid size-11 shrink-0 place-items-center rounded-md text-fg-muted hover:bg-surface-2 lg:hidden" aria-label="Open navigation" onClick={() => setMobileNavOpen(true)}><Menu aria-hidden="true" className="size-5" /></button>
          <nav aria-label="Breadcrumb" className="hidden min-w-0 flex-1 items-center gap-2 text-sm md:flex">
            <Link to="/" className="shrink-0 text-fg-muted hover:text-fg">Workspace</Link>
            {brand ? <><span aria-hidden="true" className="shrink-0 text-border-strong">/</span><span className="min-w-0 max-w-40 truncate text-fg-muted">{brand.name}</span></> : null}
            {pageTitle ? <><span aria-hidden="true" className="shrink-0 text-border-strong">/</span><span aria-current="page" className="min-w-0 truncate font-semibold text-fg">{pageTitle}</span></> : null}
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {active ? <span className="hidden text-xs uppercase tracking-wide text-fg-muted xl:inline">{active.role}</span> : null}
            <button type="button" onClick={() => setPaletteOpen(true)} className="inline-flex h-10 items-center gap-2 rounded-md border border-border-strong px-3 text-sm text-fg-muted hover:bg-surface-2" aria-label="Search and commands"><Search aria-hidden="true" className="size-4" /><span className="hidden sm:inline">Search</span><kbd className="hidden rounded border border-border px-1 text-[10px] sm:inline">⌘K</kbd></button>
            <Link to="/alerts" aria-label={bellLabel ? `Alerts, ${bellLabel} unread` : "Alerts"} title="Alerts" className="relative grid size-10 place-items-center rounded-md text-fg-muted hover:bg-surface-2">
              <Bell aria-hidden="true" className="size-4" />
              {bellLabel ? <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] font-bold leading-4 text-accent-fg">{bellLabel}</span> : null}
            </Link>
            <button type="button" aria-label="Toggle theme" title="Toggle theme" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} className="grid size-10 place-items-center rounded-md text-fg-muted hover:bg-surface-2">{theme === "dark" ? <Sun aria-hidden="true" className="size-4" /> : <Moon aria-hidden="true" className="size-4" />}</button>
            <UserButton />
          </div>
        </div>
      </header>
      <div className="border-b border-border bg-surface px-4 py-2 text-sm text-fg-muted md:hidden" aria-hidden="true">{brand ? `${brand.name} / ` : ""}{pageTitle ?? ""}</div>
      <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-4 py-6 pb-28 sm:px-6 lg:px-8 lg:pb-8">{children}</main>
      <nav aria-label="Quick navigation" className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
        {tabs.map((tab) => {
          const Icon = NAV_ICONS[tab.id] ?? House;
          const current = isCurrentPath(path, tab.to);
          return <Link key={tab.id} to={tab.to as never} aria-current={current ? "page" : undefined} onMouseEnter={() => prefetch(tab.to)} onFocus={() => prefetch(tab.to)} className={`flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 px-0.5 text-[10px] ${current ? "font-semibold text-accent" : "text-fg-muted"}`}><Icon aria-hidden="true" className="size-5 shrink-0" /><span className="max-w-full truncate">{tab.label}</span></Link>;
        })}
        <button type="button" onClick={() => setMobileNavOpen(true)} aria-haspopup="dialog" aria-expanded={mobileNavOpen} className="flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 px-0.5 text-[10px] text-fg-muted"><MoreHorizontal aria-hidden="true" className="size-5 shrink-0" /><span className="max-w-full truncate">More</span></button>
      </nav>
      <p className="sr-only" aria-live="polite" aria-atomic="true">{pageTitle ?? ""}</p>
    </div>
    <CommandPalette
      open={paletteOpen}
      onOpenChange={setPaletteOpen}
      brands={data?.brands ?? []}
      workspaces={data?.organizations ?? []}
      activeWorkspaceId={activeOrganizationId}
      brandId={brandId}
      canCreateBrand={canAddBrand}
      pageCommands={registry?.readAll() ?? []}
      onNavigate={go}
      onSwitchWorkspace={switchWorkspace}
      onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
      onShowShortcuts={() => { setPaletteOpen(false); setShortcutsOpen(true); }}
    />
    <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
      <DialogContent aria-describedby="shortcut-description" className="max-w-md">
        <DialogTitle className="text-section font-semibold">Keyboard shortcuts</DialogTitle>
        <DialogDescription id="shortcut-description" className="mt-1 text-sm text-fg-muted">Single-key shortcuts work when no text field has focus. Screen shortcuts need a brand page open.</DialogDescription>
        <dl className="mt-4 grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-3 text-sm">
          <dt>Open search and commands</dt><dd><Kbd>⌘ / Ctrl K</Kbd></dd>
          <dt>Focus search</dt><dd><Kbd>/</Kbd></dd>
          <dt>Show this help</dt><dd><Kbd>?</Kbd></dd>
          <dt>Overview</dt><dd><Kbd>G O</Kbd></dd>
          <dt>Studio</dt><dd><Kbd>G S</Kbd></dd>
          <dt>Reviews</dt><dd><Kbd>G R</Kbd></dd>
          <dt>Intelligence</dt><dd><Kbd>G I</Kbd></dd>
          <dt>Learning</dt><dd><Kbd>G L</Kbd></dd>
          <dt>Factory</dt><dd><Kbd>G F</Kbd></dd>
          <dt>Connected accounts</dt><dd><Kbd>G A</Kbd></dd>
        </dl>
        <div className="mt-5 flex justify-end"><DialogClose asChild><Button variant="secondary" size="md">Close</Button></DialogClose></div>
      </DialogContent>
    </Dialog>
  </div>;
}

/** Shortcuts must not fire while the user types. Content-editable counts as typing. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function readCollapsed() {
  return readLocal(COLLAPSED_KEY) === "true";
}
