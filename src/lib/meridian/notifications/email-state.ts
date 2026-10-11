/**
 * Whether email delivery is configured, read from the same variables the email provider reads (EMAIL_API_URL and
 * EMAIL_API_KEY). Nothing is sent here, and only the state is returned: the values never leave the server.
 */

export function emailDeliveryState(env: { url?: string; key?: string }): {
  status: "CONFIGURED" | "NOT_CONFIGURED";
  detail: string;
} {
  if (!env.url?.trim() || !env.key?.trim()) {
    return {
      status: "NOT_CONFIGURED",
      detail: "Email delivery is not configured. Invitations are stored, but nobody is emailed until EMAIL_API_URL and EMAIL_API_KEY are set.",
    };
  }
  return {
    status: "CONFIGURED",
    detail: "EMAIL_API_URL and EMAIL_API_KEY are set. Delivery is recorded only when the provider accepts a message.",
  };
}

/** An ISO time string for a stored timestamp, or null when the value is missing or cannot be read. */
export function isoOrNull(value: unknown): string | null {
  if (value == null || value === "") return null;
  const time = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
