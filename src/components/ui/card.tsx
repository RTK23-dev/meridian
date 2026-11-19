import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "./cn";

type CardProps = HTMLAttributes<HTMLElement> & { elevation?: "flat" | "raised" | "floating" };
export const Card = forwardRef<HTMLElement, CardProps>(function Card({ elevation = "raised", className, ...props }, ref) {
  // A tile on the room: flat has no shadow, raised lifts a little, floating sits on the overlay surface and lifts most.
  const surfaces = { flat: "surface-flat border border-hairline", raised: "surface-tile border border-hairline", floating: "surface-dialog border border-hairline" };
  return <section {...props} ref={ref} className={cn("p-4 sm:p-6", surfaces[elevation], className)} />;
});

export const CardHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function CardHeader({ className, ...props }, ref) { return <div {...props} ref={ref} className={cn("mb-4 space-y-1", className)} />; });
export const CardTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(function CardTitle({ className, ...props }, ref) { return <h2 {...props} ref={ref} className={cn("text-heading font-semibold text-fg-primary", className)} />; });
export const CardDescription = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(function CardDescription({ className, ...props }, ref) { return <p {...props} ref={ref} className={cn("text-small text-fg-muted", className)} />; });
export const CardContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function CardContent({ className, ...props }, ref) { return <div {...props} ref={ref} className={cn(className)} />; });
export const CardFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function CardFooter({ className, ...props }, ref) { return <div {...props} ref={ref} className={cn("mt-4 flex items-center gap-2 border-t border-hairline pt-4", className)} />; });
