// The Settings page's server functions for connector links. The admin role is checked in the store (connectors.ts) before anything is read
// or written; the secret comes back once, from create, and is never read again.

import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { asText, objectInput } from "../api-shared";
import { CONNECTOR_NAME_MAX, createConnector, listConnectors, revokeConnector } from "./connectors.ts";

function organizationOf(input: unknown): { organizationId: string; body: Record<string, unknown> } {
  const body = objectInput(input);
  const organizationId = asText(body.organizationId);
  if (!organizationId) throw new Error("organizationId is required.");
  return { organizationId, body };
}

/** The workspace's connector links, without their secrets. Admin only. */
export const listMcpConnectors = createServerFn({ method: "GET" })
  .validator((input: unknown) => ({ organizationId: organizationOf(input).organizationId }))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => listConnectors(await getSql(), { organizationId: data.organizationId, userId: context.userId }));

/** Makes a link. The answer carries the secret this once. Admin only. */
export const createMcpConnector = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const { organizationId, body } = organizationOf(input);
    return { organizationId, name: asText(body.name).slice(0, CONNECTOR_NAME_MAX) };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => createConnector(await getSql(), { organizationId: data.organizationId, userId: context.userId, name: data.name }));

/** Revokes a link of the workspace. Admin only. */
export const revokeMcpConnector = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const { organizationId, body } = organizationOf(input);
    const connectorId = asText(body.connectorId);
    if (!connectorId) throw new Error("connectorId is required.");
    return { organizationId, connectorId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => revokeConnector(await getSql(), { organizationId: data.organizationId, userId: context.userId, connectorId: data.connectorId }));
