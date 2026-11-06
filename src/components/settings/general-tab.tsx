import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Link } from "@tanstack/react-router";
import { Button, Field, Input, errorText } from "@/components/ui";
import { UnsavedChangesBar } from "@/components/forms/unsaved-bar";
import { UnsavedChangesGuard } from "@/components/forms/unsaved-guard";
import { submitOnShortcut } from "@/components/forms/shortcut";
import { useWorkspace } from "@/components/workspace";
import { createOrganization, renameOrganization } from "@/lib/meridian/api";
import { workspaceNameSchema, type WorkspaceNameInput } from "@/lib/meridian/schemas/settings";
import { useScopedMutation } from "@/lib/query/hooks";
import { FormError } from "./form-error";
import { plainServerError } from "./form-model";

/** Workspace name, billing and limits, and a second workspace. Keys and models have their own tabs. */
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
    <div className="space-y-10">
      <UnsavedChangesGuard dirty={renameForm.formState.isDirty || createForm.formState.isDirty} />
      <section aria-labelledby="workspace-name-title" className="space-y-4 panel">
        <h2 id="workspace-name-title" className="text-section font-semibold text-fg-primary">Workspace name</h2>
        {!canAdmin ? <p className="text-sm text-fg-muted">Only an admin can rename this workspace.</p> : null}
        <form className="flex flex-wrap items-end gap-3" onSubmit={renameForm.handleSubmit(rename)} onKeyDown={(event) => submitOnShortcut(event)}>
          <Field label="Name" error={renameForm.formState.errors.name?.message} required>
            <Input {...renameForm.register("name")} maxLength={80} disabled={!canAdmin} required />
          </Field>
          {canAdmin ? <Button type="submit" variant="secondary" disabled={renameWorkspace.isPending || renameForm.formState.isSubmitting}>{renameWorkspace.isPending || renameForm.formState.isSubmitting ? "Renaming…" : "Rename"}</Button> : null}
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

      <section aria-labelledby="billing-limits-title" className="panel">
        <h2 id="billing-limits-title" className="text-section font-semibold text-fg-primary">Billing and limits</h2>
        <p className="mt-1 text-sm text-fg-muted">
          The monthly budget, the brand budgets, the factory caps, the measure ceiling and the decision cap are set in one place.
          Nothing is set by default: a limit that is not set refuses the paid step it guards.
        </p>
        <p className="mt-3"><Link to="/billing" className="font-semibold underline underline-offset-2">Open billing and limits</Link></p>
      </section>

      <details className="group rounded-sharp border border-hairline bg-raised p-5">
        <summary className="cursor-pointer text-base font-semibold text-fg-primary">Create another workspace<span className="ml-2 text-sm font-normal text-fg-muted">A second one keeps its own brands, members and keys</span></summary>
        <div className="mt-4">
      <section aria-labelledby="another-workspace-title" className="space-y-4 panel">
        <div>
          <h2 id="another-workspace-title" className="text-section font-semibold text-fg-primary">Create another workspace</h2>
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
        </div>
      </details>

      <p className="text-sm text-fg-muted">Keys, connections and models are in the Connections and Models tabs.</p>
    </div>
  );
}
