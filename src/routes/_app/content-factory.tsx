import { createFileRoute } from "@tanstack/react-router";
import { ContentFactoryScreen } from "@/components/content-factory/screen";

export const Route = createFileRoute("/_app/content-factory")({ staticData: { pageTitle: "Content Factory" }, component: ContentFactoryScreen });
