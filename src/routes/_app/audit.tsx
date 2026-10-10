import { createFileRoute } from "@tanstack/react-router";
import { AuditScreen } from "@/components/ops/audit-screen";

export const Route = createFileRoute("/_app/audit")({ staticData: { pageTitle: "Audit log" }, component: AuditScreen });
