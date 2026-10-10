import { createFileRoute } from "@tanstack/react-router";
import { NotFoundPage } from "@/components/status-pages";

// Catches every signed-in address that matches no screen, so the 404 keeps the shell and its navigation.
export const Route = createFileRoute("/_app/$")({
  staticData: { pageTitle: "Page not found" },
  component: NotFoundPage,
});
