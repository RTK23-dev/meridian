export type StoredExternalId = {
  organizationId: string;
  idempotencyKey: string;
  externalId: string;
};

/** A blank id is not confirmation. Another workspace's id cannot be reused. */
export function reusableExternalId(rows: StoredExternalId[], organizationId: string, idempotencyKey: string): string | null {
  const row = rows.find((item) => item.idempotencyKey === idempotencyKey && item.externalId.trim());
  if (!row) return null;
  if (row.organizationId !== organizationId) throw new Error("That external id belongs to another workspace.");
  return row.externalId;
}

export function confirmedExternalId(status: string, externalId: string | null | undefined): string | null {
  if (status !== "stored") return null;
  const id = externalId?.trim() ?? "";
  return id || null;
}
