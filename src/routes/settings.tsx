import { createFileRoute } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Authed, useBusy } from "@/components/gate";
import { AuditList } from "@/components/audit";
import { AlertsPanel } from "@/components/alerts-panel";
import { Button, Field, Notice, Panel, SelectInput, TextInput } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { hasRole, ROLES } from "@/lib/meridian/access";
import { addMember, changeMemberRole, createOrganization, renameOrganization, updateWeights } from "@/lib/meridian/api";
import { WEIGHT_KEYS, type ScoreWeights } from "@/lib/meridian/scoring";

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
    <Authed>
      <Settings />
    </Authed>
  );
}

function Settings() {
  const { data, reload } = useWorkspace();
  const { pending, error, run } = useBusy();
  const [message, setMessage] = useState<string | null>(null);
  if (!data?.active) return <p className="text-muted">Create a workspace first.</p>;
  const active = data.active;
  const canAdmin = hasRole(active.role, "admin");

  return (
    <div className="space-y-8">
      <div>
        <p className="text-sm font-semibold uppercase tracking-widest text-brass">Workspace</p>
        <h1 className="font-display text-4xl">{active.name}</h1>
        <p className="text-muted">You are {active.role}. Permission checks run on the server, not only in this screen.</p>
      </div>
      {error ? <Notice>{error}</Notice> : null}
      {message ? <p className="text-sm">{message}</p> : null}
      <Panel>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const name = String(new FormData(event.currentTarget).get("name") ?? "");
            void run(async () => {
              await renameOrganization({ data: { organizationId: active.id, name } });
              setMessage("Workspace renamed.");
              await reload();
            });
          }}
        >
          <Field label="Name">
            <TextInput name="name" defaultValue={active.name} disabled={!canAdmin} required />
          </Field>
          {canAdmin ? <Button type="submit" disabled={pending}>Rename</Button> : null}
        </form>
      </Panel>
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
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void run(async () => {
                const result = await addMember({
                  data: {
                    organizationId: active.id,
                    email: String(form.get("email") ?? ""),
                    role: String(form.get("role") ?? "member"),
                  },
                });
                setMessage(result.message);
                event.currentTarget.reset();
                await reload();
              });
            }}
          >
            <TextInput name="email" type="email" required placeholder="Email" aria-label="Email" />
            <SelectInput name="role" aria-label="Role" defaultValue="member">
              <option value="admin">admin</option>
              <option value="member">member</option>
              <option value="viewer">viewer</option>
            </SelectInput>
            <Button type="submit" disabled={pending}>Add</Button>
          </form>
        ) : null}
        {data.invites.length > 0 ? (
          <div className="mt-4">
            <h3 className="text-sm font-semibold">Recorded invites</h3>
            <p className="text-sm text-muted">These were not emailed. Delivery is not configured.</p>
            <ul className="mt-2 text-sm">
              {data.invites.map((invite) => (
                <li key={invite.id}>{invite.email} · {invite.role}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </Panel>
      <Panel>
        <h2 className="font-display text-2xl">Opportunity weights</h2>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          Score = brand fit + historical evidence + market signal + novelty + reproducibility − saturation − risk.
          Weights are configuration. No opportunity is scored until evidence exists.
        </p>
        <form
          className="mt-4 grid gap-3 sm:grid-cols-2"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const weights = Object.fromEntries(
              WEIGHT_KEYS.map((key) => [key, Number(form.get(key))]),
            ) as ScoreWeights;
            void run(async () => {
              await updateWeights({ data: { organizationId: active.id, weights } });
              setMessage("Weights saved.");
              await reload();
            });
          }}
        >
          {WEIGHT_KEYS.map((key) => (
            <Field key={key} label={LABELS[key]}>
              <TextInput
                name={key}
                type="number"
                min={0}
                max={5}
                step="0.05"
                defaultValue={active.weights[key]}
                disabled={!canAdmin}
              />
            </Field>
          ))}
          {canAdmin ? <Button type="submit" disabled={pending}>Save weights</Button> : null}
        </form>
      </Panel>
      <Panel>
        <h2 className="font-display text-2xl">Another workspace</h2>
        <form
          className="mt-4 flex flex-wrap items-end gap-3"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const name = String(new FormData(event.currentTarget).get("workspace") ?? "");
            void run(async () => {
              await createOrganization({ data: { name } });
              setMessage("Workspace created and selected.");
              await reload();
            });
          }}
        >
          <Field label="Name">
            <TextInput name="workspace" required />
          </Field>
          <Button type="submit" variant="quiet" disabled={pending}>Create</Button>
        </form>
      </Panel>
      <Panel>
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
