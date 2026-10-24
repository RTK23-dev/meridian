import { createFileRoute } from "@tanstack/react-router";
import { QuickstartPage } from "@/components/public/public-pages";

/** The public quickstart: the first run, from a clone to the first reviewed creative. */
export const Route = createFileRoute("/quickstart")({
  head: () => ({ meta: [{ title: "Quickstart · Meridian" }] }),
  component: QuickstartPage,
});
