import { CircleAlert } from "lucide-react";
import { createContext, useContext, useId, type ReactNode } from "react";
import { cn } from "./cn";

type FieldIds = { controlId: string; describedBy?: string; hintId?: string; errorId?: string; invalid: boolean };
const FieldContext = createContext<FieldIds | null>(null);

/** An error is written below the field, with an icon, so it is never a colour alone. */
function ErrorLine({ id, children }: { id?: string; children: ReactNode }) {
  return <span id={id} role="alert" className="flex items-center gap-1.5 text-small text-danger"><CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />{children}</span>;
}

export function Field({ label, hint, error, required = false, className, children, id }: {
  label: string; hint?: string; error?: string; required?: boolean; className?: string; children: ReactNode; id?: string;
}) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const ids = { controlId, describedBy: [hintId, errorId].filter(Boolean).join(" ") || undefined, hintId, errorId, invalid: Boolean(error) };
  return <FieldContext.Provider value={ids}><div className={cn("block space-y-2", className)}>
    <label htmlFor={controlId} className="block text-small font-semibold text-fg-secondary">{label}{required ? <span aria-hidden="true" className="ml-1 text-danger">*</span> : null}</label>
    {children}
    {hint ? <div id={hintId} className="text-small text-fg-muted">{hint}</div> : null}
    {error ? <ErrorLine id={errorId}>{error}</ErrorLine> : null}
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
  return <>{hint ? <span id={hintId} className="block text-small text-fg-muted">{hint}</span> : null}{error ? <ErrorLine id={errorId}>{error}</ErrorLine> : null}</>;
}
