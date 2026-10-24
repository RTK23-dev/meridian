import { createFileRoute } from "@tanstack/react-router";
import { ProductPage } from "@/components/public/public-pages";

/** The public product page. It sits outside the signed-in layout, so anyone can read it without an account. */
export const Route = createFileRoute("/product")({
  head: () => ({ meta: [{ title: "Product · Meridian" }] }),
  component: ProductPage,
});
