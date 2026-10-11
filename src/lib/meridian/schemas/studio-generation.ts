import { z } from "zod";

/**
 * The video choices a Studio run accepts. The Generate step offers google_omni, hypit, manual_cloud and none (provider-options.ts).
 * "auto" and "omni" are aliases that the server maps to google_omni (studio/actions.ts and studio/session.server.ts).
 *
 * "higgsfield" is not accepted. A studio video targets 8 seconds, and the Higgsfield model runs only 5, 10 and 15 seconds, so
 * resolveProductionTarget refuses it before any job exists. "test:video" is a fixture for the testing loop, and no provider of
 * that name is registered for a studio run.
 */
export const VIDEO_PROVIDER_CHOICES = ["google_omni", "hypit", "manual_cloud", "none", "auto", "omni"] as const;

export const studioGenerationSchema = z.object({
  imageProvider: z.enum(["none", "test:image", "google:nano-banana"]),
  videoProvider: z.enum(VIDEO_PROVIDER_CHOICES),
  creationScope: z.enum(["auto_choose", "image_only", "video_only", "carousel_only", "mixed_campaign", "research_only"]).optional(),
  autonomy: z.enum(["manual", "semi_automatic", "fully_automatic"]).optional(),
  maxSpendUsd: z.number().finite().nonnegative().max(1000).optional(),
  mode: z.enum(["auto_choose", "research_only", "image_ad", "organic_image", "carousel", "video_reel_short", "video", "mixed_format", "mixed_campaign"]).optional(),
  source: z.enum(["new_brief", "winning_reference", "winning_organic_reel", "winning_ad", "meridian_creative", "brand_assets", "brand_asset_library", "creator_ugc_footage", "website_product_page", "creator_footage", "existing_meridian_creative"]).optional(),
  productionMode: z.enum(["manual_cloud", "automated_provider", "reuse_edit_assets", "edit_existing_assets", "automated_remote", "hybrid", "image_carousel_render"]).optional(),
  aspectRatio: z.enum(["9:16", "16:9", "1:1", "4:5"]).optional(),
});

export type StudioGeneration = z.infer<typeof studioGenerationSchema>;

export const serverStudioGenerationSchema = studioGenerationSchema.extend({
  brandId: z.string().min(1, "Brand ID is required"),
  briefId: z.string().min(1, "Brief ID is required"),
});

export type ServerStudioGeneration = z.infer<typeof serverStudioGenerationSchema>;

