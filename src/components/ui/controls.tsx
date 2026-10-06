import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import * as SelectPrimitive from "@radix-ui/react-select";
import * as SliderPrimitive from "@radix-ui/react-slider";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { FieldMessages, useFieldIds } from "./field";

type DescribedControl = { label?: string; hint?: string; error?: string; id?: string };
const controlClass = "w-full rounded-md border border-border-strong bg-surface px-3 py-3 text-base text-fg outline-none placeholder:text-fg-muted focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-55 aria-[invalid=true]:border-danger aria-[invalid=true]:focus-visible:ring-danger";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement>, DescribedControl {}
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ label, hint, error, id, className, type, step, onWheel, ...props }, ref) {
  const ids = useFieldIds(id, hint, error);
  const numeric = type === "number";
  return <div className="space-y-1.5">
    {label ? <label className="block text-sm font-semibold" htmlFor={ids.controlId}>{label}</label> : null}
    <input {...props} ref={ref} id={ids.controlId} type={type} step={numeric ? step ?? "any" : step} aria-describedby={ids.describedBy} aria-invalid={ids.invalid || undefined} onWheel={(event) => { if (numeric && document.activeElement === event.currentTarget) event.currentTarget.blur(); onWheel?.(event); }} className={cn(controlClass, className)} />
    <FieldMessages hint={hint} error={error} hintId={ids.hintId} errorId={ids.errorId} />
  </div>;
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement>, DescribedControl {}
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ label, hint, error, id, className, ...props }, ref) {
  const ids = useFieldIds(id, hint, error);
  return <div className="space-y-1.5">
    {label ? <label className="block text-sm font-semibold" htmlFor={ids.controlId}>{label}</label> : null}
    <textarea {...props} ref={ref} id={ids.controlId} aria-describedby={ids.describedBy} aria-invalid={ids.invalid || undefined} className={cn(controlClass, "min-h-28", className)} />
    <FieldMessages hint={hint} error={error} hintId={ids.hintId} errorId={ids.errorId} />
  </div>;
});

export function Select({ label, hint, error, id, children, ...props }: DescribedControl & ComponentPropsWithoutRef<typeof SelectPrimitive.Root>) {
  const ids = useFieldIds(id, hint, error);
  return <div className="space-y-1.5">
    {label ? <label id={`${ids.controlId}-label`} className="block text-sm font-semibold">{label}</label> : null}
    <SelectPrimitive.Root {...props}>
      <SelectPrimitive.Trigger id={ids.controlId} aria-labelledby={label ? `${ids.controlId}-label` : undefined} aria-describedby={ids.describedBy} aria-invalid={ids.invalid || undefined} className={cn(controlClass, "flex items-center justify-between gap-2 text-left")}>
        <SelectPrimitive.Value /> <SelectPrimitive.Icon><ChevronDown aria-hidden="true" className="size-4" /></SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal><SelectPrimitive.Content className="z-50 max-h-72 overflow-hidden rounded-md border border-border-strong bg-surface text-fg shadow-md" position="popper"><SelectPrimitive.ScrollUpButton className="flex justify-center"><ChevronUp className="size-4" /></SelectPrimitive.ScrollUpButton><SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport><SelectPrimitive.ScrollDownButton className="flex justify-center"><ChevronDown className="size-4" /></SelectPrimitive.ScrollDownButton></SelectPrimitive.Content></SelectPrimitive.Portal>
    </SelectPrimitive.Root>
    <FieldMessages hint={hint} error={error} hintId={ids.hintId} errorId={ids.errorId} />
  </div>;
}

export const SelectItem = forwardRef<React.ElementRef<typeof SelectPrimitive.Item>, ComponentPropsWithoutRef<typeof SelectPrimitive.Item>>(function SelectItem({ className, children, ...props }, ref) {
  return <SelectPrimitive.Item {...props} ref={ref} className={cn("relative flex min-h-9 cursor-default select-none items-center rounded-sm py-1 pl-8 pr-3 text-sm outline-none focus:bg-accent-soft data-[disabled]:pointer-events-none data-[disabled]:opacity-50", className)}><span className="absolute left-2 flex size-4 items-center justify-center"><SelectPrimitive.ItemIndicator><Check className="size-4" /></SelectPrimitive.ItemIndicator></span><SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText></SelectPrimitive.Item>;
});

export function Checkbox({ label, hint, error, id, className, ...props }: DescribedControl & ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>) {
  const ids = useFieldIds(id, hint, error);
  return <div className="space-y-1.5"><div className="flex items-center gap-2"><CheckboxPrimitive.Root {...props} id={ids.controlId} aria-describedby={ids.describedBy} aria-invalid={ids.invalid || undefined} className={cn("grid size-5 place-items-center rounded border border-border-strong bg-surface text-accent-fg focus-visible:ring-2 focus-visible:ring-accent data-[state=checked]:border-accent data-[state=checked]:bg-accent disabled:opacity-50", className)}><CheckboxPrimitive.Indicator><Check className="size-4" /></CheckboxPrimitive.Indicator></CheckboxPrimitive.Root>{label ? <label htmlFor={ids.controlId} className="text-sm font-medium">{label}</label> : null}</div><FieldMessages hint={hint} error={error} hintId={ids.hintId} errorId={ids.errorId} /></div>;
}

export function Switch({ label, hint, error, id, className, ...props }: DescribedControl & ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>) {
  const ids = useFieldIds(id, hint, error);
  return <div className="space-y-1.5"><div className="flex items-center gap-3"><SwitchPrimitive.Root {...props} id={ids.controlId} aria-describedby={ids.describedBy} aria-invalid={ids.invalid || undefined} className={cn("relative h-6 w-11 rounded-full bg-border-strong outline-none focus-visible:ring-2 focus-visible:ring-accent data-[state=checked]:bg-accent disabled:opacity-50", className)}><SwitchPrimitive.Thumb className="block size-5 translate-x-0.5 rounded-full bg-surface shadow transition-transform data-[state=checked]:translate-x-[22px]" /></SwitchPrimitive.Root>{label ? <label htmlFor={ids.controlId} className="text-sm font-medium">{label}</label> : null}</div><FieldMessages hint={hint} error={error} hintId={ids.hintId} errorId={ids.errorId} /></div>;
}

export function RadioGroup({ label, hint, error, id, className, ...props }: DescribedControl & ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>) {
  const ids = useFieldIds(id, hint, error);
  return <div className="space-y-2">
    {label ? <p id={`${ids.controlId}-label`} className="text-sm font-semibold">{label}</p> : null}
    <RadioGroupPrimitive.Root {...props} id={ids.controlId} aria-labelledby={label ? `${ids.controlId}-label` : undefined} aria-describedby={ids.describedBy} aria-invalid={ids.invalid || undefined} className={className} />
    <FieldMessages hint={hint} error={error} hintId={ids.hintId} errorId={ids.errorId} />
  </div>;
}
export const RadioGroupItem = forwardRef<React.ElementRef<typeof RadioGroupPrimitive.Item>, ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>>(function RadioGroupItem({ className, ...props }, ref) {
  return <RadioGroupPrimitive.Item {...props} ref={ref} className={cn("grid size-5 place-items-center rounded-full border border-border-strong bg-surface focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50", className)}><RadioGroupPrimitive.Indicator className="size-2.5 rounded-full bg-accent" /></RadioGroupPrimitive.Item>;
});

export function Slider({ label, hint, error, id, className, ...props }: DescribedControl & ComponentPropsWithoutRef<typeof SliderPrimitive.Root>) {
  const ids = useFieldIds(id, hint, error);
  return <div className="space-y-2">{label ? <label id={`${ids.controlId}-label`} className="block text-sm font-semibold">{label}</label> : null}<SliderPrimitive.Root {...props} id={ids.controlId} aria-labelledby={label ? `${ids.controlId}-label` : undefined} aria-describedby={ids.describedBy} className={cn("relative flex h-8 w-full touch-none items-center", className)}><SliderPrimitive.Track className="relative h-1.5 grow rounded-full bg-border"><SliderPrimitive.Range className="absolute h-full rounded-full bg-accent" /></SliderPrimitive.Track>{(props.value ?? props.defaultValue ?? [0]).map((_, index) => <SliderPrimitive.Thumb key={index} aria-label={label || "Range slider"} aria-describedby={ids.describedBy} className="block size-5 rounded-full border-2 border-accent bg-surface shadow focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50" />)}</SliderPrimitive.Root><FieldMessages hint={hint} error={error} hintId={ids.hintId} errorId={ids.errorId} /></div>;
}

export const SelectValue = SelectPrimitive.Value;
