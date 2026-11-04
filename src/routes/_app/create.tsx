import { createFileRoute } from "@tanstack/react-router";
import { CreatePage } from "@/components/create/create-page";

/** One place to make something: the Content chat, Orchestrator and Studio, merged. The older screens remain reachable by their links. */
export const Route = createFileRoute("/_app/create")({ staticData: { pageTitle: "Create" }, component: CreatePage });
