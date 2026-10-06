import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type CardProps = HTMLAttributes<HTMLElement> & { elevation?: "flat" | "raised" | "floating" };
export const Card = forwardRef<HTMLElement, CardProps>(function Card({ elevation = "flat", className, ...props }, ref) {
  const elevations = { flat: "border border-border bg-surface", raised: "border border-border bg-surface shadow-sm", floating: "border border-border bg-surface shadow-md" };
  return <section {...props} ref={ref} className={cn("rounded-lg p-5", elevations[elevation], className)} />;
});

export const CardHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function CardHeader({ className, ...props }, ref) { return <div {...props} ref={ref} className={cn("mb-4 space-y-1", className)} />; });
export const CardTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(function CardTitle({ className, ...props }, ref) { return <h2 {...props} ref={ref} className={cn("font-display text-xl text-fg", className)} />; });
export const CardDescription = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(function CardDescription({ className, ...props }, ref) { return <p {...props} ref={ref} className={cn("text-sm text-fg-muted", className)} />; });
export const CardContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function CardContent({ className, ...props }, ref) { return <div {...props} ref={ref} className={cn(className)} />; });
export const CardFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function CardFooter({ className, ...props }, ref) { return <div {...props} ref={ref} className={cn("mt-4 flex items-center gap-2 border-t border-border pt-4", className)} />; });
