import { createFileRoute } from "@tanstack/react-router";
import { OrchestratorScreen } from "@/components/content-factory/orchestrator-screen";

export const Route = createFileRoute("/_app/orchestrator")({ staticData: { pageTitle: "Orchestrator" }, component: OrchestratorScreen });
