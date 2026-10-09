import { z } from "zod";

export const studioGenerationSchema = z.object({
  imageProvider: z.enum(["none", "test:image", "google:nano-banana"]),
  videoProvider: z.enum(["hypit", "none", "auto", "manual_cloud", "veo", "higgsfield", "omni", "google_omni", "test:video"]),
  mode: z.enum(["research_only", "image_ad", "organic_image", "carousel", "video_reel_short", "video", "mixed_format", "mixed_campaign"]).optional(),
  source: z.enum(["new_brief", "winning_reference", "winning_organic_reel", "winning_ad", "meridian_creative", "brand_assets", "brand_asset_library", "creator_ugc_footage", "website_product_page"]).optional(),
  productionMode: z.enum(["manual_cloud", "automated_provider", "reuse_edit_assets", "edit_existing_assets", "automated_remote", "hybrid", "image_carousel_render"]).optional(),
  aspectRatio: z.enum(["9:16", "16:9", "1:1", "4:5"]).optional(),
});

export type StudioGeneration = z.infer<typeof studioGenerationSchema>;

