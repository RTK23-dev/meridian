import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge, Button, Card, CardDescription, CardHeader, CardTitle, Input, SelectInput, Textarea } from "@/components/ui";
import { PlainErrorState } from "@/components/plain-error";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { userScopedQueryKey } from "@/lib/query/keys";
import {
  createContentPillar,
  createQualityRubric,
  createRights,
  getContentGovernance,
  removeContentPillar,
  revokeRights,
  setContentCadence,
  setVideoPillar,
} from "@/lib/meridian/content-factory/governance-actions";
import type { CadenceStatus, RubricCriterion } from "@/lib/meridian/content-factory/governance";

const CADENCE_TEXT: Record<"on_track" | "behind" | "ahead", string> = {
  on_track: "On track",
  behind: "Behind",
  ahead: "Ahead",
};

function cadenceLine(cadence: CadenceStatus): string {
  if (cadence.status === "unset") return "No cadence set. Choose how many videos a week the brand intends to post.";
  return `${CADENCE_TEXT[cadence.status]}: ${cadence.actual} of ${cadence.target} ${cadence.target === 1 ? "video" : "videos"} started in the last seven days.`;
}

/** Reads "Name: weight" lines into criteria. A line with no colon, or a weight that is not a number, is kept as it is so the server can refuse it. */
function criteriaFrom(lines: string): RubricCriterion[] {
  return lines
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const colon = line.lastIndexOf(":");
      if (colon < 0) return { name: line, weight: Number.NaN };
      return { name: line.slice(0, colon).trim(), weight: Number(line.slice(colon + 1).trim()) };
    });
}

/**
 * The brand's content standards (prompt 18): pillars and their share of started videos, a posting cadence, each video's pillar, quality
 * rubrics, and rights records. Rights records are what a video's approval checks: an approval is blocked while a file it was made from has no
 * valid record. Admins of the brand's workspace only; the server checks every change.
 */
export function GovernanceCard({ brandId, brandName }: { brandId: string; brandName: string }) {
  const { user } = useCurrentUserState();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pillarName, setPillarName] = useState("");
  const [pillarShare, setPillarShare] = useState("");
  const [cadenceInput, setCadenceInput] = useState("");
  const [rubricName, setRubricName] = useState("");
  const [rubricLines, setRubricLines] = useState("");
  const [rightsSubject, setRightsSubject] = useState("");
  const [rightsHolder, setRightsHolder] = useState("");
  const [rightsUse, setRightsUse] = useState("");
  const [rightsUntil, setRightsUntil] = useState("");
  const [rightsFile, setRightsFile] = useState("");

  const governance = useQuery({
    queryKey: userScopedQueryKey(user?.id, ["content-factory", "governance", brandId]),
    queryFn: () => getContentGovernance({ data: { brandId } }),
  });

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      await governance.refetch();
      setNotice(success);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That change was not saved. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  }

  const data = governance.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Content standards for {brandName}</CardTitle>
        <CardDescription>
          The pillars and cadence the brand intends, the rubric its videos are scored against, and the rights behind the material. A video cannot be approved while a file it was made from has no valid rights record.
        </CardDescription>
      </CardHeader>

      {governance.isError && !data ? <div className="mt-4"><PlainErrorState error={governance.error} onRetry={() => void governance.refetch()} /></div> : null}
      {data ? (
        <div className="mt-4 space-y-6">
          <section aria-labelledby="pillars-title" className="space-y-3">
            <h3 id="pillars-title" className="text-sm font-semibold">Content pillars</h3>
            {data.pillarMix.length === 0 ? <p className="text-sm text-fg-muted">No pillars yet.</p> : null}
            <ul className="divide-y divide-border text-sm">
              {data.pillarMix.map((row) => (
                <li key={row.pillarId ?? "none"} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="font-semibold">{row.name}</span>
                  <span className="text-fg-muted">
                    {row.sharePercent === null ? "No videos started yet" : `${row.sharePercent}% of started videos (${row.started})`}
                    {row.targetShare === null ? "" : ` · target ${row.targetShare}%`}
                  </span>
                  {row.pillarId === null ? null : (
                    <Button type="button" variant="quiet" size="sm" disabled={busy} onClick={() => void run(() => removeContentPillar({ data: { brandId, pillarId: row.pillarId ?? "" } }), "Pillar removed. Its videos are now not in a pillar.")}>
                      Remove<span className="sr-only"> {row.name}</span>
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            <form
              className="grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  await createContentPillar({ data: { brandId, name: pillarName, targetShare: pillarShare.trim() === "" ? null : Number(pillarShare) } });
                  setPillarName("");
                  setPillarShare("");
                }, "Pillar added.");
              }}
            >
              <Input id="pillar-name" label="Pillar name" value={pillarName} maxLength={80} onChange={(event) => setPillarName(event.target.value)} />
              <Input id="pillar-share" type="number" min="1" max="100" step="1" label="Target share (%)" hint="Optional." value={pillarShare} onChange={(event) => setPillarShare(event.target.value)} />
              <Button type="submit" variant="secondary" disabled={busy || pillarName.trim().length === 0}>Add pillar</Button>
            </form>
          </section>

          <section aria-labelledby="cadence-title" className="space-y-3">
            <h3 id="cadence-title" className="text-sm font-semibold">Posting cadence</h3>
            <p className="text-sm">{cadenceLine(data.cadence)}</p>
            <form
              className="grid gap-3 sm:grid-cols-[12rem_auto_auto] sm:items-end"
              onSubmit={(event) => {
                event.preventDefault();
                void run(() => setContentCadence({ data: { brandId, videosPerWeek: cadenceInput.trim() === "" ? null : Number(cadenceInput) } }), "Cadence saved.");
              }}
            >
              <Input id="cadence-input" type="number" min="1" max="14" step="1" label="Videos a week" value={cadenceInput} onChange={(event) => setCadenceInput(event.target.value)} />
              <Button type="submit" variant="secondary" disabled={busy}>Save cadence</Button>
              <Button type="button" variant="quiet" disabled={busy || data.cadence.status === "unset"} onClick={() => void run(() => setContentCadence({ data: { brandId, videosPerWeek: null } }), "Cadence cleared.")}>Clear cadence</Button>
            </form>
          </section>

          <section aria-labelledby="video-pillars-title" className="space-y-3">
            <h3 id="video-pillars-title" className="text-sm font-semibold">Pillar of each video</h3>
            {data.videos.length === 0 ? <p className="text-sm text-fg-muted">No videos yet.</p> : null}
            <ul className="divide-y divide-border text-sm">
              {data.videos.map((video) => (
                <li key={video.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>{video.title} <span className="text-fg-muted">· {video.status}</span></span>
                  <SelectInput
                    id={`video-pillar-${video.id}`}
                    aria-label={`Pillar of ${video.title}`}
                    value={video.pillarId ?? ""}
                    disabled={busy || data.pillars.length === 0}
                    onChange={(event) => void run(() => setVideoPillar({ data: { brandId, sessionId: video.id, pillarId: event.target.value || null } }), "Video's pillar saved.")}
                  >
                    <option value="">Not in a pillar</option>
                    {data.pillars.map((pillar) => <option key={pillar.id} value={pillar.id}>{pillar.name}</option>)}
                  </SelectInput>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="rubrics-title" className="space-y-3">
            <h3 id="rubrics-title" className="text-sm font-semibold">Quality rubrics</h3>
            {data.rubrics.length === 0 ? <p className="text-sm text-fg-muted">No rubric yet. A delivered video can be scored once one exists.</p> : null}
            <ul className="space-y-2 text-sm">
              {data.rubrics.map((rubric) => (
                <li key={rubric.id}>
                  <span className="font-semibold">{rubric.name}</span>
                  <span className="text-fg-muted"> · {rubric.criteria.map((criterion) => `${criterion.name} (weight ${criterion.weight})`).join(", ")}</span>
                </li>
              ))}
            </ul>
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  await createQualityRubric({ data: { brandId, name: rubricName, criteria: criteriaFrom(rubricLines) } });
                  setRubricName("");
                  setRubricLines("");
                }, "Rubric added.");
              }}
            >
              <Input id="rubric-name" label="Rubric name" value={rubricName} maxLength={80} onChange={(event) => setRubricName(event.target.value)} />
              <Textarea id="rubric-criteria" label="Criteria" hint="One per line as Name: weight, weight from 1 to 5. Up to eight criteria." rows={4} value={rubricLines} onChange={(event) => setRubricLines(event.target.value)} />
              <Button type="submit" variant="secondary" disabled={busy || rubricName.trim().length === 0 || rubricLines.trim().length === 0}>Add rubric</Button>
            </form>
          </section>

          <section aria-labelledby="rights-title" className="space-y-3">
            <h3 id="rights-title" className="text-sm font-semibold">Rights records</h3>
            {data.rights.length === 0 ? <p className="text-sm text-fg-muted">No rights are recorded. A video made from a stored file cannot be approved until one is.</p> : null}
            <ul className="divide-y divide-border text-sm">
              {data.rights.map((record) => (
                <li key={record.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                  <div className="min-w-0 space-y-1">
                    <p className="font-semibold">{record.subject}</p>
                    <p className="text-fg-muted">Held by {record.holder}. Permits: {record.permittedUse}{record.validUntil ? `. Until ${record.validUntil}` : ". No end date"}{record.attachmentName ? `. Covers ${record.attachmentName}` : ""}.</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant={record.revokedAt !== null ? "danger" : record.valid ? "success" : "warning"}>
                      {record.revokedAt !== null ? "Revoked" : record.valid ? "Valid" : "Ended"}
                    </Badge>
                    {record.revokedAt === null ? (
                      <Button type="button" variant="quiet" size="sm" disabled={busy} onClick={() => void run(() => revokeRights({ data: { brandId, recordId: record.id } }), "Rights record revoked.")}>
                        Revoke<span className="sr-only"> {record.subject}</span>
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
            <form
              className="grid gap-3 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  await createRights({ data: { brandId, subject: rightsSubject, holder: rightsHolder, permittedUse: rightsUse, validUntil: rightsUntil || null, attachmentId: rightsFile || null } });
                  setRightsSubject("");
                  setRightsHolder("");
                  setRightsUse("");
                  setRightsUntil("");
                  setRightsFile("");
                }, "Rights record added.");
              }}
            >
              <Input id="rights-subject" label="What the material is" value={rightsSubject} maxLength={400} onChange={(event) => setRightsSubject(event.target.value)} />
              <Input id="rights-holder" label="Who holds the rights" value={rightsHolder} maxLength={400} onChange={(event) => setRightsHolder(event.target.value)} />
              <Textarea id="rights-use" label="What use is permitted" rows={2} value={rightsUse} onChange={(event) => setRightsUse(event.target.value)} />
              <Input id="rights-until" type="date" label="Valid until" hint="Optional. Leave empty for no end date." value={rightsUntil} onChange={(event) => setRightsUntil(event.target.value)} />
              <div className="space-y-1.5 sm:col-span-2">
                <label htmlFor="rights-file" className="block text-sm font-semibold">Stored file it covers</label>
                <SelectInput id="rights-file" value={rightsFile} onChange={(event) => setRightsFile(event.target.value)}>
                  <option value="">No stored file (general rights)</option>
                  {data.files.map((file) => <option key={file.id} value={file.id}>{file.fileName} · {file.sessionTitle}</option>)}
                </SelectInput>
              </div>
              <div className="sm:col-span-2">
                <Button type="submit" variant="secondary" disabled={busy || rightsSubject.trim().length === 0 || rightsHolder.trim().length === 0 || rightsUse.trim().length === 0}>Add rights record</Button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
      {notice !== null ? <p role="status" className="mt-4 text-sm">{notice}</p> : null}
      {error !== null ? <p role="alert" className="mt-4 text-sm text-danger">{error}</p> : null}
    </Card>
  );
}
