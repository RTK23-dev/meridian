import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { Button as DesignButton } from "./ui/button";
import { Card } from "./ui/card";
import { Field as DesignField, useFieldIds } from "./ui/field";
import { ErrorNotice } from "./ui/feedback";
import { Input, Textarea } from "./ui/controls";
import type { ButtonProps } from "./ui/button";

export * from "./ui/index";
export function Button(props: ButtonProps) {
  return <DesignButton {...props} />;
}
export const Field = DesignField;
export { Card as Panel };

export function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Something went wrong.";
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput(props, ref) {
  return <Input ref={ref} {...props} />;
});

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea(props, ref) {
  return <Textarea ref={ref} {...props} />;
});

export function SelectInput({ className, id, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  const ids = useFieldIds(id, undefined, undefined);
  return <select {...props} id={ids.controlId} aria-describedby={ids.describedBy} aria-invalid={ids.invalid || undefined} className={cn("w-full rounded-md border border-border-strong bg-surface px-3 py-3 text-base text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-55", className)} />;
}

export function Notice({ children }: { children: ReactNode }) {
  return <ErrorNotice>{children}</ErrorNotice>;
}

export { cn };
