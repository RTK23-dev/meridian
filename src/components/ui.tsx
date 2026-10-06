import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
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

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <Input {...props} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <Textarea {...props} />;
}

export function SelectInput({ className, id, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  const ids = useFieldIds(id, undefined, undefined);
  return <select {...props} id={ids.controlId} aria-describedby={ids.describedBy} aria-invalid={ids.invalid || undefined} className={cn("w-full rounded-md border border-border-strong bg-surface px-3 py-3 text-base text-fg outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-55", className)} />;
}

export function Notice({ children }: { children: ReactNode }) {
  return <ErrorNotice>{children}</ErrorNotice>;
}

export { cn };
