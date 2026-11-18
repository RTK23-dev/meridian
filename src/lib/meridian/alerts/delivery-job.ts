/**
 * The alert.deliver job: sends one stored alert to the workspace's webhook, at most once per attempt.
 *
 * 1. The alert's earlier attempts decide the plan (lifecycle.ts). A 'sent' or 'uncertain' attempt ends delivery; a 'sending' one is in
 *    flight or was cut off, so it is not sent again either.
 * 2. The alert is read in the job's own workspace. An alert of another workspace is never read, claimed or sent.
 * 3. The attempt is claimed as 'sending' BEFORE the request. Its id is "<alert id>:<attempt>", so two jobs that race for the same attempt
 *    insert the same key and only one sends. The webhook receives the same value as its Idempotency-Key.
 * 4. The answer settles the attempt: 2xx 'sent'; 4xx 'failed' (the job throws, so the queue retries it until the limit, then 'dead');
 *    no answer or 5xx 'uncertain' (the job ends, and nothing is re-sent until a person has checked the receiving system).
 */
import type { Sql } from "../learning/store.ts";
import type { Transport } from "../providers/http.ts";
import { deliverAlert } from "./deliver.ts";
import { deliveryPlan, deliveryUrlAllowed } from "./lifecycle.ts";

export type AlertDeliveryInput = { organizationId: string; alertId: string; targetUrl: string };

export async function runAlertDelivery(sql: Sql, input: AlertDeliveryInput, transport: Transport): Promise<string> {
  const { organizationId, alertId, targetUrl } = input;
  if (!alertId) throw new Error("Alert delivery has no alert id.");
  const target = targetUrl && deliveryUrlAllowed(targetUrl) ? { kind: "webhook" as const, url: targetUrl } : { kind: "none" as const };
  const rows = await sql<{ id: string; code: string; severity: string; detail: string }>`
    select id, code, severity, detail from alert_events where id = ${alertId} and organization_id = ${organizationId} limit 1
  `;
  const row = rows[0];
  if (!row) return "missing";
  const prior = await sql<{ status: string }>`
    select status from delivery_attempts where alert_id = ${alertId} and organization_id = ${organizationId}
  `;
  const plan = deliveryPlan(prior, target);
  if (plan.action !== "send" || target.kind !== "webhook") {
    // A 'sending' attempt belongs to another delivery, which records its own outcome.
    if (plan.status !== "sending") {
      await sql`update alert_events set delivery_status = ${plan.status} where id = ${alertId} and organization_id = ${organizationId}`;
    }
    return plan.status;
  }

  const attemptId = `${alertId}:${prior.length + 1}`;
  const claimed = await sql<{ id: string }>`
    insert into delivery_attempts (id, organization_id, alert_id, status, detail)
    values (${attemptId}, ${organizationId}, ${alertId}, 'sending', '')
    on conflict (id) do nothing
    returning id
  `;
  if (!claimed[0]) return "sending";
  await sql`update alert_events set delivery_status = 'sending' where id = ${alertId} and organization_id = ${organizationId}`;

  const result = await deliverAlert(
    {
      id: row.id,
      organizationId,
      code: row.code,
      severity: row.severity === "critical" || row.severity === "info" ? row.severity : "warning",
      detail: row.detail,
      firstSeen: "",
      lastSeen: "",
      acknowledged: false,
    },
    target,
    transport,
    { idempotencyKey: attemptId },
  );
  const status = result.status === "sent" || result.status === "uncertain" ? result.status : "failed";
  await sql`
    update delivery_attempts set status = ${status}, detail = ${result.error.slice(0, 300)}
    where id = ${attemptId} and organization_id = ${organizationId}
  `;
  if (status === "failed") {
    const again = deliveryPlan([...prior, { status: "failed" }], target);
    await sql`
      update alert_events set delivery_status = ${again.action === "dead" ? "dead" : "failed"}
      where id = ${alertId} and organization_id = ${organizationId}
    `;
    if (again.action === "dead") return "dead";
    throw new Error(result.error || "The delivery target did not accept the alert.");
  }
  await sql`update alert_events set delivery_status = ${status} where id = ${alertId} and organization_id = ${organizationId}`;
  return status;
}
