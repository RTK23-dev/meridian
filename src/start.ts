import { createMiddleware, createStart } from "@tanstack/react-start";

/**
 * Who may show Meridian in a frame. Every page and server response gets the `frame-ancestors` rule, so another site cannot embed
 * Meridian unless MERIDIAN_FRAME_ANCESTORS names it (see `lib/security/frame-ancestors.server.ts`).
 */
const frameRule = createMiddleware({ type: "request" }).server(async ({ next }) => {
  const result = await next();
  const { frameAncestors } = await import("@/lib/security/frame-ancestors.server");
  result.response.headers.set("Content-Security-Policy", frameAncestors);
  return result;
});

export const startInstance = createStart(() => ({
  requestMiddleware: [frameRule],
}));
