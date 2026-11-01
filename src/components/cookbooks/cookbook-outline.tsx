// The read-only outline of one cookbook (round 3, K20b2b), with an Edit action for people who may change it (K20b3b part 2c). The server reads the
// cookbook, the outline model orders it, and this panel draws it. Editing opens the edit form in its place; saving reloads the outline.

import { useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { readCookbookAction } from "@/lib/meridian/cookbooks/actions";
import type { Cookbook } from "@/lib/meridian/cookbooks/schema";
import { CookbookEditForm } from "./cookbook-edit-form";
import { outlineOf, type Outline } from "./outline-model";

type Loaded =
  | { state: "loading" }
  | { state: "error"; reason: string }
  | { state: "ready"; outline: Outline; cookbook: Cookbook; source: "builtin" | "workspace" };

export function CookbookOutline({ brandId, cookbookId, canEdit = false }: { brandId: string; cookbookId: string; canEdit?: boolean }) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [editing, setEditing] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const outcome = await readCookbookAction({ data: { brandId, cookbookId } });
        if (cancelled) return;
        setLoaded(
          outcome.ok
            ? { state: "ready", outline: outlineOf(outcome.value.cookbook), cookbook: outcome.value.cookbook, source: outcome.value.source }
            : { state: "error", reason: outcome.reason },
        );
      } catch (caught) {
        if (!cancelled) setLoaded({ state: "error", reason: caught instanceof Error ? caught.message : "The cookbook could not be read." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [brandId, cookbookId, reload]);

  if (loaded.state === "loading") return <p className="text-sm text-fg-muted">Reading the steps…</p>;
  if (loaded.state === "error") return <p role="alert" className="text-sm text-danger">{loaded.reason}</p>;
  const { outline, cookbook, source } = loaded;

  if (editing) {
    return (
      <CookbookEditForm
        brandId={brandId}
        source={source}
        cookbook={cookbook}
        onDone={() => {
          setEditing(false);
          setReload((count) => count + 1);
        }}
      />
    );
  }

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
      {canEdit ? (
        <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)}>
          {source === "builtin" ? "Edit a copy" : "Edit"}
        </Button>
      ) : null}
    </section>
  );
}
