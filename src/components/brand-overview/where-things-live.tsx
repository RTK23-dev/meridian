import { Link } from "@tanstack/react-router";
import { AREA_GUIDE } from "@/lib/navigation/model";

/**
 * A short map of the brand's screens, so a new person can find direct creation, the research-led Factory, the queue, the library and
 * the reviews. Each entry links to a screen the sidebar lists, and each one says what it is for in plain words.
 */
export function WhereThingsLive({ brandId }: { brandId: string }) {
  return (
    <section aria-labelledby="where-things-live" className="surface-rise rounded-xl border border-border bg-surface p-5 shadow-sm md:p-6">
      <h2 id="where-things-live" className="text-section font-semibold">Where things live</h2>
      <ul className="mt-3 divide-y divide-border">
        {AREA_GUIDE.map((area) => (
          <li key={area.id} className="py-3">
            <Link to={`/brands/${brandId}/${area.path}` as never} className="font-semibold underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2">
              {area.label}
            </Link>
            <p className="mt-1 text-sm text-fg-muted">{area.what}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
