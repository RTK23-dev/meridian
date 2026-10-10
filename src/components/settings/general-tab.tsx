import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Button, Field, Input, errorText } from "@/components/ui";
import { UnsavedChangesBar } from "@/components/forms/unsaved-bar";
import { UnsavedChangesGuard } from "@/components/forms/unsaved-guard";
import { submitOnShortcut } from "@/components/forms/shortcut";
import { useWorkspace } from "@/components/workspace";
import { ProviderSettingsPanel } from "@/components/provider-settings-panel";
import { createOrganization, renameOrganization } from "@/lib/meridian/api";
import { workspaceNameSchema, type WorkspaceNameInput } from "@/lib/meridian/schemas/settings";
import { useScopedMutation } from "@/lib/query/hooks";
import { FormError } from "./form-error";
import { plainServerError } from "./form-model";

/** Workspace name, a second workspace, the provider configuration, and what is and is not connected. */
export function GeneralTab({ organizationId, name, canAdmin }: { organizationId: string; name: string; canAdmin: boolean }) {
  const { reload } = useWorkspace();
  const renameForm = useForm<WorkspaceNameInput>({ resolver: zodResolver(workspaceNameSchema), defaultValues: { name }, mode: "onBlur" });
  const createForm = useForm<WorkspaceNameInput>({ resolver: zodResolver(workspaceNameSchema), defaultValues: { name: "" }, mode: "onBlur" });
  const [renameDiscard, setRenameDiscard] = useState(false);
  const [createDiscard, setCreateDiscard] = useState(false);

  // The name follows the workspace until someone edits it, so a rename from elsewhere is not hidden by a stale draft.
  useEffect(() => {
    if (!renameForm.formState.isDirty) renameForm.reset({ name });
  }, [name, renameForm]);

  const renameWorkspace = useScopedMutation({
    mutationKey: ["mutation", "workspace.rename", organizationId],
    mutationFn: (values: WorkspaceNameInput) => renameOrganization({ data: { organizationId, ...values } }),
    success: "Workspace renamed.",
    onSuccess: async () => { await reload(); },
  });
  const createWorkspaceAction = useScopedMutation({
    mutationKey: ["mutation", "organization.create"],
    mutationFn: (values: WorkspaceNameInput) => createOrganization({ data: values }),
    success: "Workspace created and selected.",
    onSuccess: async () => { await reload(); },
  });

  const renameRaw = renameWorkspace.error ? errorText(renameWorkspace.error) : null;
  const createRaw = createWorkspaceAction.error ? errorText(createWorkspaceAction.error) : null;

  async function rename(values: WorkspaceNameInput) {
    const saved = await renameWorkspace.mutateAsync(values).then(() => true, () => false);
    // Text typed while the rename was running stays in the field. Only the saved baseline moves.
    if (saved) renameForm.reset(values, { keepValues: true });
  }

  async function createWorkspace(values: WorkspaceNameInput) {
    const saved = await createWorkspaceAction.mutateAsync(values).then(() => true, () => false);
    if (saved) createForm.reset();
  }

  return (
    <div className="space-y-8">
      <UnsavedChangesGuard dirty={renameForm.formState.isDirty || createForm.formState.isDirty} />
      <section aria-labelledby="workspace-name-title" className="space-y-4 rounded-lg border border-border bg-surface p-5">
        <h2 id="workspace-name-title" className="text-section font-semibold text-fg">Workspace name</h2>
        {!canAdmin ? <p className="text-sm text-fg-muted">Only an admin can rename this workspace.</p> : null}
        <form className="flex flex-wrap items-end gap-3" onSubmit={renameForm.handleSubmit(rename)} onKeyDown={(event) => submitOnShortcut(event)}>
          <Field label="Name" error={renameForm.formState.errors.name?.message} required>
            <Input {...renameForm.register("name")} maxLength={80} disabled={!canAdmin} required />
          </Field>
          {canAdmin ? <Button type="submit" disabled={renameWorkspace.isPending || renameForm.formState.isSubmitting}>{renameWorkspace.isPending || renameForm.formState.isSubmitting ? "Renaming…" : "Rename"}</Button> : null}
        </form>
        <UnsavedChangesBar
          dirty={renameForm.formState.isDirty}
          subject="workspace name"
          confirming={renameDiscard}
          onConfirmingChange={setRenameDiscard}
          onDiscard={() => { renameForm.reset({ name }); setRenameDiscard(false); }}
        />
        {renameRaw ? <FormError message={plainServerError(renameRaw, "settings")} raw={renameRaw} /> : null}
      </section>

      <section aria-labelledby="another-workspace-title" className="space-y-4 rounded-lg border border-border bg-surface p-5">
        <div>
          <h2 id="another-workspace-title" className="text-section font-semibold text-fg">Create another workspace</h2>
          <p className="mt-1 text-sm text-fg-muted">A second workspace keeps its own brands, members, and keys. You become its owner.</p>
        </div>
        <form className="flex flex-wrap items-end gap-3" onSubmit={createForm.handleSubmit(createWorkspace)} onKeyDown={(event) => submitOnShortcut(event)}>
          <Field label="Name" error={createForm.formState.errors.name?.message} required>
            <Input {...createForm.register("name")} maxLength={80} required />
          </Field>
          <Button type="submit" variant="secondary" disabled={createWorkspaceAction.isPending || createForm.formState.isSubmitting}>{createWorkspaceAction.isPending || createForm.formState.isSubmitting ? "Creating…" : "Create workspace"}</Button>
        </form>
        <UnsavedChangesBar
          dirty={createForm.formState.isDirty}
          subject="new workspace"
          confirming={createDiscard}
          onConfirmingChange={setCreateDiscard}
          onDiscard={() => { createForm.reset(); setCreateDiscard(false); }}
        />
        {createRaw ? <FormError message={plainServerError(createRaw, "workspace")} raw={createRaw} /> : null}
      </section>

      <section aria-labelledby="provider-settings-title" className="space-y-3">
        <div>
          <h2 id="provider-settings-title" className="text-section font-semibold text-fg">Provider keys and settings</h2>
          <p className="mt-1 text-sm text-fg-muted">Keys are stored encrypted and are never shown again. Only an admin can save or remove them.</p>
        </div>
        <ProviderSettingsPanel organizationId={organizationId} canAdmin={canAdmin} />
      </section>

      <section aria-labelledby="connected-title" className="space-y-3 rounded-lg border border-border bg-surface p-5">
        <h2 id="connected-title" className="text-section font-semibold text-fg">What is and is not connected</h2>
        <ul className="space-y-2 text-sm text-fg-muted">
          <li>A public page you name can be fetched and stored as untrusted text. It does not change the brand brain until you accept a suggestion, and only if a text model is configured.</li>
          <li>Plain text, DOCX, and PDF text can be stored. Instruction-like lines are dropped. An image-only PDF fails closed.</li>
          <li>Meta, TikTok, Google Ads, and Ad Library clients exist. They stay not configured until a request succeeds. This environment has no ad account.</li>
          <li>The worker and scheduler are separate processes. A serverless host does not keep them running. Learning still changes the next rank when performance rows exist.</li>
          <li>Calibration can propose a threshold. It changes nothing until an admin approves it on the learning page.</li>
        </ul>
      </section>
    </div>
  );
}
