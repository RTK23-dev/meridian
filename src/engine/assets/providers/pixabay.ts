// Pixabay stock video (PROVIDER_APIS.md "Pixabay"). GET /videos/ with the key as the `key` query parameter, which the gateway adds
// only on Pixabay's own host. Candidates must be portrait, long enough, and offered at 1080 pixels or more in a size the
// response lists. The page URL and the author (user) are kept with every clip. Pixabay has no author URL in the listing.

import { z } from "zod";
import type { ProviderError } from "../../contracts/assets.ts";
import type { Gateway } from "../../gateway/gateway.ts";
import { jsonBody } from "../../gateway/errors.ts";
import { callProvider, ensureOk, type AdapterConnection } from "../adapter.ts";
import { classifyError, ProviderCallError } from "../classify.ts";
import { normaliseHttpsUrl } from "../normalise.ts";
import type { StockClip, StockProvider, StockSearch } from "../stock.ts";

const PROVIDER = "pixabay";
export const PIXABAY_TIMEOUT_MS = 30_000;
const PER_PAGE = 20;
const MIN_WIDTH = 1080;
const MIN_HEIGHT = 1920;
/** The sizes to try, largest first. The listing offers them by name. */
const SIZES = ["large", "medium", "small"] as const;

const fileSchema = z.looseObject({ url: z.string(), width: z.number().int().positive(), height: z.number().int().positive() });

const hitSchema = z.looseObject({
  id: z.number().int().nonnegative(),
  pageURL: z.string(),
  duration: z.number().nonnegative(),
  user: z.string().min(1),
  videos: z.looseObject({
    large: fileSchema.optional(),
    medium: fileSchema.optional(),
    small: fileSchema.optional(),
  }),
});

const searchSchema = z.looseObject({ hits: z.array(z.unknown()) });

/** Pixabay's answer to clips the engine can use, with attribution. Clips that do not fit are rejected, not repaired. */
export function pixabayClips(body: unknown, minDurationMs: number): { clips: StockClip[]; rejected: number } {
  const search = searchSchema.safeParse(body);
  if (!search.success) return { clips: [], rejected: 0 };
  const clips: StockClip[] = [];
  let rejected = 0;
  for (const raw of search.data.hits) {
    const parsed = hitSchema.safeParse(raw);
    if (!parsed.success) {
      rejected += 1;
      continue;
    }
    const hit = parsed.data;
    const page = normaliseHttpsUrl(hit.pageURL);
    const file = SIZES.map((size) => ({ size, file: hit.videos[size] })).find(
      (candidate) =>
        candidate.file !== undefined &&
        candidate.file.height >= MIN_HEIGHT &&
        candidate.file.width >= MIN_WIDTH &&
        candidate.file.height > candidate.file.width &&
        normaliseHttpsUrl(candidate.file.url).ok,
    )?.file;
    if (!page.ok || file === undefined || hit.duration * 1000 < minDurationMs) {
      rejected += 1;
      continue;
    }
    const download = normaliseHttpsUrl(file.url);
    if (!download.ok) {
      rejected += 1;
      continue;
    }
    clips.push({
      vendor: PROVIDER,
      clipId: String(hit.id),
      sourceUrl: page.value,
      author: { name: hit.user, url: null },
      licence: { status: "unverified", pageUrl: null },
      downloadUrl: download.value,
      width: file.width,
      height: file.height,
      durationMs: Math.round(hit.duration * 1000),
    });
  }
  return { clips, rejected };
}

export function pixabayStockProvider(options: { gateway: Gateway }): StockProvider {
  const { gateway } = options;
  return {
    providerId: PROVIDER,

    async connection(organizationId: string | null): Promise<AdapterConnection> {
      const connection = await gateway.connection(PROVIDER, organizationId);
      return connection.connected ? { connected: true } : { connected: false, reason: connection.reason ?? "Pixabay is not connected" };
    },

    async search(query: string, search: { minDurationMs: number; organizationId: string | null }): Promise<StockSearch> {
      try {
        const params = new URLSearchParams({
          q: query,
          video_type: "film",
          min_width: String(MIN_WIDTH),
          min_height: String(MIN_HEIGHT),
          safesearch: "true",
          per_page: String(PER_PAGE),
          page: "1",
        });
        const response = await callProvider(gateway, {
          provider: PROVIDER,
          organizationId: search.organizationId,
          method: "GET",
          path: `/videos/?${params.toString()}`,
          timeoutMs: PIXABAY_TIMEOUT_MS,
        });
        ensureOk(response);
        const { clips } = pixabayClips(jsonBody(PROVIDER, response), search.minDurationMs);
        return { status: "ok", clips };
      } catch (error) {
        const providerError: ProviderError = error instanceof ProviderCallError ? error.providerError : classifyError(error);
        return { status: "failed", error: providerError };
      }
    },
  };
}
