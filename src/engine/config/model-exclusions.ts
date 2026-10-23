// Models a provider endpoint does not serve or does not accept, each with the reason and the check that showed it. An exclusion applies
// to one endpoint only: a model excluded on the video listing stays eligible on any other endpoint. There is no global blacklist, and a
// model is never excluded because of its vendor or name. The list is empty: no model is excluded today. Add an entry only with a
// reason that names the check (the listing read, the date, and what the endpoint said), and remove it when the check no longer holds.

/** The OpenRouter video listing, GET /api/v1/videos/models. The catalog parser names this endpoint when it applies an exclusion. */
export const OPENROUTER_VIDEO_LISTING = "openrouter:GET /api/v1/videos/models" as const;

export type ModelExclusion = {
  readonly endpoint: string;
  readonly model: string;
  readonly reason: string;
};

export const MODEL_EXCLUSIONS: readonly ModelExclusion[] = [];

/** The reason a model is excluded on one endpoint, or null when it is not. */
export function exclusionFor(endpoint: string, model: string, exclusions: readonly ModelExclusion[] = MODEL_EXCLUSIONS): string | null {
  return exclusions.find((item) => item.endpoint === endpoint && item.model === model)?.reason ?? null;
}
