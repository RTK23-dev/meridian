import { embedText, LEXICAL_EMBEDDING, NEURAL_EMBEDDING } from "../semantic/lexical.ts";

export type ProviderOutcome<T> =
  | { status: "AVAILABLE" | "CONNECTED"; value: T }
  | { status: "NOT_CONNECTED" | "FAILED" | "DISABLED"; value: null; detail: string };

/** No ad library is connected. This must not invent records. */
export function collectAdLibrary(): ProviderOutcome<never[]> {
  return {
    status: "NOT_CONNECTED",
    value: null,
    detail: "No ad-library source is connected. No ads were collected.",
  };
}

/** No platform publisher is connected. This must not report a successful publish. */
export function publishCreative(): ProviderOutcome<{ externalId: string }> {
  return {
    status: "NOT_CONNECTED",
    value: null,
    detail: "No publishing provider is connected. The creative was not sent anywhere.",
  };
}

export function generateVideo(): ProviderOutcome<{ url: string }> {
  return {
    status: "NOT_CONNECTED",
    value: null,
    detail: "This function does not call a video model. Studio uses the xAI adapter only when XAI_API_KEY is set, and stores a clip only after bytes return. No clip was generated.",
  };
}

export function collectPerformanceFeed(): ProviderOutcome<never[]> {
  return {
    status: "NOT_CONNECTED",
    value: null,
    detail: "No performance feed is connected. No metrics were imported.",
  };
}

export function embedNeural(): ProviderOutcome<number[]> {
  return {
    status: NEURAL_EMBEDDING.status,
    value: null,
    detail: NEURAL_EMBEDDING.note,
  };
}

export function embedLexical(text: string): ProviderOutcome<number[]> {
  return {
    status: LEXICAL_EMBEDDING.status,
    value: embedText(text),
  };
}

/** Publishing stays off at every automation level until a real provider exists. */
export function mayAutoPublish(_level: string): false {
  return false;
}
