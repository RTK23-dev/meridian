/**
 * Client rules for forms whose server check is plain code, not a zod schema. Where the server's own pure helper can be
 * imported into the browser bundle, it is used directly, so the rule cannot drift. Otherwise the rule is repeated here with
 * the server's limits and messages, and the server validator it repeats is named beside it.
 */
import { z } from "zod";
// Relative, not @/, so the schemas also load under plain Node for the tests.
import { deliveryUrlAllowed } from "../../lib/meridian/alerts/lifecycle.ts";

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

/**
 * connectPlatformAccountAction: the display name and the account ID are required. Each text field is trimmed and cut at 120
 * characters. The token is trimmed and sent only when present.
 */
export const connectAccountSchema = z.object({
  platform: z.string().min(1, "Choose a platform."),
  name: z.string().trim().min(1, "Enter the account display name.").max(120, "Use 120 characters or fewer."),
  handle: z.string().trim().max(120, "Use 120 characters or fewer."),
  externalAccountId: z.string().trim().min(1, "Enter the account ID.").max(120, "Use 120 characters or fewer."),
  token: z.string().trim(),
});

export type ConnectAccountInput = z.input<typeof connectAccountSchema>;

/**
 * Cost modes. The server reads them from production/cost-mode.ts, which also imports the vault and database code, so that
 * module cannot be bundled for the browser. The list is repeated here and must match COST_MODES there.
 */
export const CLIENT_COST_MODES = ["ZERO_SPEND", "LOWEST_COST", "BALANCED", "QUALITY_FIRST"] as const;

/**
 * The provider panel's fields. Each category that takes a key has its own key field, so a key typed for one category is
 * never the value another category saves. saveProviderConfig stores each category's settings as they are sent, with one
 * exception: the production cost mode must be a known mode. The page limit is read with Number(), so a blank or
 * non-numeric page limit is refused here instead of being stored as 0 or NaN. Each key is trimmed; a missing key is
 * answered by the server, which knows whether one is already stored.
 */
export const providerFieldsSchema = z.object({
  jevKey: z.string().trim(),
  productionKey: z.string().trim(),
  perceptionKey: z.string().trim(),
  costPreference: z.enum(CLIENT_COST_MODES, { error: "Choose a cost mode: ZERO_SPEND, LOWEST_COST, BALANCED or QUALITY_FIRST." }),
  gatewayUrl: z.string().trim(),
  maxPages: z.string().trim().refine(
    (value) => value !== "" && Number.isFinite(Number(value)),
    "Enter the number of pages, as a number.",
  ),
});

export type ProviderFieldsInput = z.input<typeof providerFieldsSchema>;

/**
 * scheduleMultiAccountPublishAction: a creative and at least one destination account are required. The scheduled time is
 * optional, and when it is given it must be a real date and time, because the client converts it before sending.
 */
export const queueScheduleSchema = z.object({
  creativeId: z.string().min(1, "Select a creative variant."),
  targetType: z.enum(["organic", "paid_campaign"]),
  targetAccountIds: z.array(z.string()).min(1, "Select at least one destination account."),
  scheduledTime: z.string().refine(
    (value) => value === "" || !Number.isNaN(new Date(value).getTime()),
    "Enter a valid date and time, or leave the field blank to publish now.",
  ),
});

export type QueueScheduleInput = z.input<typeof queueScheduleSchema>;
