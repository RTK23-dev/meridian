import { Link, useRouterState } from "@tanstack/react-router";

const LINKS = [
  { to: "/brands/$brandId", label: "Brand" },
  { to: "/brands/$brandId/brain", label: "Brain" },
  { to: "/brands/$brandId/products", label: "Products" },
  { to: "/brands/$brandId/market", label: "Market" },
  { to: "/brands/$brandId/intelligence", label: "Intelligence" },
  { to: "/brands/$brandId/opportunities", label: "Opportunities" },
  { to: "/brands/$brandId/library", label: "Library" },
  { to: "/brands/$brandId/reviews", label: "Reviews" },
  { to: "/brands/$brandId/learning", label: "Learning" },
] as const;

export function BrandNav({ brandId }: { brandId: string }) {
  const path = useRouterState({ select: (state) => state.location.pathname.replace(/\/$/, "") });
  return (
    <nav className="flex gap-2 overflow-x-auto pb-1">
      {LINKS.map((link) => {
        const href = link.to.replace("$brandId", brandId);
        const current = path === href;
        return (
          <Link
            key={link.to}
            to={link.to}
            params={{ brandId }}
            className={`inline-flex min-h-11 shrink-0 items-center rounded-md px-3 text-sm font-semibold ${current ? "bg-ink text-paper" : "border border-line bg-panel text-ink"}`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
