// The engine's API gateway: one place for routing, credentials, authentication and the network (owner decision 2026-10-14).

export * from "./types.ts";
export { DEFAULT_PROVIDERS, PROVIDER_IDS, isProviderId, type ProviderId, type ProviderRegistry } from "./providers.ts";
export { Gateway, createGateway, type GatewayCall, type GatewayOptions, type GatewayResult, type ResolvedRoute } from "./gateway.ts";
export { bodyText, httpError, jsonBody } from "./errors.ts";
export { paidCall, type PaidCallInput, type PaidCallOutcome, type PaidRun } from "./paid.ts";
export {
  StructuredOutputError,
  jsonSchemaFor,
  pollVideo,
  structuredChat,
  submitVideo,
  verifyRoutes,
  type ChatMessage,
  type ChatUsage,
  type ContentPart,
  type StructuredChatInput,
  type StructuredChatResult,
  type VideoSubmitInput,
} from "./openrouter.ts";
export { meridianCredentialSource, type MeridianResolver } from "./meridian.ts";
export { fetchHttpTransport } from "./transport.ts";
export { textTransport } from "./text.ts";
