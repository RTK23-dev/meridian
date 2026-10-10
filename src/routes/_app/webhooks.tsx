import { createFileRoute } from "@tanstack/react-router";
import { WebhookEventsScreen } from "@/components/ops/webhook-events-screen";

export const Route = createFileRoute("/_app/webhooks")({ staticData: { pageTitle: "Webhook events" }, component: WebhookEventsScreen });
