/**
 * Client rules for forms whose server check is plain code, not a zod schema. Where the server's own pure helper can be
 * imported into the browser bundle, it is used directly, so the rule cannot drift. Otherwise the rule is repeated here with
 * the server's limits and messages, and the server validator it repeats is named beside it.
 */
import { z } from "zod";
import { deliveryUrlAllowed } from "@/lib/meridian/alerts/lifecycle";

/** saveDeliveryTarget: the URL is trimmed. A blank URL clears the target. Anything else must pass deliveryUrlAllowed. */
export const deliveryTargetSchema = z.object({
  url: z.string().trim().refine(
    (value) => value === "" || deliveryUrlAllowed(value),
    "A delivery target must be https, or http on localhost. Nothing was saved.",
  ),
});

export type DeliveryTargetInput = z.input<typeof deliveryTargetSchema>;

/** auditFilterInput: a date must be YYYY-MM-DD, or it is ignored. Actor and action are trimmed and cut at 100 characters. */
const filterDate = z.string().refine(
  (value) => value === "" || /^\d{4}-\d{2}-\d{2}$/.test(value),
  "Use a date like 2026-01-31.",
);

export const auditFilterSchema = z.object({
  actor: z.string().trim().max(100, "Use 100 characters or fewer."),
  action: z.string().trim().max(100, "Use 100 characters or fewer."),
  brandId: z.string().trim(),
  from: filterDate,
  to: filterDate,
});

export type AuditFilterInput = z.input<typeof auditFilterSchema>;

/** listWebhookEvents: the provider is trimmed and cut at 80 characters. */
export const webhookFilterSchema = z.object({
  provider: z.string().trim().max(80, "Use 80 characters or fewer."),
});

export type WebhookFilterInput = z.input<typeof webhookFilterSchema>;
