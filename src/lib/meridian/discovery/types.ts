/**
 * Contracts and Types for Organic Discovery Stack
 */

export type DiscoverySourceTier = "graph_api" | "vendor" | "cyclone_scout" | "bulk_upload";

export interface DiscoveredAudioTrend {
  id: string;
  name: string;
  isTrending: boolean;
  reelCount?: number;
  originalCreatorHandle?: string;
  firstSeenAt: string;
}

export interface DiscoveredReelItem {
  id: string;
  permalink?: string;
  externalPostId?: string;
  creatorHandle: string;
  creatorFollowerCount?: number;
  creatorLast30MedianViews?: number;
  creatorVariance?: number;
  niche: string;
  caption: string;
  hashtags: string[];
  audio: DiscoveredAudioTrend;
  durationMs?: number;
  postedAt?: string;
  discoveredAt: string;
  discoveryTier: DiscoverySourceTier;
  scoutDeviceId?: string;
  metrics: {
    views?: number;
    likes?: number;
    comments?: number;
    shares?: number;
    saves?: number;
  };
}

export interface PostSnapshot {
  postId: string;
  hoursSincePost: number;
  views: number;
  likes: number;
  comments: number;
  shares?: number;
  saves?: number;
  friendTagComments: number;
  capturedAt: string;
}

export interface VelocityAnalysis {
  hoursElapsed: number;
  viewsGainPerHour: number;
  accelerationScore: number; // derivative of views slope
  isExploding: boolean;
}
