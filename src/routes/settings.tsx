import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useBusy } from "@/components/gate";
import { AuditList } from "@/components/audit";
import { AlertsPanel } from "@/components/alerts-panel";
import { Button, Field, Notice, Panel, SelectInput, TextInput } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { hasRole, ROLES } from "@/lib/meridian/access";
import { addMember, changeMemberRole, createOrganization, renameOrganization, updateWeights } from "@/lib/meridian/api";
import { WEIGHT_KEYS, type ScoreWeights } from "@/lib/meridian/scoring";
import { memberInviteSchema, scoringWeightsSchema, workspaceNameSchema, type MemberInviteInput, type ScoringWeightsInput, type WorkspaceNameInput } from "@/lib/meridian/schemas/settings";
import { ProviderSettingsPanel } from "@/components/provider-settings-panel";

export const Route = createFileRoute("/settings")({ component: SettingsPage });

const LABELS: Record<keyof ScoreWeights, string> = {
  brandFit: "Brand fit",
  historicalEvidence: "Historical evidence",
  marketSignal: "Market signal",
  novelty: "Novelty",
  reproducibility: "Reproducibility",
  saturation: "Saturation (penalty)",
  risk: "Risk (penalty)",
};

function SettingsPage() {
  return (
    <Settings />
  );
}

function Settings() {
  const { data, reload } = useWorkspace();
  const activeWorkspace = data?.active;
  const { pending, error, run } = useBusy();
  const [message, setMessage] = useState<string | null>(null);
  const renameForm = useForm<WorkspaceNameInput>({ resolver: zodResolver(workspaceNameSchema), defaultValues: { name: "" }, mode: "onBlur" });
  const inviteForm = useForm<MemberInviteInput>({ resolver: zodResolver(memberInviteSchema), defaultValues: { email: "", role: "member" }, mode: "onBlur" });
  const weightsForm = useForm<ScoringWeightsInput, unknown, ScoreWeights>({ resolver: zodResolver(scoringWeightsSchema), defaultValues: { brandFit: "", historicalEvidence: "", marketSignal: "", novelty: "", reproducibility: "", saturation: "", risk: "" }, mode: "onBlur" });
  const createForm = useForm<WorkspaceNameInput>({ resolver: zodResolver(workspaceNameSchema), defaultValues: { name: "" }, mode: "onBlur" });
  const hasUnsavedChanges = renameForm.formState.isDirty || inviteForm.formState.isDirty || weightsForm.formState.isDirty || createForm.formState.isDirty;
  useEffect(() => {
    if (!activeWorkspace) return;
    if (!renameForm.formState.isDirty) renameForm.reset({ name: activeWorkspace.name });
    if (!weightsForm.formState.isDirty) weightsForm.reset(Object.fromEntries(WEIGHT_KEYS.map((key) => [key, String(activeWorkspace.weights[key])])) as ScoringWeightsInput);
  }, [activeWorkspace, renameForm, weightsForm]);
  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const warnBeforeLeave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warnBeforeLeave);
    return () => window.removeEventListener("beforeunload", warnBeforeLeave);
  }, [hasUnsavedChanges]);
  if (!activeWorkspace) return <p className="text-muted">Create a workspace first.</p>;
  const active = activeWorkspace;
  const canAdmin = hasRole(active.role, "admin");

  async function rename(values: WorkspaceNameInput) {
    const saved = await run(async () => {
      await renameOrganization({ data: { organizationId: active.id, ...values } });
      setMessage("Workspace renamed.");
      await reload();
    });
    if (saved) renameForm.reset(values);
  }

  async function invite(values: MemberInviteInput) {
    const saved = await run(async () => {
      const result = await addMember({ data: { organizationId: active.id, ...values } });
      setMessage(result.message);
      await reload();
    });
    if (saved) inviteForm.reset({ email: "", role: "member" });
  }

  async function saveWeights(values: ScoreWeights) {
    const saved = await run(async () => {
      await updateWeights({ data: { organizationId: active.id, weights: values } });
      setMessage("Diagnostic weights saved. They do not create opportunities.");
      await reload();
    });
    if (saved) weightsForm.reset(Object.fromEntries(WEIGHT_KEYS.map((key) => [key, String(values[key])])) as ScoringWeightsInput);
  }

  async function createWorkspace(values: WorkspaceNameInput) {
    const saved = await run(async () => {
      await createOrganization({ data: values });
      setMessage("Workspace created and selected.");
      await reload();
    });
    if (saved) createForm.reset();
  }

  return (
    <div className="space-y-8">
      <div>
        <p className="text-sm font-semibold uppercase tracking-widest text-brass">Workspace</p>
        <h1 className="font-display text-4xl">{active.name}</h1>
        <p className="text-muted">You are {active.role}. Permission checks run on the server, not only in this screen.</p>
      </div>
      {error ? <Notice>{error}</Notice> : null}
      {message ? <p className="text-sm" role="status">{message}</p> : null}
      <Panel>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={renameForm.handleSubmit(rename)}
        >
          <Field label="Name" error={renameForm.formState.errors.name?.message} required>
            <TextInput {...renameForm.register("name")} maxLength={80} disabled={!canAdmin} required />
          </Field>
          {renameForm.formState.isDirty ? <Button type="button" variant="quiet" onClick={() => renameForm.reset({ name: active.name })}>Discard</Button> : null}
          {canAdmin ? <Button type="submit" disabled={pending || renameForm.formState.isSubmitting}>Rename</Button> : null}
        </form>
      </Panel>
      <ProviderSettingsPanel organizationId={active.id} canAdmin={canAdmin} />
      <Panel>
        <h2 className="font-display text-2xl">People</h2>
        <ul className="mt-4 divide-y divide-line">
          {data.members.map((member) => (
            <li key={member.userId} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div>
                <p className="font-semibold">{member.name}</p>
                <p className="text-sm text-muted">{member.email}</p>
              </div>
              {canAdmin ? (
                <SelectInput
                  aria-label={`Role for ${member.name}`}
                  className="w-auto"
                  value={member.role}
                  onChange={(event) => {
                    const role = event.target.value;
                    void run(async () => {
                      await changeMemberRole({
                        data: { organizationId: active.id, userId: member.userId, role },
                      });
                      await reload();
                    });
                  }}
                >
                  {ROLES.map((role) => (
                    <option key={role} value={role}>{role}</option>
                  ))}
                  <option value="remove">remove</option>
                </SelectInput>
              ) : (
                <span className="text-sm uppercase text-muted">{member.role}</span>
              )}
            </li>
          ))}
        </ul>
        {canAdmin ? (
          <form
            className="mt-4 grid gap-3 md:grid-cols-[1fr_10rem_auto]"
            onSubmit={inviteForm.handleSubmit(invite)}
          >
            <Field label="Email" error={inviteForm.formState.errors.email?.message} required><TextInput {...inviteForm.register("email")} type="email" required maxLength={200} placeholder="Email" /></Field>
            <Field label="Role" error={inviteForm.formState.errors.role?.message} required><SelectInput {...inviteForm.register("role")} aria-label="Role">
              <option value="admin">admin</option>
              <option value="member">member</option>
              <option value="viewer">viewer</option>
            </SelectInput></Field>
            {inviteForm.formState.isDirty ? <Button type="button" variant="quiet" onClick={() => inviteForm.reset({ email: "", role: "member" })}>Discard</Button> : null}
            <Button type="submit" disabled={pending || inviteForm.formState.isSubmitting}>Add</Button>
          </form>
        ) : null}
        {data.invites.length > 0 ? (
          <div className="mt-4">
            <h3 className="text-sm font-semibold">Invitations</h3>
            <ul className="mt-2 text-sm">
              {data.invites.map((invite) => (
                <li key={invite.id}>{invite.email} · {invite.role} · {invite.status}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </Panel>
      <details className="rounded-lg border border-line bg-panel p-5">
        <summary className="cursor-pointer font-display text-2xl">Advanced — ranking diagnostics</summary>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          These weights are not how Meridian finds an opportunity. They only scale a diagnostic score. Learning and evidence still decide the order.
        </p>
        <form
          className="mt-4 grid gap-3 sm:grid-cols-2"
          onSubmit={weightsForm.handleSubmit(saveWeights)}
        >
          {WEIGHT_KEYS.map((key) => (
            <Field key={key} label={LABELS[key]} error={weightsForm.formState.errors[key]?.message}>
              <TextInput
                {...weightsForm.register(key)}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                required
                disabled={!canAdmin}
              />
            </Field>
          ))}
          {weightsForm.formState.isDirty ? <Button type="button" variant="quiet" onClick={() => weightsForm.reset(Object.fromEntries(WEIGHT_KEYS.map((key) => [key, String(active.weights[key])])) as ScoringWeightsInput)}>Discard</Button> : null}
          {canAdmin ? <Button type="submit" disabled={pending || weightsForm.formState.isSubmitting}>Save diagnostic weights</Button> : <p className="text-sm text-muted">Only an admin can change these.</p>}
        </form>
      </details>
      <Panel>
        <h2 className="font-display text-2xl">Another workspace</h2>
        <form
          className="mt-4 flex flex-wrap items-end gap-3"
          onSubmit={createForm.handleSubmit(createWorkspace)}
        >
          <Field label="Name" error={createForm.formState.errors.name?.message} required>
            <TextInput {...createForm.register("name")} maxLength={80} required />
          </Field>
          {createForm.formState.isDirty ? <Button type="button" variant="quiet" onClick={() => createForm.reset()}>Discard</Button> : null}
          <Button type="submit" variant="quiet" disabled={pending || createForm.formState.isSubmitting}>Create</Button>
        </form>
      </Panel>
      <Panel id="workspace-audit">
        <h2 className="font-display text-2xl">Audit</h2>
        <AuditList entries={data.audit} />
      </Panel>
      {canAdmin ? <AlertsPanel organizationId={active.id} /> : null}
      <Panel>
        <h2 className="font-display text-2xl">What is and is not connected</h2>
        <ul className="mt-3 space-y-2 text-sm text-muted">
          <li>A public page you name can be fetched and stored as untrusted text. It does not change the brand brain until you accept a suggestion, and only if a text model is configured.</li>
          <li>Plain text, DOCX, and PDF text can be stored. Instruction-like lines are dropped. An image-only PDF fails closed.</li>
          <li>Meta, TikTok, Google Ads, and Ad Library clients exist. They stay not configured until a request succeeds. This environment has no ad account.</li>
          <li>The worker and scheduler are separate processes. A serverless host does not keep them running. Learning still changes the next rank when performance rows exist.</li>
          <li>Calibration can propose a threshold. It changes nothing until an admin approves it on the learning page.</li>
        </ul>
      </Panel>
    </div>
  );
}
