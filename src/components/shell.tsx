import { useState, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { UserButton } from "@/lib/auth/gates";
import { setActiveOrganization } from "@/lib/meridian/api";
import { useWorkspace } from "@/components/workspace";
import { SelectInput } from "@/components/ui";

const BRAND_LINKS = [
  { to: "/brands/$brandId", label: "Overview" },
  { to: "/brands/$brandId/market", label: "Market" },
  { to: "/brands/$brandId/intelligence", label: "Intelligence" },
  { to: "/brands/$brandId/opportunities", label: "Opportunities" },
  { to: "/brands/$brandId/studio", label: "Studio" },
  { to: "/brands/$brandId/library", label: "Library" },
  { to: "/brands/$brandId/reviews", label: "Reviews" },
  { to: "/brands/$brandId/learning", label: "Learning" },
  { to: "/brands/$brandId/brain", label: "Brand brain" },
  { to: "/brands/$brandId/products", label: "Products" },
] as const;

export function Shell({ children }: { children: ReactNode }) {
  const { data, reload } = useWorkspace();
  const path = useRouterState({ select: (state) => state.location.pathname.replace(/\/$/, "") || "/" });
  const active = data?.active;
  const brandId = path.match(/^\/brands\/([^/]+)/)?.[1];
  const inBrand = Boolean(brandId && brandId !== "new");
  const brand = data?.brands.find((item) => item.id === brandId);
  const [open, setOpen] = useState(false);

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[15rem_1fr]">
      {inBrand && brandId ? (
        <aside className="border-b border-line bg-panel lg:min-h-screen lg:border-b-0 lg:border-r">
          <div className="flex items-center justify-between px-4 py-4">
            <Link to="/" className="font-display text-lg font-semibold">
              Meridian
            </Link>
            <button type="button" className="min-h-11 rounded-md px-3 text-sm font-semibold lg:hidden" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
              {open ? "Close" : "Menu"}
            </button>
          </div>
          <div className={`${open ? "block" : "hidden"} px-3 pb-4 lg:block`}>
            <p className="px-2 text-xs font-semibold uppercase tracking-widest text-muted">{brand?.name ?? "Brand"}</p>
            <nav aria-label="Brand" className="mt-2 grid gap-1">
              {BRAND_LINKS.map((link) => {
                const href = link.to.replace("$brandId", brandId);
                const current = path === href;
                return (
                  <Link
                    key={link.to}
                    to={link.to}
                    params={{ brandId }}
                    aria-current={current ? "page" : undefined}
                    className={`rounded-md px-2 py-2 text-sm font-semibold ${current ? "bg-ink text-paper" : "text-ink hover:bg-paper"}`}
                    onClick={() => setOpen(false)}
                  >
                    {link.label}
                  </Link>
                );
              })}
            </nav>
            <div className="mt-4 border-t border-line pt-3">
              <Link to="/integrations" className="block rounded-md px-2 py-2 text-sm font-semibold text-ink hover:bg-paper" aria-current={path === "/integrations" ? "page" : undefined}>
                Integrations
              </Link>
              <Link to="/settings" className="block rounded-md px-2 py-2 text-sm font-semibold text-ink hover:bg-paper" aria-current={path === "/settings" ? "page" : undefined}>
                Settings
              </Link>
            </div>
          </div>
        </aside>
      ) : null}
      <div className="min-w-0">
        <header className="border-b border-line bg-panel/80">
          <div className="flex flex-wrap items-center gap-3 px-4 py-3">
            {inBrand ? null : (
              <Link to="/" className="font-display text-lg font-semibold">
                Meridian
              </Link>
            )}
            {active ? (
              <nav aria-label="Workspace" className="flex items-center gap-1 text-sm">
                <Link to="/" aria-current={path === "/" ? "page" : undefined} className={`rounded-md px-2 py-2 ${path === "/" ? "bg-ink text-paper" : ""}`}>
                  Workspace
                </Link>
              </nav>
            ) : null}
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {data && data.organizations.length > 1 && active ? (
                <SelectInput
                  aria-label="Workspace"
                  className="w-auto max-w-48 py-2"
                  value={active.id}
                  onChange={(event) => {
                    void setActiveOrganization({ data: { organizationId: event.target.value } }).then(() => reload());
                  }}
                >
                  {data.organizations.map((org) => (
                    <option key={org.id} value={org.id}>
                      {org.name}
                    </option>
                  ))}
                </SelectInput>
              ) : active ? (
                <span className="text-sm text-muted">{active.name}</span>
              ) : null}
              {active ? <span className="text-xs uppercase tracking-wide text-muted">{active.role}</span> : null}
              <UserButton />
            </div>
          </div>
        </header>
        <main id="main" tabIndex={-1} className="px-4 py-6 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
