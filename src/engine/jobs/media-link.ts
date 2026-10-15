// The media-link port (Bible 6.11, owner decision 2026-10-14). Shotstack fetches each source by URL, so a component-free EDL needs a
// short-lived https link for every media URI it plays. The engine never reads the environment and never signs: it takes a
// MediaLinkSigner, and the composition root passes Meridian's implementation (lib/meridian/storage/engine-media-link.ts), which
// fails closed without its secret or public origin. A signer that is not connected answers with its reason, and the reason reaches
// the caller as a NOT_CONNECTED config error, so the job stops with that reason and nothing is sent.

import { EngineError } from "../contracts/errors.ts";
import { notConnectedReason } from "../media/stt-connection.ts";

/** Shotstack's source links live 15 minutes (owner decision 2026-10-14). The signer refuses a longer one. */
export const ENGINE_MEDIA_LINK_TTL_SECONDS = 15 * 60;

/**
 * The signer's answer. ok carries the link. not_connected is a missing service (no secret, no public origin): it reaches the caller
 * as NOT_CONNECTED. refused is an input the signer will not link (a URI that is not an engine object of the organization): it is
 * invalid input, not a service fault, and nothing is signed.
 */
export type MediaLinkResult =
  | { status: "ok"; url: string }
  | { status: "not_connected"; reason: string }
  | { status: "refused"; reason: string };

/** Signs a short-lived https link to one object of an organization. Returns the link, or not_connected or refused with the reason. */
export interface MediaLinkSigner {
  sign(organizationId: string, objectKey: string, ttlSeconds: number): Promise<MediaLinkResult>;
}

/** A signer for a deployment with no media-link connection. It sends nothing and says why. */
export function notConnectedMediaLinks(reason: string): MediaLinkSigner {
  return { sign: async () => ({ status: "not_connected", reason }) };
}

/**
 * The source URL resolver of one organization: a media URI (an object key) becomes a 15-minute https link. A signer that is not
 * connected throws a config error whose message starts with NOT_CONNECTED. A URI the signer refuses is invalid input (it is not an
 * engine object, so Shotstack cannot be given a link for it). A link that is not https is refused too.
 */
export function sourceUrlResolver(input: { signer: MediaLinkSigner; organizationId: string; ttlSeconds?: number }): (uri: string) => Promise<string> {
  const ttl = input.ttlSeconds ?? ENGINE_MEDIA_LINK_TTL_SECONDS;
  return async (uri) => {
    const result = await input.signer.sign(input.organizationId, uri, ttl);
    if (result.status === "not_connected") {
      throw new EngineError("config", notConnectedReason(`the source media cannot be linked for Shotstack: ${result.reason}`), { stage: "render" });
    }
    if (result.status === "refused") {
      throw new EngineError("invalid_input", `the source media cannot be linked for Shotstack: ${result.reason}`, { stage: "render" });
    }
    if (!result.url.startsWith("https://")) {
      throw new EngineError("config", "the signed media link is not https, so Shotstack cannot fetch it", { stage: "render" });
    }
    return result.url;
  };
}
