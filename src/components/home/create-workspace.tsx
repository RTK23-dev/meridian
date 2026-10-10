import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Button, Field, TextInput, errorText } from "@/components/ui";
import { FormError } from "@/components/settings/form-error";
import { plainServerError } from "@/components/settings/form-model";
import { UnsavedChangesBar } from "@/components/forms/unsaved-bar";
import { UnsavedChangesGuard } from "@/components/forms/unsaved-guard";
import { submitOnShortcut } from "@/components/forms/shortcut";
import { useScopedMutation } from "@/lib/query/hooks";
import { createOrganization } from "@/lib/meridian/api";
import { workspaceNameSchema, type WorkspaceNameInput } from "@/lib/meridian/schemas/settings";

/** First step for a signed-in person with no workspace. The workspace is created, then the home reloads. */
export function CreateWorkspace({ onCreated }: { onCreated: () => Promise<void> }) {
  const navigate = useNavigate();
  const [discardRequested, setDiscardRequested] = useState(false);
  const { register, handleSubmit, reset, formState: { errors, isDirty, isSubmitting } } = useForm<WorkspaceNameInput>({
    resolver: zodResolver(workspaceNameSchema),
    defaultValues: { name: "" },
    mode: "onBlur",
  });
  const createWorkspace = useScopedMutation({
    mutationKey: ["mutation", "organization.create"],
    mutationFn: (values: WorkspaceNameInput) => createOrganization({ data: values }),
    success: "Workspace created.",
    onSuccess: async () => {
      // Saved, so the form is clean before the screen leaves. Otherwise the unsaved-changes guard would ask.
      reset({ name: "" });
      await onCreated();
      await navigate({ to: "/" });
    },
  });
  const pending = createWorkspace.isPending;
  const rawError = createWorkspace.error ? errorText(createWorkspace.error) : null;
  const error = rawError ? plainServerError(rawError, "workspace") : null;
  async function submit(values: WorkspaceNameInput) {
    const created = await createWorkspace.mutateAsync(values).then(() => true, () => false);
    if (created) reset();
  }
  return (
    <div className="mx-auto max-w-lg space-y-6">
      <UnsavedChangesGuard dirty={isDirty} />
      <div className="space-y-3">
        <p className="eyebrow">First step</p>
        <h1 className="font-display text-4xl">Name the workspace</h1>
        <p className="text-fg-muted">A workspace holds brands. You will be the owner. Other people can be added later if they already have accounts.</p>
      </div>
      <form onSubmit={handleSubmit(submit)} className="space-y-4" onKeyDown={(event) => submitOnShortcut(event)}>
        <Field label="Workspace name" hint="Your company, studio, or agency." error={errors.name?.message} required>
          <TextInput {...register("name")} required maxLength={80} />
        </Field>
        <UnsavedChangesBar
          dirty={isDirty}
          subject="workspace"
          confirming={discardRequested}
          onConfirmingChange={setDiscardRequested}
          onDiscard={() => { reset(); setDiscardRequested(false); }}
        />
        {error && rawError ? <FormError message={error} raw={rawError} /> : null}
        <Button type="submit" disabled={pending || isSubmitting}>{pending || isSubmitting ? "Creating…" : "Create workspace"}</Button>
      </form>
    </div>
  );
}
