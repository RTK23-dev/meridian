import { createFileRoute } from "@tanstack/react-router";
import { BillingScreen } from "@/components/billing/billing-screen";
import { useWorkspace } from "@/components/workspace";

export const Route = createFileRoute("/_app/billing")({ staticData: { pageTitle: "Billing" }, component: BillingRoute });

function BillingRoute() {
  const { data } = useWorkspace();
  if (!data?.active) return <p className="text-fg-muted">Create a workspace first.</p>;
  return <BillingScreen organizationId={data.active.id} />;
}
