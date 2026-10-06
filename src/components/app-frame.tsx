import type { ReactNode } from "react";
import { useRouterState } from "@tanstack/react-router";
import { ProtectedApp } from "@/components/gate";

const protectedRoots = ["/", "/brands", "/settings", "/integrations", "/jobs", "/invite"];

export function AppFrame({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isProtected = protectedRoots.some((root) => root === "/"
    ? pathname === root
    : pathname === root || pathname.startsWith(`${root}/`));

  return isProtected ? <ProtectedApp>{children}</ProtectedApp> : <>{children}</>;
}
