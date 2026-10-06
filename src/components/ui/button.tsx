import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-fg hover:brightness-95",
        secondary: "border border-border-strong bg-surface text-fg hover:bg-surface-2",
        quiet: "text-fg hover:bg-surface-2",
        ghost: "text-fg hover:bg-surface-2",
        danger: "border border-danger bg-surface text-danger hover:bg-danger-soft",
        link: "text-accent underline-offset-4 hover:underline",
      },
      size: {
        sm: "min-h-8 px-3 text-xs",
        md: "min-h-10 px-4 text-sm",
        lg: "min-h-11 px-5 text-sm",
      },
    },
    defaultVariants: { variant: "primary", size: "lg" },
  },
);

export type ButtonVariant = VariantProps<typeof buttonVariants>;
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, ButtonVariant {
  asChild?: boolean;
  loading?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { asChild = false, variant, size, loading = false, leftIcon, rightIcon, className, disabled, children, ...props },
  ref,
) {
  const Component = asChild ? Slot : "button";
  return (
    <Component
      {...props}
      ref={ref}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(buttonVariants({ variant, size }), "max-sm:min-h-11", className)}
    >
      {loading ? <span aria-hidden="true" className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent" /> : leftIcon}
      {children}
      {rightIcon}
    </Component>
  );
});

export { buttonVariants };
