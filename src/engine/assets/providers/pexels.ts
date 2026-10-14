// Pexels stock video (PROVIDER_APIS.md "Pexels"). GET /videos/search with the key in the Authorization header, which the gateway
// adds. Candidates must be portrait, long enough, and offered as an mp4 file at 1080 pixels or more; the page URL and the author
// are kept with every clip. HLS streams are not used.

import { z } from "zod";
import type { ProviderError } from "../../contracts/assets.ts";
import type { Gateway } from "../../gateway/gateway.ts";
import { jsonBody } from "../../gateway/errors.ts";
import { callProvider, ensureOk, type AdapterConnection } from "../adapter.ts";
import { classifyError, ProviderCallError } from "../classify.ts";
import { normaliseHttpsUrl } from "../normalise.ts";
import type { StockClip, StockProvider, StockSearch } from "../stock.ts";

const PROVIDER = "pexels";
export const PEXELS_TIMEOUT_MS = 30_000;
const PER_PAGE = 15;
const MIN_FILE_HEIGHT = 1080;
const OUTPUT_HEIGHT = 1920;

const fileSchema = z.looseObject({
  quality: z.string(),
  file_type: z.string(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  link: z.string(),
});

const videoSchema = z.looseObject({
  id: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  duration: z.number().nonnegative(),
  url: z.string(),
  user: z.looseObject({ name: z.string().min(1), url: z.string().optional() }),
  video_files: z.array(fileSchema),
});

const searchSchema = z.looseObject({ videos: z.array(z.unknown()) });

/** The file to fetch for a clip: an hd or sd mp4 at 1080 pixels or more, closest to the 1920 output height. Null when none. */
function pickFile(files: z.infer<typeof fileSchema>[]): { link: string; height: number } | null {
  const usable = files
    .filter((file) => (file.quality === "hd" || file.quality === "sd") && file.file_type === "video/mp4")
    .filter((file) => file.height !== undefined && file.width !== undefined && file.height >= MIN_FILE_HEIGHT && file.height > file.width)
    .filter((file) => normaliseHttpsUrl(file.link).ok)
    .sort((a, b) => {
      const aHd = a.quality === "hd" ? 0 : 1;
      const bHd = b.quality === "hd" ? 0 : 1;
      if (aHd !== bHd) return aHd - bHd;
      return Math.abs((a.height ?? 0) - OUTPUT_HEIGHT) - Math.abs((b.height ?? 0) - OUTPUT_HEIGHT);
    });
  const best = usable[0];
  if (best === undefined || best.height === undefined) return null;
  const link = normaliseHttpsUrl(best.link);
  return link.ok ? { link: link.value, height: best.height } : null;
}

/** Pexels' answer to clips the engine can use, with attribution. Clips that do not fit are rejected, not repaired. */
export function pexelsClips(body: unknown, minDurationMs: number): { clips: StockClip[]; rejected: number } {
  const search = searchSchema.safeParse(body);
  if (!search.success) return { clips: [], rejected: 0 };
  const clips: StockClip[] = [];
  let rejected = 0;
  for (const raw of search.data.videos) {
    const parsed = videoSchema.safeParse(raw);
    if (!parsed.success) {
      rejected += 1;
      continue;
    }
    const video = parsed.data;
    const page = normaliseHttpsUrl(video.url);
    const file = pickFile(video.video_files);
    if (!page.ok || file === null || video.height <= video.width || video.duration * 1000 < minDurationMs) {
      rejected += 1;
      continue;
    }
    clips.push({
      vendor: PROVIDER,
      clipId: String(video.id),
      sourceUrl: page.value,
      author: { name: video.user.name, url: video.user.url !== undefined && normaliseHttpsUrl(video.user.url).ok ? video.user.url : null },
      licence: { status: "unverified", pageUrl: null },
      downloadUrl: file.link,
      width: video.width,
      height: video.height,
      durationMs: Math.round(video.duration * 1000),
    });
  }
  return { clips, rejected };
}

export function pexelsStockProvider(options: { gateway: Gateway }): StockProvider {
  const { gateway } = options;
  return {
    providerId: PROVIDER,

    async connection(organizationId: string | null): Promise<AdapterConnection> {
      const connection = await gateway.connection(PROVIDER, organizationId);
      return connection.connected ? { connected: true } : { connected: false, reason: connection.reason ?? "Pexels is not connected" };
    },

    async search(query: string, search: { minDurationMs: number; organizationId: string | null }): Promise<StockSearch> {
      try {
        const params = new URLSearchParams({
          query,
          orientation: "portrait",
          size: "medium",
          per_page: String(PER_PAGE),
          page: "1",
        });
        const response = await callProvider(gateway, {
          provider: PROVIDER,
          organizationId: search.organizationId,
          method: "GET",
          path: `/videos/search?${params.toString()}`,
          timeoutMs: PEXELS_TIMEOUT_MS,
        });
        ensureOk(response);
        const { clips } = pexelsClips(jsonBody(PROVIDER, response), search.minDurationMs);
        return { status: "ok", clips };
      } catch (error) {
        const providerError: ProviderError = error instanceof ProviderCallError ? error.providerError : classifyError(error);
        return { status: "failed", error: providerError };
      }
    },
  };
}
