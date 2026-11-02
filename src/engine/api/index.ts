// The engine's API for Meridian (lead task I1 to I3). The Factory and the review inbox reach the engine through these functions
// only: start a request, read its status, read a delivered master, read the spend on its ledger, pause its reservations, list its
// open review items, and check that the engine can run at all. Nothing here calls a provider or reads a key: readiness asks the
// credential source whether a key is connected, and the answer never carries the secret.
//
// Fail closed: a request the engine cannot run is NOT_CONNECTED with its reasons, an unknown state is reported as it is, and no
// status is guessed. Tenancy: every read and write is scoped to the request's own workspace (organization_id).

export { requestProblems, startEngineRequest, engineRequestStatus, engineDeliveredMaster } from "./start.ts";
export type { StartInput, StartResult, EngineRequestStatus, DeliveredMaster } from "./start.ts";
export { remakeEngineShot, shotModelOptions, replaceShotWithClip, quoteEngineShotRemake, decideEngineShot, quoteEngineDecision, quoteEngineClip, takeOfShot, shotTakeLink, productionRemakePorts } from "./remake.ts";
export type { RemakeInput, ShotReplacement, RemakePorts, ClipShape, ReviewerClipInput, RemakeResult, ShotModelOptions, RemakeQuote, DecideInput, ShotTakeLink } from "./remake.ts";
export { engineSpendOf, pauseEngineSpend, reservationState } from "./spend.ts";
export type { EngineSpend } from "./spend.ts";
export { openEngineReviewItems } from "./review.ts";
export type { EngineReviewItem } from "./review.ts";
export { stagesNeeded, engineReadiness, productionReadinessPorts } from "./readiness.ts";
export type { EngineReadinessPorts, EngineReadiness } from "./readiness.ts";
export { engineRequestFeed } from "./feed.ts";
export type { FeedNodeStatus, FeedJobCounts, FeedGate, FeedDecision, FeedLedgerRow, FeedModelChoice, FeedShot, FeedArtifact, EngineRequestFeed, FeedShotRow } from "./feed.ts";
