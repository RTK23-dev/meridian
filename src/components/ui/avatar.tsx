import * as AvatarPrimitive from "@radix-ui/react-avatar";
import { cn } from "@/lib/cn";

export function Avatar({ src, alt = "", fallback, className }: { src?: string | null; alt?: string; fallback: string; className?: string }) {
  return <AvatarPrimitive.Root className={cn("relative grid size-10 shrink-0 place-items-center overflow-hidden rounded-full bg-surface-2 text-sm font-semibold text-fg", className)}>
    {src ? <AvatarPrimitive.Image src={src} alt={alt} className="size-full object-cover" /> : null}
    <AvatarPrimitive.Fallback aria-hidden="true" className="grid size-full place-items-center">{fallback.slice(0, 2).toUpperCase()}</AvatarPrimitive.Fallback>
  </AvatarPrimitive.Root>;
}

export function Logo({ src, alt = "Brand logo", className }: { src?: string | null; alt?: string; className?: string }) {
  return src ? <img src={src} alt={alt} className={cn("size-10 rounded-md border border-border object-contain", className)} /> : <div aria-label={`${alt} not uploaded`} role="img" className={cn("grid size-10 place-items-center rounded-md border border-border bg-surface-2 text-xs text-fg-muted", className)}>No logo</div>;
}
