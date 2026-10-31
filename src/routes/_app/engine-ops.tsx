import { createFileRoute } from "@tanstack/react-router";
import { EngineOpsScreen } from "@/components/ops/engine-ops-screen";

export const Route = createFileRoute("/_app/engine-ops")({ staticData: { pageTitle: "Engine operations" }, component: EngineOpsScreen });
