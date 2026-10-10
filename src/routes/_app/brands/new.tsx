import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Button, Field, TextArea, TextInput, errorText } from "@/components/ui";
import { FormError } from "@/components/settings/form-error";
import { plainServerError } from "@/components/settings/form-model";
import { useScopedMutation } from "@/lib/query/hooks";
import { useWorkspace } from "@/components/workspace";
import { hasRole } from "@/lib/meridian/access";
import { createBrand } from "@/lib/meridian/api";
import { newBrandSchema, type NewBrandFields, type NewBrandFieldsInput } from "@/lib/meridian/schemas/brand";

export const Route = createFileRoute("/_app/brands/new")({ staticData: { pageTitle: "New brand" }, component: NewBrandPage });

function NewBrandPage() {
  return <NewBrand />;
}

function NewBrand() {
  const { data, reload } = useWorkspace();
  const navigate = useNavigate();
  const createBrandMutation = useScopedMutation({
    mutationKey: ["mutation", "brand.create"],
    mutationFn: (vars: { organizationId: string; form: NewBrandFields }) => createBrand({ data: { organizationId: vars.organizationId, ...vars.form } }),
    success: "Brand created.",
    onSuccess: async (created) => {
      await reload();
      await navigate({ to: "/brands/$brandId", params: { brandId: created.id } });
    },
  });
  const pending = createBrandMutation.isPending;
  const rawError = createBrandMutation.error ? errorText(createBrandMutation.error) : null;
  const { register, handleSubmit, reset, formState: { errors, isDirty, isSubmitting } } = useForm<NewBrandFieldsInput, unknown, NewBrandFields>({
    resolver: zodResolver(newBrandSchema),
    defaultValues: { name: "", website: "", sells: "", industry: "", targetCustomers: "", country: "", description: "", category: "" },
    mode: "onBlur",
  });
  useEffect(() => {
    if (!isDirty) return;
    const warnBeforeLeave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warnBeforeLeave);
    return () => window.removeEventListener("beforeunload", warnBeforeLeave);
  }, [isDirty]);
  if (!data?.active) return <p className="text-fg-muted">Create a workspace before adding a brand.</p>;
  if (!hasRole(data.active.role, "member")) return <p className="text-fg-muted">You can view this workspace, not add brands.</p>;

  async function submit(form: NewBrandFields) {
    const organizationId = data?.active?.id;
    if (!organizationId) return;
    await createBrandMutation.mutateAsync({ organizationId, form }).catch(() => undefined);
  }

  return (
    <form
      onSubmit={handleSubmit(submit)}
      noValidate
      className="mx-auto max-w-2xl space-y-6"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.requestSubmit();
        }
      }}
    >
      <div className="space-y-2">
        <p className="eyebrow">New brand</p>
        <h1 className="font-display text-4xl">Start with what you know</h1>
        <p className="text-fg-muted">
          The brand name and what you sell are required. Everything else is optional, and nothing else is inferred.
          A website is stored as a reference, not scraped.
        </p>
      </div>

      <Field label="Brand name" error={errors.name?.message} required>
        <TextInput {...register("name")} required maxLength={120} autoComplete="organization" />
      </Field>
      <Field label="Website" hint="Optional. Stored as a reference only." error={errors.website?.message}>
        <TextInput {...register("website")} type="url" inputMode="url" maxLength={500} placeholder="https://example.com" autoComplete="url" />
      </Field>
      <Field label="What do you sell?" error={errors.sells?.message} required>
        <TextArea {...register("sells")} required maxLength={500} />
      </Field>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Industry" error={errors.industry?.message}>
          <TextInput {...register("industry")} maxLength={120} />
        </Field>
        <Field label="Country or market" error={errors.country?.message}>
          <TextInput {...register("country")} maxLength={80} />
        </Field>
      </div>
      <Field label="Target customer" error={errors.targetCustomers?.message}>
        <TextArea {...register("targetCustomers")} maxLength={1000} />
      </Field>
      <Field label="Anything else" hint="Optional." error={errors.description?.message}>
        <TextArea {...register("description")} maxLength={2000} />
      </Field>

      {isDirty ? (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning bg-warning-soft p-3 text-sm">
          <span>Unsaved changes</span>
          <Button type="button" variant="quiet" onClick={() => reset()}>Clear form</Button>
        </div>
      ) : null}
      {rawError ? <FormError message={plainServerError(rawError, "brand")} raw={rawError} /> : null}
      <Button type="submit" disabled={pending || isSubmitting}>{pending || isSubmitting ? "Saving…" : "Create brand"}</Button>
    </form>
  );
}
