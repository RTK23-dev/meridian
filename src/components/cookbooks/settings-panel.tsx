// The cookbook settings panel (round 3, K17). It draws the rows of settings-model.ts with the design system's controls and reports each
// change. The rules (what a value may be, and what it means) are in the model and the cookbook; this file only draws and reports.

import type { SettingRow } from "./settings-model";
import { Switch, Slider } from "@/components/ui/controls";

export function SettingsPanel({ rows, onChange }: { rows: readonly SettingRow[]; onChange: (id: string, value: boolean | number | string) => void }) {
  return (
    <div className="space-y-5">
      {rows.map((row) => {
        if (row.kind === "toggle") {
          return (
            <div key={row.id}>
              <Switch label={row.label} hint={row.help ?? undefined} checked={row.value} onCheckedChange={(checked) => onChange(row.id, checked)} />
            </div>
          );
        }
        if (row.kind === "slider") {
          const unit = row.unit ? ` ${row.unit}` : "";
          return (
            <div key={row.id}>
              <Slider
                label={`${row.label}: ${row.value}${unit}`}
                hint={row.help ?? undefined}
                min={row.min}
                max={row.max}
                step={row.step}
                value={[row.value]}
                onValueChange={(values) => onChange(row.id, values[0] ?? row.value)}
              />
            </div>
          );
        }
        if (row.kind === "select") {
          return (
            <div key={row.id} className="space-y-1.5">
              <label htmlFor={`cb-${row.id}`} className="text-small text-fg-secondary">{row.label}</label>
              <select
                id={`cb-${row.id}`}
                value={row.value}
                onChange={(event) => onChange(row.id, event.target.value)}
                className="w-full rounded-sharp border border-border-strong bg-raised px-3 py-2 text-body text-fg"
              >
                {row.options.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              {row.help ? <p className="text-small text-fg-muted">{row.help}</p> : null}
            </div>
          );
        }
        if (row.kind === "text") {
          return (
            <div key={row.id} className="space-y-1.5">
              <label htmlFor={`cb-${row.id}`} className="text-small text-fg-secondary">{row.label}</label>
              <input
                id={`cb-${row.id}`}
                type="text"
                value={row.value}
                maxLength={row.maxLength}
                onChange={(event) => onChange(row.id, event.target.value)}
                className="w-full rounded-sharp border border-border-strong bg-raised px-3 py-2 text-body text-fg"
              />
            </div>
          );
        }
        return (
          <div key={row.id} className="space-y-1.5">
            <label htmlFor={`cb-${row.id}`} className="text-small text-fg-secondary">{row.label}</label>
            <select
              id={`cb-${row.id}`}
              value={row.value}
              onChange={(event) => onChange(row.id, event.target.value)}
              className="w-full rounded-sharp border border-border-strong bg-raised px-3 py-2 text-body text-fg"
            >
              {row.roles.map((role) => (
                <option key={role} value={role}>{role}</option>
              ))}
            </select>
          </div>
        );
      })}
    </div>
  );
}
