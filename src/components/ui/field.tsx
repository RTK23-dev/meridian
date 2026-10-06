import { createContext, useContext, useId, type ReactNode } from "react";
import { cn } from "@/lib/cn";

type FieldIds = { controlId: string; describedBy?: string; hintId?: string; errorId?: string; invalid: boolean };
const FieldContext = createContext<FieldIds | null>(null);

export function Field({ label, hint, error, required = false, className, children, id }: {
  label: string; hint?: string; error?: string; required?: boolean; className?: string; children: ReactNode; id?: string;
}) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const ids = { controlId, describedBy: [hintId, errorId].filter(Boolean).join(" ") || undefined, hintId, errorId, invalid: Boolean(error) };
  return <FieldContext.Provider value={ids}><div className={cn("block space-y-2", className)}>
    <label htmlFor={controlId} className="block text-sm font-semibold text-fg">{label}{required ? <span aria-hidden="true" className="ml-1 text-danger">*</span> : null}</label>
    {children}
    {hint ? <div id={hintId} className="text-sm text-fg-muted">{hint}</div> : null}
    {error ? <div id={errorId} className="text-sm text-danger" role="alert">{error}</div> : null}
  </div></FieldContext.Provider>;
}

export function useFieldIds(id: string | undefined, hint: string | undefined, error: string | undefined) {
  const generatedId = useId();
  const field = useContext(FieldContext);
  const controlId = id ?? field?.controlId ?? generatedId;
  const hintId = hint ? `${controlId}-hint` : field?.hintId;
  const errorId = error ? `${controlId}-error` : field?.errorId;
  return { controlId, describedBy: [hintId, errorId].filter(Boolean).join(" ") || field?.describedBy, hintId, errorId, invalid: Boolean(error) || Boolean(field?.invalid) };
}

export function FieldMessages({ hint, error, hintId, errorId }: { hint?: string; error?: string; hintId?: string; errorId?: string }) {
  return <>{hint ? <span id={hintId} className="block text-sm text-fg-muted">{hint}</span> : null}{error ? <span id={errorId} className="block text-sm text-danger" role="alert">{error}</span> : null}</>;
}
