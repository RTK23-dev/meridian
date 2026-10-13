import { createFileRoute } from "@tanstack/react-router";
import { SetupGuide } from "@/components/setup/setup-guide";

export const Route = createFileRoute("/_app/setup")({ staticData: { pageTitle: "Setup" }, component: SetupPage });

function SetupPage() {
  return <SetupGuide />;
}
