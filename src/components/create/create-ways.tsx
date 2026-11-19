import { Link } from "@tanstack/react-router";
import { Cpu, Layers, Sparkles } from "lucide-react";
import { Button } from "@/components/ui";
import { CREATE_WAY_COPY, CREATE_WAYS, type CreateWay } from "./create-model";

const WAY_ICON = { claude_code: Cpu, meridian: Sparkles, batch: Layers } as const;

/**
 * The first choice on an empty Create page: how to make it. Native radio buttons, so arrow keys move between the ways and each has a
 * visible focus ring. Nothing is chosen while the page is still reading whether the workspace has a text model.
 */
export function CreateWays({ way, onWay }: { way: CreateWay | null; onWay: (way: CreateWay) => void }) {
  return (
    <fieldset className="mt-6 space-y-2">
      <legend className="pb-2 text-sm font-semibold text-fg-primary">How do you want to make it?</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {CREATE_WAYS.map((id) => {
          const Icon = WAY_ICON[id];
          return (
            <label
              key={id}
              className="choice min-h-11 text-sm"
            >
              <input type="radio" name="create-way" value={id} checked={way === id} onChange={() => onWay(id)} className="mt-0.5" />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 font-semibold text-fg-primary">
                  <Icon aria-hidden="true" className="size-4 shrink-0 text-fg-secondary" />
                  {CREATE_WAY_COPY[id].label}
                </span>
                <span className="block pt-0.5 text-caption text-fg-muted">{CREATE_WAY_COPY[id].hint}</span>
              </span>
            </label>
          );
        })}
      </div>
      {way === null ? <p role="status" className="text-caption text-fg-muted">Checking which models this workspace has...</p> : null}
    </fieldset>
  );
}

/**
 * Many variations at once: a batch is made on a brand's Content page, in its Batch section. With a brand picked above the page links there;
 * otherwise it asks for one, and with no brand it offers to create one.
 */
export function CreateBatchWay({ brandId, brands, canAdmin }: { brandId: string; brands: ReadonlyArray<{ id: string; name: string }>; canAdmin: boolean }) {
  const brand = brands.find((item) => item.id === brandId) ?? null;
  return (
    <section aria-labelledby="create-batch" className="space-y-3 pt-6">
      <h2 id="create-batch" className="font-display text-2xl font-semibold tracking-tight text-fg-primary">Many variations at once</h2>
      <p className="max-w-prose text-sm text-fg-secondary">
        A batch turns one ready draft into several variations, each with its own style, within a total budget you set. Nothing starts until you
        press Start batch. {canAdmin ? "" : "Only a workspace admin can make a batch."}
      </p>
      {brand ? (
        <Button asChild>
          <Link to="/brands/$brandId/content" params={{ brandId: brand.id }} search={{ section: "ads" }}>Open {brand.name}'s batches</Link>
        </Button>
      ) : brands.length === 0 ? (
        <div className="space-y-2">
          <p className="text-sm text-fg-muted">A batch belongs to a brand, and this workspace has none yet.</p>
          <Button asChild variant="secondary"><Link to="/brands/new">Create a brand</Link></Button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-fg-muted">A batch belongs to a brand. Pick one in the Brand menu above, or open one here:</p>
          <ul className="flex flex-wrap gap-2" aria-label="Brands">
            {brands.map((item) => (
              <li key={item.id}>
                <Button asChild variant="secondary" size="sm">
                  <Link to="/brands/$brandId/content" params={{ brandId: item.id }} search={{ section: "ads" }}>{item.name}</Link>
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
