import { createFileRoute } from "@tanstack/react-router";
import { signInOptions } from "@/lib/auth/server";

/** Which optional sign-in providers this deployment has configured. It carries no secret. */
export const Route = createFileRoute("/api/sign-in-options")({
  server: {
    handlers: {
      GET: async () => Response.json(signInOptions()),
    },
  },
});
