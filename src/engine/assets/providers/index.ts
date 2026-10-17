// The adapter registry: which adapter serves a route. The route table (config/routes.ts) decides the provider and model; this file
// only maps a routed provider and capability to the adapter that speaks its API. A route with no adapter here is skipped by the
// router with a reason, so adding a vendor is one case here plus its file.

import type { Gateway, ResolvedRoute } from "../../gateway/gateway.ts";
import type { MediaStore, RoutedAdapter } from "../adapter.ts";
import type { StockProvider } from "../stock.ts";
import { isVideoClass, openRouterVideoAdapter, type VideoProfile } from "./openrouterVideo.ts";
import { openRouterImageAdapter } from "./openrouterImage.ts";
import { openRouterSpeechAdapter } from "./openrouterSpeech.ts";
import { avatarIvAdapter } from "./avatarIv.ts";
import { pexelsStockProvider } from "./pexels.ts";
import { pixabayStockProvider } from "./pixabay.ts";

export type AdapterContext = {
  gateway: Gateway;
  organizationId: string | null;
  workspaceId: string;
  media: MediaStore;
  /** Verified video profiles by model id, from GET /videos/models. A missing model is not connected. */
  videoProfiles: ReadonlyMap<string, VideoProfile>;
  /** The page's voice id for speech routes. Null means speech is not connected. */
  voice: string | null;
  /** The provider the page's voice belongs to (the voice kit's provider). Null means speech is not connected (contract v9 voice rule). */
  voiceProvider: string | null;
  /** The speaking rate for speech routes. */
  speechSpeed: number;
};

/** The adapter for one routed target of a generation capability, or null when no adapter speaks that route. */
export function adapterFor(route: ResolvedRoute, context: AdapterContext): RoutedAdapter | null {
  const provider = route.provider.id;
  if (provider === "openrouter") {
    if (isVideoClass(route.capability)) {
      const profile = route.model === null ? null : (context.videoProfiles.get(route.model) ?? null);
      return openRouterVideoAdapter({ gateway: context.gateway, organizationId: context.organizationId, route, profile });
    }
    if (route.capability === "image.keyframe" || route.capability === "image.edit") {
      return openRouterImageAdapter({
        gateway: context.gateway,
        organizationId: context.organizationId,
        workspaceId: context.workspaceId,
        route,
        media: context.media,
      });
    }
    if (route.capability === "tts") {
      return openRouterSpeechAdapter({
        gateway: context.gateway,
        organizationId: context.organizationId,
        workspaceId: context.workspaceId,
        route,
        media: context.media,
        voice: context.voice,
        voiceProvider: context.voiceProvider,
        speed: context.speechSpeed,
      });
    }
    if (route.capability === "avatar") return avatarIvAdapter(route);
  }
  return null;
}

/** The stock provider for one routed stock target, or null when there is no adapter for it. */
export function stockProviderFor(route: ResolvedRoute, gateway: Gateway): StockProvider | null {
  if (route.provider.id === "pexels") return pexelsStockProvider({ gateway });
  if (route.provider.id === "pixabay") return pixabayStockProvider({ gateway });
  return null;
}
