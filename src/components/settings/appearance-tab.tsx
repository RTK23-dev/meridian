import { DESIGN_STYLES, DESIGN_STYLE_INFO, parseDesignStyle, RadioGroup, RadioGroupItem, useDesignStyle, useTheme, type Theme } from "@/components/ui";

const THEMES: ReadonlyArray<{ value: Theme; label: string }> = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "Follow the system" },
];

/** The look of the app: the design style and the theme. Both are kept in this browser, and neither changes an account or its data. */
export function AppearanceTab() {
  const { style, setStyle } = useDesignStyle();
  const { theme, setTheme } = useTheme();
  return (
    <div className="space-y-10">
      <section aria-labelledby="design-style-heading" className="space-y-4">
        <div>
          <h2 id="design-style-heading" className="text-heading">Design style</h2>
          <p className="text-small text-fg-muted">The look of the whole app. Pick either design; the page changes at once.</p>
        </div>
        <RadioGroup
          aria-labelledby="design-style-heading"
          value={style}
          onValueChange={(value) => setStyle(parseDesignStyle(value))}
          className="grid gap-3 md:grid-cols-2"
        >
          {DESIGN_STYLES.map((id) => {
            const info = DESIGN_STYLE_INFO[id];
            return (
              <label key={id} className="flex cursor-pointer gap-3 rounded-md border border-border bg-surface p-4 has-[[data-state=checked]]:border-accent">
                <RadioGroupItem value={id} className="mt-1" />
                <span className="min-w-0 space-y-2">
                  <span className="block font-semibold text-fg">{info.name}</span>
                  <span className="block text-small text-fg-muted">{info.summary}</span>
                  <span className="flex gap-1.5" aria-hidden="true">
                    <span className="size-4 rounded-sm border border-border" style={{ background: info.preview.accent }} />
                    <span className="size-4 rounded-sm border border-border" style={{ background: info.preview.surface }} />
                    <span className="size-4 rounded-sm border border-border" style={{ background: info.preview.text }} />
                  </span>
                </span>
              </label>
            );
          })}
        </RadioGroup>
      </section>

      <section aria-labelledby="theme-heading" className="space-y-4">
        <div>
          <h2 id="theme-heading" className="text-heading">Theme</h2>
          <p className="text-small text-fg-muted">Dark, light, or the setting of your device. The header switch changes the same setting.</p>
        </div>
        <RadioGroup aria-labelledby="theme-heading" value={theme} onValueChange={(value) => setTheme(value as Theme)} className="flex flex-wrap gap-4">
          {THEMES.map((item) => (
            <label key={item.value} className="flex cursor-pointer items-center gap-2 text-small">
              <RadioGroupItem value={item.value} />
              {item.label}
            </label>
          ))}
        </RadioGroup>
      </section>
    </div>
  );
}
