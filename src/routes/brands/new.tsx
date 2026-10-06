import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useBusy } from "@/components/gate";
import { Button, Field, Notice, TextArea, TextInput } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { hasRole } from "@/lib/meridian/access";
import { createBrand } from "@/lib/meridian/api";

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
  const [form, setForm] = useState({
    name: "",
    website: "",
    sells: "",
    industry: "",
    targetCustomers: "",
    country: "",
    description: "",
    category: "",
  });
  if (!data?.active) return <p className="text-muted">Create a workspace before adding a brand.</p>;
  if (!hasRole(data.active.role, "member")) return <p>You can view this workspace, not add brands.</p>;

  function set(key: keyof typeof form, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    const organizationId = data?.active?.id;
    if (!organizationId) return;
    void run(async () => {
      const created = await createBrand({
        data: { organizationId, ...form },
      });
      await reload();
      await navigate({ to: "/brands/$brandId", params: { brandId: created.id } });
    });
  }
  return (
    <form onSubmit={submit} className="mx-auto max-w-2xl space-y-6">
      <div className="space-y-2">
        <p className="text-sm font-semibold uppercase tracking-widest text-brass">New brand</p>
        <h1 className="font-display text-4xl">Start with what you know</h1>
        <p className="text-muted">
          Six facts are enough. A website is stored, not scraped. Nothing else is inferred.
        </p>
      </div>
      <Field label="Brand name">
        <TextInput required value={form.name} onChange={(event) => set("name", event.target.value)} />
      </Field>
      <Field label="Website" hint="Optional. Stored as a reference only.">
        <TextInput value={form.website} onChange={(event) => set("website", event.target.value)} placeholder="https://" />
      </Field>
      <Field label="What do you sell?">
        <TextArea required value={form.sells} onChange={(event) => set("sells", event.target.value)} />
      </Field>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Industry">
          <TextInput value={form.industry} onChange={(event) => set("industry", event.target.value)} />
        </Field>
        <Field label="Country or market">
          <TextInput value={form.country} onChange={(event) => set("country", event.target.value)} />
        </Field>
      </div>
      <Field label="Target customer">
        <TextArea value={form.targetCustomers} onChange={(event) => set("targetCustomers", event.target.value)} />
      </Field>
      <Field label="Anything else" hint="Optional.">
        <TextArea value={form.description} onChange={(event) => set("description", event.target.value)} />
      </Field>
      {error ? <Notice>{error}</Notice> : null}
      <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Create brand"}</Button>
    </form>
  );
}
