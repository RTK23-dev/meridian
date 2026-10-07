export type ResearchYield = {
  niche: string;
  adsFound: number;
  videosDownloaded: number;
  transcriptsProduced: number;
  analysesCompleted: number;
  snapshotWithoutVideo: number;
  mediaFailed: number;
  snapshotMediaEnabled: boolean;
};

export function emptyYield(niche: string): ResearchYield {
  return {
    niche,
    adsFound: 0,
    videosDownloaded: 0,
    transcriptsProduced: 0,
    analysesCompleted: 0,
    snapshotWithoutVideo: 0,
    mediaFailed: 0,
    snapshotMediaEnabled: false,
  };
}

export function formatYield(row: ResearchYield): string {
  return `niche=${row.niche};ads=${row.adsFound};videos=${row.videosDownloaded};transcripts=${row.transcriptsProduced};analyses=${row.analysesCompleted};no_video=${row.snapshotWithoutVideo};media_failed=${row.mediaFailed};snapshot_media=${row.snapshotMediaEnabled ? "on" : "off"}`;
}

export function summarizeYields(rows: ResearchYield[]): {
  niches: number;
  adsFound: number;
  videosDownloaded: number;
  transcriptsProduced: number;
  videoHitRate: number | null;
} {
  const adsFound = rows.reduce((sum, row) => sum + row.adsFound, 0);
  const videosDownloaded = rows.reduce((sum, row) => sum + row.videosDownloaded, 0);
  const transcriptsProduced = rows.reduce((sum, row) => sum + row.transcriptsProduced, 0);
  return {
    niches: rows.length,
    adsFound,
    videosDownloaded,
    transcriptsProduced,
    videoHitRate: adsFound === 0 ? null : Math.round((videosDownloaded / adsFound) * 1000) / 1000,
  };
}
