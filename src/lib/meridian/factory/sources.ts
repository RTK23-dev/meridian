export const FACTORY_SOURCES = [
  {
    id: "first_party_meta",
    label: "Your Meta ad account",
    implemented: true,
    licensed: true,
    note: "Full history with spend, CTR, hold rate and CPA. The only true winner data, and the base for every calibration.",
  },
  {
    id: "first_party_tiktok",
    label: "Your TikTok ad account",
    implemented: false,
    licensed: true,
    note: "Official TikTok marketing API. Not connected until a token is stored.",
  },
  {
    id: "first_party_google",
    label: "Your Google Ads account",
    implemented: false,
    licensed: true,
    note: "Official Google Ads API. Not connected until a token is stored.",
  },
  {
    id: "licensed_intelligence",
    label: "Licensed ad-intelligence provider",
    implemented: false,
    licensed: true,
    note: "Trial shortlist: Pathmatics / Sensor Tower and Ad Library alternatives that license video. No provider is connected.",
  },
  {
    id: "meta_ad_library",
    label: "Meta Ad Library metadata",
    implemented: true,
    licensed: false,
    note: "Official ads_archive API: text, dates, platforms, snapshot URL. Snapshot video download is off unless RESEARCH_SNAPSHOT_MEDIA=1.",
  },
  {
    id: "tiktok_creative_center",
    label: "TikTok Creative Center",
    implemented: false,
    licensed: false,
    note: "Official Creative Center tools only. Not scraped.",
  },
  {
    id: "bulk_upload",
    label: "Bulk upload",
    implemented: true,
    licensed: true,
    note: "A folder of videos or a CSV of links you already have rights to.",
  },
] as const;

export type FactorySourceId = (typeof FACTORY_SOURCES)[number]["id"];

export function snapshotMediaAllowed(env: { RESEARCH_SNAPSHOT_MEDIA?: string } = process.env): boolean {
  return env.RESEARCH_SNAPSHOT_MEDIA?.trim() === "1";
}
