import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle,
  Badge, Button, Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DataTable, Field, SelectInput, TextInput, errorText,
} from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { ROLES } from "@/lib/meridian/access";
import { addMember, changeMemberRole, type InviteRow, type MemberRow } from "@/lib/meridian/api";
import { memberInviteSchema, type MemberInviteInput } from "@/lib/meridian/schemas/settings";
import { usePendingVariables, useScopedMutation } from "@/lib/query/hooks";
import { FormError } from "./form-error";
import { plainServerError } from "./form-model";

const ROLE_KEY = (organizationId: string) => ["mutation", "workspace.role", organizationId] as const;

/** Roles can be changed inline by an admin. Removing a member asks first, in a dialog that names the person. */
export function MembersTab({ organizationId, members, invites, canAdmin }: {
  organizationId: string;
  members: MemberRow[];
  invites: InviteRow[];
  canAdmin: boolean;
}) {
  const { reload } = useWorkspace();
  const [note, setNote] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<MemberRow | null>(null);
  const changing = usePendingVariables<{ userId: string; role: string }>(ROLE_KEY(organizationId)).map((vars) => vars.userId);

  const changeRole = useScopedMutation({
    mutationKey: ROLE_KEY(organizationId),
    mutationFn: (vars: { userId: string; role: string }) => changeMemberRole({ data: { organizationId, userId: vars.userId, role: vars.role } }),
    success: (vars) => vars.role === "remove" ? "Member removed." : "Member role updated.",
    onSuccess: async () => { await reload(); },
  });
  const roleError = changeRole.error ? errorText(changeRole.error) : null;

  const columns = useMemo<ColumnDef<MemberRow, unknown>[]>(() => [
    {
      accessorKey: "name",
      header: "Member",
      cell: ({ row }) => (
        <div className="min-w-0">
          <p className="font-semibold text-fg">{row.original.name}</p>
          <p className="truncate text-sm text-fg-muted">{row.original.email}</p>
        </div>
      ),
    },
    {
      id: "role",
      header: "Role",
      enableSorting: false,
      cell: ({ row }) => canAdmin ? (
        <SelectInput
          aria-label={`Role for ${row.original.name}`}
          className="min-h-11 w-auto py-2"
          value={row.original.role}
          disabled={changing.includes(row.original.userId)}
          onChange={(event) => { void changeRole.mutateAsync({ userId: row.original.userId, role: event.target.value }).catch(() => undefined); }}
        >
          {ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
        </SelectInput>
      ) : <Badge variant="neutral">{row.original.role}</Badge>,
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      cell: ({ row }) => canAdmin ? (
        <Button type="button" variant="quiet" size="md" className="min-h-11" onClick={() => setPendingRemoval(row.original)}>
          Remove<span className="sr-only"> {row.original.name}</span>
        </Button>
      ) : null,
    },
  ], [canAdmin, changing, changeRole]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-fg-muted">
          Owners and admins manage people. Viewers can read the workspace. The server keeps at least one owner.
        </p>
        {canAdmin ? <Button type="button" onClick={() => setInviteOpen(true)}>Invite member</Button> : null}
      </div>

      {note ? <p role="status" className="text-sm text-fg">{note}</p> : null}
      {roleError ? <FormError message={plainServerError(roleError, "settings")} raw={roleError} /> : null}

      <DataTable
        data={members}
        columns={columns}
        getRowId={(row) => row.userId}
        emptyTitle="No members yet"
        emptyReason="Invite someone who already has an account, or send an invitation."
      />

      {invites.length > 0 ? (
        <section aria-labelledby="invites-title" className="space-y-2">
          <h3 id="invites-title" className="text-sm font-semibold text-fg">Pending invitations</h3>
          <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
            {invites.map((invite) => (
              <li key={invite.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                <span className="min-w-0 break-all text-fg">{invite.email}</span>
                <span className="flex flex-wrap gap-2 text-fg-muted">
                  <span>{invite.role}</span>
                  <Badge variant="info">{invite.status}</Badge>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <InviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        organizationId={organizationId}
        onInvited={(message) => { setNote(message); }}
      />

      <AlertDialog open={pendingRemoval !== null} onOpenChange={(open) => { if (!open) setPendingRemoval(null); }}>
        <AlertDialogContent>
          <AlertDialogTitle>Remove {pendingRemoval?.name ?? "this member"}?</AlertDialogTitle>
          <AlertDialogDescription>They lose access to this workspace. Their past actions stay in the audit trail.</AlertDialogDescription>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <AlertDialogCancel asChild>
              <Button type="button" variant="secondary">Cancel</Button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button
                type="button"
                variant="danger"
                onClick={(event) => {
                  event.preventDefault();
                  if (!pendingRemoval) return;
                  const removed = pendingRemoval;
                  void changeRole.mutateAsync({ userId: removed.userId, role: "remove" })
                    .then(() => setPendingRemoval(null))
                    .catch(() => undefined);
                }}
              >
                Remove member
              </Button>
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function InviteDialog({ open, onOpenChange, organizationId, onInvited }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  onInvited: (message: string) => void;
}) {
  const { reload } = useWorkspace();
  const form = useForm<MemberInviteInput>({ resolver: zodResolver(memberInviteSchema), defaultValues: { email: "", role: "member" }, mode: "onBlur" });
  const invite = useScopedMutation({
    mutationKey: ["mutation", "workspace.invite", organizationId],
    mutationFn: (values: MemberInviteInput) => addMember({ data: { organizationId, ...values } }),
    onSuccess: async (result) => {
      onInvited(result.message);
      await reload();
      form.reset({ email: "", role: "member" });
      onOpenChange(false);
    },
  });
  const rawError = invite.error ? errorText(invite.error) : null;

  return (
    <Dialog open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) { form.reset({ email: "", role: "member" }); invite.reset(); } }}>
      <DialogContent>
        <DialogTitle className="font-display text-2xl">Invite a member</DialogTitle>
        <DialogDescription className="mt-2 text-sm text-fg-muted">
          If the person already has an account, they are added now. Otherwise an invitation is recorded for them.
        </DialogDescription>
        <form className="mt-4 space-y-4" onSubmit={form.handleSubmit((values) => { void invite.mutateAsync(values).catch(() => undefined); })} noValidate>
          <Field label="Email" error={form.formState.errors.email?.message} required>
            <TextInput {...form.register("email")} type="email" autoComplete="email" maxLength={200} required />
          </Field>
          <Field label="Role" error={form.formState.errors.role?.message} required>
            <SelectInput {...form.register("role")}>
              <option value="admin">admin</option>
              <option value="member">member</option>
              <option value="viewer">viewer</option>
            </SelectInput>
          </Field>
          {rawError ? <FormError message={plainServerError(rawError, "invite")} raw={rawError} /> : null}
          <div className="flex flex-wrap justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="secondary">Cancel</Button>
            </DialogClose>
            <Button type="submit" disabled={invite.isPending || form.formState.isSubmitting}>
              {invite.isPending ? "Sending…" : "Invite"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
