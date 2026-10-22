import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import * as SelectPrimitive from "@radix-ui/react-select";
import * as SliderPrimitive from "@radix-ui/react-slider";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { Check, ChevronDown, ChevronUp, Minus } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "./cn";
import { FieldMessages, useFieldIds } from "./field";

type DescribedControl = { label?: string; hint?: string; error?: string; id?: string };
const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const labelClass = "block text-small font-semibold text-fg-secondary";
const controlClass = `w-full min-h-10 rounded-sm border border-border-strong bg-overlay px-3 py-2 text-body text-fg placeholder:text-fg-muted hover:border-fg-secondary focus-visible:border-accent focus-visible:ring-[3px] focus-visible:ring-accent-muted disabled:cursor-not-allowed disabled:border-hairline disabled:text-fg-muted aria-[invalid=true]:border-danger ${focusRing}`;

export interface InputProps extends InputHTMLAttributes<HTMLInputElement>, DescribedControl {}
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ label, hint, error, id, className, type, step, onWheel, ...props }, ref) {
  const ids = useFieldIds(id, hint, error);
  const numeric = type === "number";
  return <div className="space-y-1.5">
    {label ? <label className={labelClass} htmlFor={ids.controlId}>{label}</label> : null}
    <input {...props} ref={ref} id={ids.controlId} type={type} step={numeric ? step ?? "any" : step} aria-describedby={ids.describedBy} aria-invalid={ids.invalid || undefined} onWheel={(event) => { if (numeric && document.activeElement === event.currentTarget) event.currentTarget.blur(); onWheel?.(event); }} className={cn(controlClass, className)} />
    <FieldMessages hint={hint} error={error} hintId={ids.hintId} errorId={ids.errorId} />
  </div>;
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement>, DescribedControl {}
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ label, hint, error, id, className, ...props }, ref) {
  const ids = useFieldIds(id, hint, error);
  return <div className="space-y-1.5">
    {label ? <label className={labelClass} htmlFor={ids.controlId}>{label}</label> : null}
    <textarea {...props} ref={ref} id={ids.controlId} aria-describedby={ids.describedBy} aria-invalid={ids.invalid || undefined} className={cn(controlClass, "min-h-28", className)} />
    <FieldMessages hint={hint} error={error} hintId={ids.hintId} errorId={ids.errorId} />
  </div>;
});

/** A native select, for forms that need the browser's own list. Use `Select` for the styled, Radix list. */
export function SelectInput({ className, id, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  const ids = useFieldIds(id, undefined, undefined);
  return <select {...props} id={ids.controlId} aria-describedby={ids.describedBy} aria-invalid={ids.invalid || undefined} className={cn(controlClass, className)} />;
}

export function Select({ label, hint, error, id, children, ...props }: DescribedControl & ComponentPropsWithoutRef<typeof SelectPrimitive.Root>) {
  const ids = useFieldIds(id, hint, error);
  return <div className="space-y-1.5">
    {label ? <label id={`${ids.controlId}-label`} className={labelClass}>{label}</label> : null}
    <SelectPrimitive.Root {...props}>
      <SelectPrimitive.Trigger id={ids.controlId} aria-labelledby={label ? `${ids.controlId}-label` : undefined} aria-describedby={ids.describedBy} aria-invalid={ids.invalid || undefined} className={cn(controlClass, "flex items-center justify-between gap-2 text-left")}>
        <SelectPrimitive.Value /> <SelectPrimitive.Icon><ChevronDown aria-hidden="true" className="size-4" /></SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal><SelectPrimitive.Content className="surface-overlay z-50 max-h-72 overflow-hidden rounded-md border border-border-strong bg-overlay text-fg" position="popper"><SelectPrimitive.ScrollUpButton className="flex justify-center"><ChevronUp className="size-4" /></SelectPrimitive.ScrollUpButton><SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport><SelectPrimitive.ScrollDownButton className="flex justify-center"><ChevronDown className="size-4" /></SelectPrimitive.ScrollDownButton></SelectPrimitive.Content></SelectPrimitive.Portal>
    </SelectPrimitive.Root>
    <FieldMessages hint={hint} error={error} hintId={ids.hintId} errorId={ids.errorId} />
  </div>;
}

export const SelectItem = forwardRef<React.ElementRef<typeof SelectPrimitive.Item>, ComponentPropsWithoutRef<typeof SelectPrimitive.Item>>(function SelectItem({ className, children, ...props }, ref) {
  return <SelectPrimitive.Item {...props} ref={ref} className={cn("relative flex min-h-10 cursor-default select-none items-center rounded-sharp py-1 pl-8 pr-3 text-small pointer-coarse:min-h-11 focus:bg-raised data-[disabled]:pointer-events-none data-[disabled]:opacity-50 before:absolute before:inset-y-1 before:left-0 before:hidden before:w-0.5 before:bg-accent before:content-[''] data-[state=checked]:before:block", className)}><span className="absolute left-2 flex size-4 items-center justify-center"><SelectPrimitive.ItemIndicator><Check className="size-4" /></SelectPrimitive.ItemIndicator></span><SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText></SelectPrimitive.Item>;
});

export function Checkbox({ label, hint, error, id, className, ...props }: DescribedControl & ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>) {
  const ids = useFieldIds(id, hint, error);
  const indeterminate = props.checked === "indeterminate";
  return <div className="space-y-1.5"><div className="flex items-center gap-2"><CheckboxPrimitive.Root {...props} id={ids.controlId} aria-describedby={ids.describedBy} aria-invalid={ids.invalid || undefined} className={cn(`touch-hit-44 grid size-4 place-items-center rounded-sharp border border-border-strong bg-transparent text-bg hover:border-fg aria-[invalid=true]:border-danger data-[state=checked]:border-white-accent data-[state=checked]:bg-white-accent data-[state=indeterminate]:border-white-accent data-[state=indeterminate]:bg-white-accent disabled:border-hairline ${focusRing}`, className)}><CheckboxPrimitive.Indicator>{indeterminate ? <Minus className="size-3" /> : <Check className="size-3" />}</CheckboxPrimitive.Indicator></CheckboxPrimitive.Root>{label ? <label htmlFor={ids.controlId} className="text-small text-fg-secondary">{label}</label> : null}</div><FieldMessages hint={hint} error={error} hintId={ids.hintId} errorId={ids.errorId} /></div>;
}

export function Switch({ label, hint, error, id, className, ...props }: DescribedControl & ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>) {
  const ids = useFieldIds(id, hint, error);
  return <div className="space-y-1.5"><div className="flex items-center gap-3"><SwitchPrimitive.Root {...props} id={ids.controlId} aria-describedby={ids.describedBy} aria-invalid={ids.invalid || undefined} className={cn(`touch-hit-44 relative h-5 w-10 rounded-sharp border border-border-strong bg-raised hover:border-fg-secondary aria-[invalid=true]:border-danger data-[state=checked]:border-white-accent data-[state=checked]:bg-white-accent disabled:border-hairline ${focusRing}`, className)}><SwitchPrimitive.Thumb className="block size-3.5 translate-x-[3px] rounded-full bg-fg-secondary transition-transform data-[state=checked]:translate-x-[23px] data-[state=checked]:bg-bg" /></SwitchPrimitive.Root>{label ? <label htmlFor={ids.controlId} className="text-small text-fg-secondary">{label}</label> : null}</div><FieldMessages hint={hint} error={error} hintId={ids.hintId} errorId={ids.errorId} /></div>;
}

export function RadioGroup({ label, hint, error, id, className, ...props }: DescribedControl & ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>) {
  const ids = useFieldIds(id, hint, error);
  return <div className="space-y-2">
    {label ? <p id={`${ids.controlId}-label`} className={labelClass}>{label}</p> : null}
    <RadioGroupPrimitive.Root {...props} id={ids.controlId} aria-labelledby={label ? `${ids.controlId}-label` : undefined} aria-describedby={ids.describedBy} aria-invalid={ids.invalid || undefined} className={className} />
    <FieldMessages hint={hint} error={error} hintId={ids.hintId} errorId={ids.errorId} />
  </div>;
}
export const RadioGroupItem = forwardRef<React.ElementRef<typeof RadioGroupPrimitive.Item>, ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>>(function RadioGroupItem({ className, ...props }, ref) {
  return <RadioGroupPrimitive.Item {...props} ref={ref} className={cn(`touch-hit-44 grid size-4 place-items-center rounded-full border border-border-strong bg-transparent hover:border-fg data-[state=checked]:border-white-accent disabled:border-hairline ${focusRing}`, className)}><RadioGroupPrimitive.Indicator className="size-1.5 rounded-full bg-white-accent" /></RadioGroupPrimitive.Item>;
});

export function Slider({ label, hint, error, id, className, ...props }: DescribedControl & ComponentPropsWithoutRef<typeof SliderPrimitive.Root>) {
  const ids = useFieldIds(id, hint, error);
  return <div className="space-y-2">{label ? <label id={`${ids.controlId}-label`} className={labelClass}>{label}</label> : null}<SliderPrimitive.Root {...props} id={ids.controlId} aria-labelledby={label ? `${ids.controlId}-label` : undefined} aria-describedby={ids.describedBy} className={cn("relative flex h-8 w-full touch-none items-center", className)}><SliderPrimitive.Track className="relative h-1 grow rounded-sharp bg-border-strong"><SliderPrimitive.Range className="absolute h-full rounded-sharp bg-white-accent" /></SliderPrimitive.Track>{(props.value ?? props.defaultValue ?? [0]).map((_, index) => <SliderPrimitive.Thumb key={index} aria-label={label || "Range slider"} aria-describedby={ids.describedBy} className={`touch-hit-44 block size-4 rounded-sharp bg-white-accent disabled:opacity-50 ${focusRing}`} />)}</SliderPrimitive.Root><FieldMessages hint={hint} error={error} hintId={ids.hintId} errorId={ids.errorId} /></div>;
}

export const SelectValue = SelectPrimitive.Value;
