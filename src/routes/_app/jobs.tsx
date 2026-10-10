import { createFileRoute } from "@tanstack/react-router";
import { JobsScreen } from "@/components/ops/jobs-screen";

export const Route = createFileRoute("/_app/jobs")({ staticData: { pageTitle: "Jobs & health" }, component: JobsScreen });
