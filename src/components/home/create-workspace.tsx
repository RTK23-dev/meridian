import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Button, Field, TextInput, errorText } from "@/components/ui";
import { FormError } from "@/components/settings/form-error";
import { plainServerError } from "@/components/settings/form-model";
import { useScopedMutation } from "@/lib/query/hooks";
import { createOrganization } from "@/lib/meridian/api";
import { workspaceNameSchema, type WorkspaceNameInput } from "@/lib/meridian/schemas/settings";

/** First step for a signed-in person with no workspace. The workspace is created, then the home reloads. */
export function CreateWorkspace({ onCreated }: { onCreated: () => Promise<void> }) {
  const navigate = useNavigate();
  const createWorkspace = useScopedMutation({
    mutationKey: ["mutation", "organization.create"],
    mutationFn: (values: WorkspaceNameInput) => createOrganization({ data: values }),
    success: "Workspace created.",
    onSuccess: async () => {
      await onCreated();
      await navigate({ to: "/" });
    },
  });
  const pending = createWorkspace.isPending;
  const rawError = createWorkspace.error ? errorText(createWorkspace.error) : null;
  const error = rawError ? plainServerError(rawError, "workspace") : null;
  const { register, handleSubmit, reset, formState: { errors, isDirty, isSubmitting } } = useForm<WorkspaceNameInput>({
    resolver: zodResolver(workspaceNameSchema),
    defaultValues: { name: "" },
    mode: "onBlur",
  });
  useEffect(() => {
    if (!isDirty) return;
    const warnBeforeLeave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warnBeforeLeave);
    return () => window.removeEventListener("beforeunload", warnBeforeLeave);
  }, [isDirty]);
  async function submit(values: WorkspaceNameInput) {
    const created = await createWorkspace.mutateAsync(values).then(() => true, () => false);
    if (created) reset();
  }
  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div className="space-y-3">
        <p className="eyebrow">First step</p>
        <h1 className="font-display text-4xl">Name the workspace</h1>
        <p className="text-fg-muted">A workspace holds brands. You will be the owner. Other people can be added later if they already have accounts.</p>
      </div>
      <form
        onSubmit={handleSubmit(submit)}
        className="space-y-4"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.requestSubmit();
          }
        }}
      >
        <Field label="Workspace name" hint="Your company, studio, or agency." error={errors.name?.message} required>
          <TextInput {...register("name")} required maxLength={80} />
        </Field>
        {isDirty ? (
          <div role="status" className="flex items-center justify-between gap-3 rounded-md border border-warning bg-warning-soft p-3 text-sm">
            <span>Unsaved changes</span>
            <Button type="button" variant="quiet" onClick={() => reset()}>Clear form</Button>
          </div>
        ) : null}
        {error && rawError ? <FormError message={error} raw={rawError} /> : null}
        <Button type="submit" disabled={pending || isSubmitting}>{pending || isSubmitting ? "Creating…" : "Create workspace"}</Button>
      </form>
    </div>
  );
}
