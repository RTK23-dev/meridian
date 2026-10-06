import type { ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { UserButton } from "@/lib/auth/gates";
import { setActiveOrganization } from "@/lib/meridian/api";
import { useWorkspace } from "@/components/workspace";
import { SelectInput } from "@/components/ui";

export function Shell({ children }: { children: ReactNode }) {
  const { data, reload } = useWorkspace();
  const path = useRouterState({ select: (state) => state.location.pathname });
  const active = data?.active;

  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-panel">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-4">
          <Link to="/" className="font-display text-xl font-semibold tracking-wide">
            Meridian
          </Link>
          {active ? (
            <nav aria-label="Workspace" className="flex items-center gap-2 text-sm">
              <NavLink to="/" current={path === "/"}>
                Overview
              </NavLink>
              <NavLink to="/settings" current={path === "/settings"}>
                Workspace
              </NavLink>
              <NavLink to="/integrations" current={path === "/integrations"}>
                Integrations
              </NavLink>
            </nav>
          ) : null}
          <div className="ml-auto flex flex-wrap items-center gap-3">
            {data && data.organizations.length > 1 && active ? (
              <SelectInput
                aria-label="Workspace"
                className="w-auto max-w-56"
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
            {active ? (
              <span className="rounded-md border border-line px-2 py-1 text-xs uppercase tracking-wide text-muted">
                {active.role}
              </span>
            ) : null}
            <UserButton />
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}

function NavLink({ to, current, children }: { to: "/" | "/settings" | "/integrations"; current: boolean; children: ReactNode }) {
  return (
    <Link
      to={to}
      aria-current={current ? "page" : undefined}
      className={`inline-flex min-h-11 items-center rounded-md px-3 ${current ? "bg-ink text-paper" : "text-ink hover:bg-paper"}`}
    >
      {children}
    </Link>
  );
}
