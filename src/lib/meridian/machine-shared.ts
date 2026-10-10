import { type Sql } from "@/lib/db";
import { loadBrandContext } from "@/lib/meridian/context/load";
import { PROMPTS } from "@/lib/meridian/prompts/registry";
import { relationshipEdges } from "@/lib/meridian/knowledge/relations";
import { notificationFor } from "@/lib/meridian/notifications/events";

export function id(): string {
  return crypto.randomUUID();
}

export function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

export function asNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function asJson<T>(value: unknown, fallback: T): T {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  if (value && typeof value === "object") return value as T;
  return fallback;
}

export function storedAnswer(value: unknown): string {
  const parsed = asJson<{ value?: unknown }>(value, {});
  return typeof parsed.value === "string" ? parsed.value : "";
}

export function clip(value: unknown, max: number, label: string, required = false): string {
  if (typeof value !== "string") {
    if (!required && (value === undefined || value === null)) return "";
    throw new Error(`${label} must be text.`);
  }
  const trimmed = value.trim();
  if (required && !trimmed) throw new Error(`${label} is required.`);
  if (trimmed.length > max) throw new Error(`${label} is too long.`);
  return trimmed;
}

export function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid request.");
  return input as Record<string, unknown>;
}

export function fingerprint(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) hash = (hash * 33) ^ value.charCodeAt(index);
  return (hash >>> 0).toString(16);
}

export { requireBrand } from "@/lib/meridian/brand-membership";

export async function audit(
  sql: Sql,
  entry: {
    organizationId: string;
    brandId?: string | null;
    actorId: string;
    action: string;
    objectType: string;
    objectId: string;
    metadata?: Record<string, string>;
  },
): Promise<void> {
  await sql`
    insert into audit_log (id, organization_id, brand_id, actor_id, action, object_type, object_id, metadata)
    values (
      ${id()}, ${entry.organizationId}, ${entry.brandId ?? null}, ${entry.actorId},
      ${entry.action}, ${entry.objectType}, ${entry.objectId}, ${JSON.stringify(entry.metadata ?? {})}
    )
  `;
}

export async function loadContext(sql: Sql, organizationId: string, brandId: string) {
  return loadBrandContext(sql, organizationId, brandId);
}

export async function insertDecision(
  sql: Sql,
  entry: {
    id: string;
    organizationId: string;
    brandId: string;
    correlationId: string;
    questionId: string;
    questionVersion: string;
    subjectType: string;
    subjectId: string;
    input: unknown;
    evidence: unknown;
    probability: number;
    confidence: number;
    thresholds: unknown;
    decision: string;
    reasons: string[];
    provider?: string;
    model?: string;
    modelResponse?: string;
    answer?: unknown;
    schemaVersion?: string;
    policyVersion?: string;
    calibrationVersion?: string | null;
  },
): Promise<void> {
  await sql`
    insert into jev_decisions (
      id, organization_id, brand_id, correlation_id, question_id, question_version,
      subject_type, subject_id, input, evidence, probability, confidence, thresholds,
      decision, reasons, provider, model, model_response,
      answer, schema_version, policy_version, calibration_version
    ) values (
      ${entry.id}, ${entry.organizationId}, ${entry.brandId}, ${entry.correlationId},
      ${entry.questionId}, ${entry.questionVersion}, ${entry.subjectType}, ${entry.subjectId},
      ${JSON.stringify(entry.input)}, ${JSON.stringify(entry.evidence)},
      ${entry.probability}, ${entry.confidence}, ${JSON.stringify(entry.thresholds)},
      ${entry.decision}, ${JSON.stringify(entry.reasons)},
      ${entry.provider ?? ""}, ${entry.model ?? ""}, ${(entry.modelResponse ?? "").slice(0, 8000)},
      ${JSON.stringify(entry.answer ?? {})}, ${entry.schemaVersion ?? ""}, ${entry.policyVersion ?? ""}, ${entry.calibrationVersion ?? ""}
    )
  `;
}

export async function ensurePromptRows(sql: Sql): Promise<void> {
  for (const prompt of PROMPTS) {
    await sql`
      insert into prompt_versions (
        id, prompt_id, version, purpose, model, temperature, status, input_schema, output_schema
      ) values (
        ${`${prompt.id}:${prompt.version}`}, ${prompt.id}, ${prompt.version}, ${prompt.purpose},
        ${prompt.model}, ${prompt.temperature}, ${prompt.status}, ${prompt.inputSchema}, ${prompt.outputSchema}
      )
      on conflict (prompt_id, version) do nothing
    `;
  }
}

export async function writeRelationships(
  sql: Sql,
  organizationId: string,
  brandId: string,
  creativeId: string,
  creative: { angle: string; hookType: string; format: string; proofType: string; productName: string },
): Promise<void> {
  for (const edge of relationshipEdges(creative)) {
    await sql`
      insert into creative_relationships (id, organization_id, brand_id, creative_id, relation, value)
      values (${id()}, ${organizationId}, ${brandId}, ${creativeId}, ${edge.relation}, ${edge.value})
    `;
  }
}

export async function notify(
  sql: Sql,
  organizationId: string,
  brandId: string,
  kind: "learning.update" | "performance.recorded" | "review.required" | "integration.unavailable",
  detail: string,
): Promise<void> {
  const note = notificationFor(kind, detail);
  await sql`
    insert into notifications (id, organization_id, brand_id, kind, title, body)
    values (${id()}, ${organizationId}, ${brandId}, ${note.kind}, ${note.title}, ${note.body})
  `;
}

export function attributeToken(value: unknown, label: string): string {
  const raw = clip(value, 48, label, false).toLowerCase();
  return raw.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}

export function angleOrThrow(value: unknown): string {
  const angle = attributeToken(value, "Angle") || clip(value, 40, "Angle", false).trim().toLowerCase();
  if (angle.length < 2) throw new Error("Name the angle you observed.");
  return angle;
}
