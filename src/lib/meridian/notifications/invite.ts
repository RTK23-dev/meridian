import { createHash, randomBytes } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import { realEmailProvider, testEmailProvider, type EmailProvider } from "./email.ts";

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

export function inviteEmail(input: { email: string; token: string; origin: string; workspace: string }): { to: string; subject: string; text: string } {
  const link = `${input.origin.replace(/\/$/, "")}/invite?token=${encodeURIComponent(input.token)}`;
  return {
    to: input.email,
    subject: `Invitation to ${input.workspace || "a Meridian workspace"}`,
    text: `You were invited to ${input.workspace || "a Meridian workspace"}. Open this one-time link: ${link} It expires in 7 days.`,
  };
}

export function selectEmailProvider(options?: { allowTest?: boolean; sent?: { to: string; subject: string; text: string }[] }): EmailProvider {
  if (options?.allowTest) return testEmailProvider(options.sent);
  return realEmailProvider();
}

const RESEND_MS = 60_000;

export async function createInvitation(
  sql: Sql,
  input: {
    id: string;
    organizationId: string;
    email: string;
    role: string;
    createdBy: string;
    workspaceName: string;
    origin: string;
    provider: EmailProvider;
    now?: number;
  },
): Promise<{ status: "sent" | "pending"; message: string }> {
  const token = newInviteToken();
  const tokenHash = hashInviteToken(token);
  const expires = new Date((input.now ?? Date.now()) + 7 * 24 * 60 * 60 * 1000).toISOString();
  await sql`
    insert into invites (id, organization_id, email, role, status, created_by, token_hash, expires_at, send_count)
    values (
      ${input.id}, ${input.organizationId}, ${input.email}, ${input.role}, 'pending', ${input.createdBy},
      ${tokenHash}, ${expires}, 0
    )
  `;
  return deliver(sql, { ...input, token });
}

async function deliver(
  sql: Sql,
  input: {
    id: string;
    organizationId: string;
    email: string;
    workspaceName: string;
    origin: string;
    provider: EmailProvider;
    token: string;
  },
): Promise<{ status: "sent" | "pending"; message: string }> {
  const message = inviteEmail({
    email: input.email,
    token: input.token,
    origin: input.origin,
    workspace: input.workspaceName,
  });
  const result = await input.provider.send(message);
  if (result.status === "sent") {
    await sql`
      update invites set status = 'sent', sent_at = now(), send_count = send_count + 1, last_error = ''
      where id = ${input.id} and organization_id = ${input.organizationId}
    `;
    return { status: "sent", message: "Invitation email sent." };
  }
  await sql`
    update invites set status = 'pending', last_error = ${result.error}
    where id = ${input.id} and organization_id = ${input.organizationId}
  `;
  return {
    status: "pending",
    message: result.status === "NOT_CONFIGURED"
      ? "Invitation stored. Email delivery is not configured, so nobody was notified."
      : "Invitation stored. The email provider failed, so nobody was notified.",
  };
}

export async function resendInvitation(
  sql: Sql,
  input: {
    id: string;
    organizationId: string;
    workspaceName: string;
    origin: string;
    provider: EmailProvider;
    now?: number;
  },
): Promise<{ status: "sent" | "pending" | "limited"; message: string }> {
  const rows = await sql<{ email: string; status: string; sent_at: string | null; send_count: number }>`
    select email, status, sent_at, send_count from invites
    where id = ${input.id} and organization_id = ${input.organizationId}
    limit 1
  `;
  const row = rows[0];
  if (!row || row.status === "accepted") throw new Error("Invitation not found.");
  const sentAt = row.sent_at ? Date.parse(row.sent_at) : 0;
  if (sentAt && (input.now ?? Date.now()) - sentAt < RESEND_MS) {
    return { status: "limited", message: "Wait a minute before sending this invitation again." };
  }
  const token = newInviteToken();
  const tokenHash = hashInviteToken(token);
  const expires = new Date((input.now ?? Date.now()) + 7 * 24 * 60 * 60 * 1000).toISOString();
  await sql`
    update invites set token_hash = ${tokenHash}, expires_at = ${expires}, status = 'pending'
    where id = ${input.id} and organization_id = ${input.organizationId}
  `;
  const sent = await deliver(sql, { ...input, email: row.email, token });
  return sent;
}

export async function acceptInvitation(
  sql: Sql,
  input: { token: string; userId: string; userEmail: string; now?: number },
): Promise<{ organizationId: string }> {
  const tokenHash = hashInviteToken(input.token);
  const rows = await sql<{ id: string; organization_id: string; email: string; role: string; status: string; expires_at: string | null }>`
    select id, organization_id, email, role, status, expires_at from invites
    where token_hash = ${tokenHash}
    limit 1
  `;
  const invite = rows[0];
  if (!invite) throw new Error("Invitation is invalid.");
  if (invite.status === "accepted") throw new Error("Invitation was already used.");
  if (invite.expires_at && Date.parse(invite.expires_at) <= (input.now ?? Date.now())) {
    await sql`update invites set status = 'expired', token_hash = '' where id = ${invite.id}`;
    throw new Error("Invitation has expired.");
  }
  if (invite.email.toLowerCase() !== input.userEmail.toLowerCase()) {
    throw new Error("This invitation was sent to a different email.");
  }
  const existing = await sql<{ id: string }>`
    select id from memberships where organization_id = ${invite.organization_id} and user_id = ${input.userId} limit 1
  `;
  if (!existing[0]) {
    await sql`
      insert into memberships (id, organization_id, user_id, role)
      values (${`${invite.id}:member`}, ${invite.organization_id}, ${input.userId}, ${invite.role})
    `;
  }
  await sql`
    update invites set status = 'accepted', token_hash = ''
    where id = ${invite.id} and token_hash = ${tokenHash}
  `;
  return { organizationId: invite.organization_id };
}
