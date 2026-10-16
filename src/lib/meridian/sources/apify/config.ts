// Configuration of Instagram discovery at volume (Factory Gather). Every number here is an initial value, not a measured one,
// except where a comment says the docs fixed it. The owner reviews them with the first live run.
//
// Caps are counts of results asked of Apify, not of rows stored, so a retried or repeated run cannot overrun a week.
// A cost is a USD figure only once the owner confirms the plan price; until then it is null and no cost is estimated.

export const INSTAGRAM_VOLUME_CONFIG = {
  /** The Apify actors, by the id the API takes ("owner~name"). Verified against docs.apify.com (PROVIDER_APIS.md). */
  actors: {
    /** Niche search by hashtag (apify/instagram-hashtag-scraper). */
    niche: "apify~instagram-hashtag-scraper",
    /** A creator's recent reels, or one reel by its URL (apify/instagram-reel-scraper). */
    creator: "apify~instagram-reel-scraper",
  },
  /** Candidates one gather run may ask for, across all of the niche's hashtags. */
  candidatesPerRun: 1000,
  /**
   * Results asked of Apify per niche in any rolling seven days, across every run: candidates, creator baselines and snapshots alike.
   * Initial value. A run of this many candidates uses the whole cap, so the baselines and snapshots that follow it are refused until its
   * requests are seven days old, unless the owner sets a higher cap.
   */
  candidatesPerWeek: 1000,
  /** Hashtags one run searches. A niche with more terms uses only the first five. */
  maxHashtagsPerRun: 5,
  /** Reels in a creator's baseline: the median of the creator's last 30 reels. */
  creatorBaselineReels: 30,
  /** Fewer reels with a view count than this and the creator's median is null (not rated). Initial value. */
  minimumBaselineViews: 10,
  /** Creators whose baseline one run fetches. Creators beyond it are not rated in that run. Initial value. */
  maxCreatorBaselinesPerRun: 40,
  /** A creator's baseline is reused for this many days before it is fetched again. */
  baselineReuseDays: 7,
  /** Snapshots after discovery, in hours. The 0-hour snapshot is the observation made by the gather run itself. */
  snapshotHours: [24, 72] as const,
  /** The Apify run's own time limit in seconds. Apify's synchronous endpoint answers 408 after 300 seconds. */
  timeoutSeconds: 300,
  /** The transport's own deadline, longer than the Apify limit so Apify's answer arrives first. */
  transportTimeoutMs: 320_000,
  /** USD per 1,000 results. Null until the owner confirms the plan price. Never a guess. */
  costPer1000ResultsUsd: null as number | null,
} as const;

export type InstagramVolumeCheckpoint = (typeof INSTAGRAM_VOLUME_CONFIG.snapshotHours)[number];
