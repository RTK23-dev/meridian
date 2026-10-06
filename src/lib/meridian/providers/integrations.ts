export type IntegrationStatus = "CONNECTED" | "AVAILABLE" | "NOT_CONNECTED" | "FAILED" | "DISABLED";

/** Static contracts. Runtime keys are checked by the provider modules, not here. */
export const INTEGRATIONS = [
  {
    id: "ad_library",
    status: "NOT_CONNECTED" as const,
    detail: "No ad-library connector is implemented. Competitor rows come only from what a person records.",
  },
  {
    id: "meta_publish",
    status: "NOT_CONNECTED" as const,
    detail: "Nothing is published to Meta.",
  },
  {
    id: "tiktok_publish",
    status: "NOT_CONNECTED" as const,
    detail: "Nothing is published to TikTok.",
  },
  {
    id: "neural_embedding",
    status: "NOT_CONNECTED" as const,
    detail: "No neural embedding model is configured.",
  },
  {
    id: "lexical_similarity",
    status: "AVAILABLE" as const,
    detail: "Token hashing over stored text. It is not a semantic model.",
  },
  {
    id: "performance_feed",
    status: "NOT_CONNECTED" as const,
    detail: "Performance is entered by hand into the same observation table a connector would use.",
  },
  {
    id: "video",
    status: "NOT_CONNECTED" as const,
    detail: "No video provider is connected. No clip is generated.",
  },
] as const satisfies readonly { id: string; status: IntegrationStatus; detail: string }[];
