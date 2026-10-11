import { CircleCheck, Pause, Power } from "lucide-react";

/**
 * What "paused" means on a publish. It is the same for every paused publish, so it lives in one place and says what happens to a
 * real ad: it is created, nothing spends, and a person switches it on in Meta.
 */
export function PausedExplainer() {
  const steps = [
    { icon: CircleCheck, title: "Meridian creates it", text: "The campaign, ad set and ad are created in Meta with the status Paused." },
    { icon: Pause, title: "Nothing shows or spends", text: "A paused ad does not run, so it cannot reach anyone or use budget." },
    { icon: Power, title: "You switch it on", text: "Check the creative, the Page, the audience and the budget in Meta Ads Manager, then turn it on there. Meridian has no switch for this." },
  ];
  return (
    <section aria-labelledby="paused-explainer" className="mt-4 rounded-lg border border-border bg-surface-2 p-4">
      <h3 id="paused-explainer" className="text-sm font-semibold text-fg">What &ldquo;paused&rdquo; means here</h3>
      <ol className="mt-3 grid gap-3 md:grid-cols-3">
        {steps.map((step, index) => (
          <li key={step.title} className="flex gap-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-soft text-accent" aria-hidden="true">
              <step.icon className="size-4" />
            </span>
            <span className="min-w-0 space-y-1">
              <span className="block text-sm font-semibold text-fg"><span className="text-fg-muted">{index + 1}. </span>{step.title}</span>
              <span className="block text-sm text-fg-muted">{step.text}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
