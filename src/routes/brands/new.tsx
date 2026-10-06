import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useBusy } from "@/components/gate";
import { Button, Field, Notice, TextArea, TextInput } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { hasRole } from "@/lib/meridian/access";
import { createBrand } from "@/lib/meridian/api";
import { newBrandSchema, type NewBrandFields, type NewBrandFieldsInput } from "@/lib/meridian/schemas/brand";

export const Route = createFileRoute("/brands/new")({ component: NewBrandPage });

function NewBrandPage() {
  return (
    <NewBrand />
  );
}

function NewBrand() {
  const { data, reload } = useWorkspace();
  const navigate = useNavigate();
  const { pending, error, run } = useBusy();
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
  if (!data?.active) return <p className="text-muted">Create a workspace before adding a brand.</p>;
  if (!hasRole(data.active.role, "member")) return <p>You can view this workspace, not add brands.</p>;

  async function submit(form: NewBrandFields) {
    const organizationId = data?.active?.id;
    if (!organizationId) return;
    await run(async () => {
      const created = await createBrand({
        data: { organizationId, ...form },
      });
      await reload();
      await navigate({ to: "/brands/$brandId", params: { brandId: created.id } });
    });
  }
  return (
    <form onSubmit={handleSubmit(submit)} className="mx-auto max-w-2xl space-y-6" onKeyDown={(event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        event.currentTarget.requestSubmit();
      }
    }}>
      <div className="space-y-2">
        <p className="text-sm font-semibold uppercase tracking-widest text-brass">New brand</p>
        <h1 className="font-display text-4xl">Start with what you know</h1>
        <p className="text-muted">
          Six facts are enough. A website is stored, not scraped. Nothing else is inferred.
        </p>
      </div>
      <Field label="Brand name" error={errors.name?.message} required>
        <TextInput {...register("name")} required maxLength={120} />
      </Field>
      <Field label="Website" hint="Optional. Stored as a reference only." error={errors.website?.message}>
        <TextInput {...register("website")} maxLength={500} placeholder="https://example.test" />
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
      {isDirty ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning bg-warning-soft p-3 text-sm" role="status"><span>Unsaved changes</span><Button type="button" variant="quiet" onClick={() => reset()}>Clear form</Button></div> : null}
      {error ? <Notice>{error}</Notice> : null}
      <Button type="submit" disabled={pending || isSubmitting}>{pending || isSubmitting ? "Saving…" : "Create brand"}</Button>
    </form>
  );
}
