// The engine's API gateway: one place for routing, credentials, authentication and the network (owner decision 2026-10-14).

export * from "./types.ts";
export { DEFAULT_PROVIDERS, PROVIDER_IDS, isProviderId, type ProviderId, type ProviderRegistry } from "./providers.ts";
export { Gateway, createGateway, type GatewayCall, type GatewayOptions, type GatewayResult, type ResolvedRoute } from "./gateway.ts";
export { bodyText, httpError, jsonBody } from "./errors.ts";
export { openRouterGenerationBill, type GenerationBill } from "./generation.ts";
export { paidCall, type BudgetStore, type LockableLedger, type PaidCallInput, type PaidCallOutcome, type PaidRun } from "./paid.ts";
export {
  callTelemetryOf,
  keepCallTelemetry,
  newProbe,
  probeRequests,
  usdUpToFour,
  type CallTelemetry,
  type CallTelemetryRecord,
  type CallTelemetryStore,
  type RequestProbe,
  type RequestSample,
} from "./telemetry.ts";
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
export {
  CATALOG_SOURCES,
  CATALOG_VIDEO_CLASSES,
  VIDEO_SECOND_SKUS,
  modelCatalogCache,
  parseModelsCatalog,
  parseVideoCatalog,
  readModelCatalog,
  type CatalogDrop,
  type CatalogFailure,
  type CatalogRead,
  type CatalogSource,
  type ModelCatalog,
  type ModelCatalogSource,
} from "./catalog.ts";
export {
  ESTIMABLE_UNITS,
  REJECTION_REASONS,
  eligibleCandidates,
  isTimedClass,
  rankCandidates,
  rejectionOf,
  type CandidateFit,
  type CandidateRejection,
  type ModelNeed,
  type RejectionReason,
} from "./catalog-fit.ts";
export { meridianCredentialSource, type MeridianResolver } from "./meridian.ts";
export { fetchHttpTransport } from "./transport.ts";
export { textTransport } from "./text.ts";
