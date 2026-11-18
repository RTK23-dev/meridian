import { Slot, Slottable } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "./cn";
import { LoadingMark } from "./loading-mark";

const focus = "focus-visible:outline-2 focus-visible:outline-offset-2";
const quiet = `border-transparent bg-transparent text-fg-secondary hover:bg-raised hover:text-fg-primary active:bg-overlay focus-visible:outline-accent disabled:text-fg-muted ${focus}`;
// Katana canvas (owner direction 2026-11-18): every button is a pill. The main action is ink, black on the light room and white on the
// dark one, as in the owner's reference; the accent marks state (the selected tab, a badge, the focus ring), not the action.

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full border text-button font-semibold transition-colors duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)] disabled:pointer-events-none disabled:cursor-not-allowed",
  {
    variants: {
      variant: {
        primary: `border-white-accent bg-white-accent text-ground hover:border-fg-secondary hover:bg-fg-secondary active:bg-fg-secondary focus-visible:outline-accent disabled:border-hairline disabled:bg-transparent disabled:text-fg-muted ${focus}`,
        secondary: `border-hairline bg-raised text-fg-primary hover:border-border-strong hover:bg-overlay active:bg-overlay focus-visible:outline-accent disabled:border-hairline disabled:bg-transparent disabled:text-fg-muted ${focus}`,
        quiet,
        danger: `border-danger bg-transparent text-danger hover:bg-raised active:bg-overlay focus-visible:outline-accent disabled:border-hairline disabled:text-fg-muted ${focus}`,
        ghost: quiet,
        link: `border-transparent bg-transparent text-fg-primary underline underline-offset-4 hover:no-underline focus-visible:outline-accent ${focus}`,
      },
      size: {
        sm: "min-h-10 px-3",
        md: "min-h-10 px-4",
        lg: "min-h-10 px-5",
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
      className={cn(buttonVariants({ variant, size }), "max-sm:min-h-11 pointer-coarse:min-h-11", className)}
    >
      {loading ? <LoadingMark size={16} label="Working" /> : leftIcon}
      {asChild ? <Slottable>{children}</Slottable> : children}
      {rightIcon}
    </Component>
  );
});

export { buttonVariants };
