import type { StudioSession } from "@/lib/meridian/studio/session.server";

/** Types read from the stored studio session. They describe the server payload; nothing here adds data. */
export type StudioData = StudioSession;
export type StudioVariant = StudioSession["variants"][number];
export type StudioQuestion = StudioVariant["questions"][number];
export type StudioBrief = StudioSession["briefs"][number];
export type StudioRecommendation = NonNullable<StudioSession["recommendation"]>;
export type StudioPattern = StudioSession["learned"][number];
export type StudioPublication = StudioSession["publications"][number];

/** One receipt from a publish. externalId is the publisher's id, stored on the server, when the publisher returns one. */
export type PublishReceipt = {
  channelId: string;
  platform: string;
  type: string;
  status: string;
  url?: string;
  error?: string;
  externalId?: string;
};
