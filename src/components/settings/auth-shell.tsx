import type { ReactNode } from "react";

/** The Meridian mark: the globe, drawn with the same proportions as the favicon, in theme tokens so it reads in light and dark, and its red
 *  meridian follows the reader's accent. */
export function MeridianMark({ className = "size-9" }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 32 32" className={className} focusable="false">
      <rect width="32" height="32" rx="6" style={{ fill: "var(--bg-base)" }} />
      <g fill="none" strokeWidth={1.2} style={{ stroke: "var(--fg-primary)" }}>
        <circle cx="16" cy="16" r="14.7" />
        <ellipse cx="16" cy="8.7" rx="12.7" ry="3.2" />
        <ellipse cx="16" cy="16" rx="14.7" ry="3.7" />
        <ellipse cx="16" cy="23.3" rx="12.7" ry="3.2" />
        <ellipse cx="16" cy="16" rx="14.4" ry="14.7" />
        <ellipse cx="16" cy="16" rx="5" ry="14.7" />
        <ellipse cx="16" cy="16" rx="2.5" ry="14.7" />
      </g>
      <ellipse cx="16" cy="16" rx="11.2" ry="14.7" fill="none" strokeWidth={1.6} style={{ stroke: "var(--accent)" }} />
    </svg>
  );
}

const LOOP = ["Research", "Pick a format", "Make a batch", "Review", "Publish"] as const;

/**
 * The left side of the sign-in and welcome screens. It says what Meridian does in one sentence, shows the loop it runs, and states
 * the two things people ask about first: where keys live, and that ads start paused.
 */
export function BrandStage({ headline = "Research your niche. Make many original videos.", lead }: { headline?: string; lead?: ReactNode }) {
  return (
    <section aria-label="About Meridian" className="space-y-8">
      <div className="flex items-center gap-3">
        <MeridianMark className="size-10" />
        <span className="font-display text-2xl font-semibold tracking-tight text-fg-primary">Meridian</span>
      </div>
      <div className="space-y-4">
        <p className="eyebrow">For one brand at a time</p>
        <h2 className="text-2xl font-semibold leading-tight text-fg-primary sm:text-3xl">{headline}</h2>
        <p className="max-w-prose text-lg text-fg-muted">
          {lead ?? "Meridian studies what works in your niche, turns it into a video format you can reuse, and makes a batch of original videos from it. You review every video before anything goes out. Nothing is spent until you set a budget."}
        </p>
      </div>
      <ol className="flex flex-wrap items-center gap-2" aria-label="The loop Meridian runs">
        {LOOP.map((stage, index) => (
          <li
            key={stage}
            className="stagger-in flex items-center gap-2 rounded-full border border-hairline bg-raised px-3 py-1.5 text-sm font-medium text-fg-primary"
            style={{ animationDelay: `${120 + index * 90}ms` }}
          >
            <span className="size-1.5 rounded-full bg-fg-muted" aria-hidden="true" />
            {stage}
            {index < LOOP.length - 1 ? <span aria-hidden="true" className="text-fg-muted">→</span> : null}
          </li>
        ))}
      </ol>
      <p className="max-w-prose text-sm text-fg-muted">
        Each decision is stored with the evidence it used. Paid ads, if you use them, are always created paused. Keys are saved encrypted on the server, and they are never shown again.
      </p>
    </section>
  );
}

/** A split layout: the brand stage on the left and the form on the right. It stacks on a phone, with the form first. */
export function AuthShell({ title, description, children, footer }: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main id="main" tabIndex={-1} className="mx-auto grid min-h-screen w-full max-w-6xl items-center gap-10 px-4 py-10 sm:px-6 lg:grid-cols-[1.1fr_0.9fr] lg:gap-16 lg:py-16">
      <div className="order-2 lg:order-1">
        <BrandStage />
      </div>
      <div className="page-enter order-1 mx-auto w-full max-w-md space-y-6 lg:order-2">
        <div className="space-y-2">
          <h1 className="page-title">{title}</h1>
          {description ? <p className="text-fg-muted">{description}</p> : null}
        </div>
        <div className="surface-rise space-y-6 rounded-sharp border border-hairline bg-raised p-6 md:p-7">{children}</div>
        {footer ? <div className="text-sm text-fg-muted">{footer}</div> : null}
      </div>
    </main>
  );
}
