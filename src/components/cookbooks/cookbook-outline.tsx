// The read-only outline of one cookbook (round 3, K20b2b): the server reads the cookbook, the outline model orders it, and this panel draws the
// steps and the controls. Nothing here changes a cookbook; the library screen and the editor's own controls do that.

import { useEffect, useState } from "react";
import { readCookbookAction } from "@/lib/meridian/cookbooks/actions";
import { outlineOf, type Outline } from "./outline-model";

type Loaded = { state: "loading" } | { state: "error"; reason: string } | { state: "ready"; outline: Outline };

export function CookbookOutline({ brandId, cookbookId }: { brandId: string; cookbookId: string }) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const outcome = await readCookbookAction({ data: { brandId, cookbookId } });
        if (cancelled) return;
        setLoaded(outcome.ok ? { state: "ready", outline: outlineOf(outcome.value.cookbook) } : { state: "error", reason: outcome.reason });
      } catch (caught) {
        if (!cancelled) setLoaded({ state: "error", reason: caught instanceof Error ? caught.message : "The cookbook could not be read." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [brandId, cookbookId]);

  if (loaded.state === "loading") return <p className="text-sm text-fg-muted">Reading the steps…</p>;
  if (loaded.state === "error") return <p role="alert" className="text-sm text-danger">{loaded.reason}</p>;
  const { outline } = loaded;
  return (
    <section aria-label={`Steps of ${outline.label}`} className="space-y-3">
      <ol className="list-decimal space-y-1 pl-5 text-sm text-fg">
        {outline.steps.map((step) => (
          <li key={step.id}>
            {step.label}
            <span className="text-fg-muted">
              {" "}({step.kind}
              {step.waitsFor.length > 0 ? `, after ${step.waitsFor.join(", ")}` : ""}
              {step.conditional ? ", only when set" : ""})
            </span>
          </li>
        ))}
      </ol>
      <ul className="space-y-1 text-sm text-fg-muted">
        {outline.controls.map((control) => (
          <li key={control.id}>
            {control.label}: {control.defaultText}
          </li>
        ))}
      </ul>
    </section>
  );
}
