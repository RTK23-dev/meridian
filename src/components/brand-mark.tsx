import { useState } from "react";
import { assetRoute } from "@/components/studio/asset-url.ts";
import { cn } from "@/components/ui/cn";

/**
 * A brand's logo from the asset route, or a neutral box with the brand's initial when no logo is stored. A logo that fails to
 * load falls back to the same box, so a broken image is never shown.
 */
export function BrandMark({ name, logoAssetId, className }: { name: string; logoAssetId: string | null; className?: string }) {
  const [failedId, setFailedId] = useState<string | null>(null);
  const initial = name.trim().slice(0, 1).toLocaleUpperCase() || "B";
  if (logoAssetId && failedId !== logoAssetId) {
    return (
      <img
        src={assetRoute(logoAssetId)}
        alt=""
        width={44}
        height={44}
        loading="lazy"
        decoding="async"
        onError={() => setFailedId(logoAssetId)}
        className={cn("size-11 shrink-0 rounded-sharp border border-hairline bg-raised object-contain p-1", className)}
      />
    );
  }
  return (
    <span aria-hidden="true" className={cn("grid size-11 shrink-0 place-items-center rounded-sharp border border-hairline bg-raised text-heading font-semibold text-fg-muted", className)}>
      {initial}
    </span>
  );
}
