import { useEffect, useState } from "react";
import { Button, Input, SelectInput } from "@/components/ui";
import { getVideoScore, scoreContentVideo } from "@/lib/meridian/content-factory/governance-actions";

type ScoreView = Awaited<ReturnType<typeof getVideoScore>>;

/**
 * A score for a delivered video against one of the brand's rubrics (prompt 18). Each criterion takes a whole number from 1 to 5. A new score
 * is added to the history, and the latest one is shown. A video the engine has not delivered cannot be scored.
 */
export function QualityScore({ sessionId }: { sessionId: string }) {
  const [view, setView] = useState<ScoreView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rubricId, setRubricId] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getVideoScore({ data: { sessionId } }).then(
      (value) => {
        if (active) setView(value);
      },
      (error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error.message : "The score could not be read.");
      },
    );
    return () => {
      active = false;
    };
  }, [sessionId]);

  if (loadError !== null) return <p role="alert" className="mb-4 text-sm text-danger">{loadError}</p>;
  if (view === null) return null;
  const rubric = view.rubrics.find((item) => item.id === (rubricId || view.rubrics[0]?.id)) ?? null;

  async function save() {
    if (rubric === null) return;
    const scores: Record<string, number> = {};
    for (const criterion of rubric.criteria) scores[criterion.name] = Number(values[criterion.name] ?? "");
    setBusy(true);
    setProblem(null);
    try {
      setView(await scoreContentVideo({ data: { sessionId, rubricId: rubric.id, scores } }));
      setValues({});
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The score was not saved. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="cf-score" className="mb-4 space-y-3 rounded-md border border-border p-3">
      <h3 id="cf-score" className="text-sm font-semibold">Quality score</h3>
      {view.latest ? (
        <p className="text-sm">
          Latest score: {view.latest.total.toFixed(2)} out of 5 against {view.latest.rubricName}, given {new Date(view.latest.createdAt).toLocaleString()}.
        </p>
      ) : (
        <p className="text-sm text-fg-muted">Not scored yet.</p>
      )}
      {!view.delivered ? <p className="text-sm text-fg-muted">The engine has not delivered this video yet, so it cannot be scored.</p> : null}
      {view.delivered && view.rubrics.length === 0 ? <p className="text-sm text-fg-muted">No rubric yet. Add one under Content standards for this brand.</p> : null}
      {view.delivered && rubric !== null ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="space-y-1.5">
            <label htmlFor="cf-score-rubric" className="block text-sm font-semibold">Rubric</label>
            <SelectInput id="cf-score-rubric" value={rubric.id} onChange={(event) => { setRubricId(event.target.value); setValues({}); }}>
              {view.rubrics.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </SelectInput>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {rubric.criteria.map((criterion) => (
              <Input
                key={criterion.name}
                id={`cf-score-${criterion.name}`}
                label={`${criterion.name} (weight ${criterion.weight})`}
                type="number"
                min="1"
                max="5"
                step="1"
                inputMode="numeric"
                value={values[criterion.name] ?? ""}
                onChange={(event) => setValues((current) => ({ ...current, [criterion.name]: event.target.value }))}
              />
            ))}
          </div>
          {problem !== null ? <p role="alert" className="text-sm text-danger">{problem}</p> : null}
          <Button type="submit" variant="secondary" disabled={busy}>Save score</Button>
        </form>
      ) : null}
    </section>
  );
}
