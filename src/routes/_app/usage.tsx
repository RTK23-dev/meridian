import { createFileRoute } from "@tanstack/react-router";
import { UsageScreen } from "@/components/ops/usage-screen";

export const Route = createFileRoute("/_app/usage")({ staticData: { pageTitle: "Usage & cost" }, component: UsageScreen });
