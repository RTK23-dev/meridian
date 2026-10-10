import { createFileRoute } from "@tanstack/react-router";
import { ExportsScreen } from "@/components/ops/exports-screen";

export const Route = createFileRoute("/_app/exports")({ staticData: { pageTitle: "Exports" }, component: ExportsScreen });
