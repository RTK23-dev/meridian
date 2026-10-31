// The selection step (round 3, K18): draws the view from cookbook-selection-model.ts. The pick is shown with its reason, what it needs and what
// it costs; the person confirms it, or picks another cookbook from the list. With no pick the step says why, and when the selector is not
// connected it offers the picker. Nothing here decides a cookbook: the model and the server do that.

import { Button } from "@/components/ui/button";
import type { SelectionView } from "./cookbook-selection-model";

export function CookbookSelectionStep({
  view,
  onConfirm,
  onPick,
}: {
  view: SelectionView;
  onConfirm: () => void;
  onPick: (cookbookId: string) => void;
}) {
  if (view.state === "pick") {
    return (
      <section aria-labelledby="cookbook-pick-title" className="space-y-3">
        <h3 id="cookbook-pick-title" className="text-section font-semibold text-fg">Suggested cookbook: {view.title}</h3>
        <p className="text-small text-fg-secondary">{view.reason}</p>
        <p className="text-small text-fg">{view.badge}. {view.estimate}.</p>
        {view.needs.length > 0 ? (
          <ul className="list-disc space-y-1 pl-5 text-small text-fg-secondary">
            {view.needs.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={onConfirm}>{view.confirmLabel}</Button>
        </div>
        {view.alternatives.length > 0 ? (
          <div className="space-y-2">
            <p className="text-small text-fg-muted">Or choose another:</p>
            <div className="flex flex-wrap gap-2">
              {view.alternatives.map((id) => (
                <Button key={id} type="button" variant="secondary" size="sm" onClick={() => onPick(id)}>
                  {id}
                </Button>
              ))}
            </div>
          </div>
        ) : null}
      </section>
    );
  }
  if (view.state === "picker") {
    return (
      <section aria-labelledby="cookbook-picker-title" className="space-y-3">
        <h3 id="cookbook-picker-title" className="text-section font-semibold text-fg">Choose a cookbook</h3>
        <p className="text-small text-fg-secondary">{view.message}</p>
        <div className="flex flex-wrap gap-2">
          {view.options.map((id) => (
            <Button key={id} type="button" variant="secondary" size="sm" onClick={() => onPick(id)}>
              {id}
            </Button>
          ))}
        </div>
      </section>
    );
  }
  if (view.state === "none") {
    return (
      <section aria-labelledby="cookbook-none-title" className="space-y-2">
        <h3 id="cookbook-none-title" className="text-section font-semibold text-fg">{view.message}</h3>
        <ul className="list-disc space-y-1 pl-5 text-small text-fg-secondary">
          {view.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      </section>
    );
  }
  if (view.state === "failed") {
    return <p role="alert" className="text-small text-danger">The cookbook selector failed: {view.message}</p>;
  }
  return (
    <section aria-labelledby="cookbook-refused-title" className="space-y-2">
      <h3 id="cookbook-refused-title" className="text-section font-semibold text-fg">{view.message}</h3>
      <ul className="list-disc space-y-1 pl-5 text-small text-fg-secondary">
        {view.issues.map((issue) => (
          <li key={issue}>{issue}</li>
        ))}
      </ul>
    </section>
  );
}
