import { createFileRoute } from "@tanstack/react-router";
import { AlertsCenter } from "@/components/ops/alerts-center";

export const Route = createFileRoute("/_app/alerts")({ staticData: { pageTitle: "Alerts center" }, component: AlertsCenter });
