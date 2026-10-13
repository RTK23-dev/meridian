import assert from "node:assert/strict";
import test from "node:test";
import {
  MEDIA_LINK_TTL_SECONDS,
  hostIsVerified,
  mediaDeliveryFor,
  mediaLinkSecret,
  publicMediaOrigin,
  signMediaLink,
  signedMediaUrl,
  tiktokVerifiedDomains,
  verifyMediaLink,
} from "./media-link.ts";

const SECRET = "x".repeat(40);
const OTHER_SECRET = "y".repeat(40);
const NOW = 1_800_000_000;

function signed(creativeId = "cr-1", now = NOW, secret = SECRET) {
  return signMediaLink({ creativeId, nowSeconds: now, secret });
}

function check(input: { creativeId?: string; expires?: string | number | null; sig?: string | null; secret?: string; now?: number }) {
  const token = signed(input.creativeId ?? "cr-1");
  return verifyMediaLink({
    creativeId: input.creativeId ?? "cr-1",
    expires: input.expires === undefined ? String(token.expires) : input.expires === null ? null : String(input.expires),
    sig: input.sig === undefined ? token.sig : input.sig,
    secret: input.secret ?? SECRET,
    nowSeconds: input.now ?? NOW,
  });
}

test("a link is valid for 15 minutes after it is signed", () => {
  assert.equal(MEDIA_LINK_TTL_SECONDS, 15 * 60);
  const token = signed();
  assert.equal(token.expires, NOW + 15 * 60);
  assert.equal(check({ now: NOW }), "ok");
  assert.equal(check({ now: NOW + 15 * 60 - 1 }), "ok");
});

test("a link at or after its expiry is expired, not valid", () => {
  assert.equal(check({ now: NOW + 15 * 60 }), "expired", "the expiry instant is already expired");
  assert.equal(check({ now: NOW + 3600 }), "expired");
});

test("a tampered creative id fails the signature", () => {
  const token = signed("cr-1");
  assert.equal(
    verifyMediaLink({ creativeId: "cr-2", expires: String(token.expires), sig: token.sig, secret: SECRET, nowSeconds: NOW }),
    "bad_signature",
  );
});

test("a tampered expiry fails the signature, so a link cannot be extended", () => {
  const token = signed();
  assert.equal(
    verifyMediaLink({ creativeId: "cr-1", expires: String(token.expires + 3600), sig: token.sig, secret: SECRET, nowSeconds: NOW }),
    "bad_signature",
  );
});

test("a tampered signature fails, and a signature from another secret fails", () => {
  const token = signed();
  const flipped = `${token.sig.slice(0, -1)}${token.sig.endsWith("0") ? "1" : "0"}`;
  assert.equal(check({ sig: flipped }), "bad_signature");
  assert.equal(check({ secret: OTHER_SECRET }), "bad_signature");
});

test("an expired link that was never signed is a bad signature, not an expiry", () => {
  assert.equal(check({ sig: "0".repeat(64), now: NOW + 3600 }), "bad_signature");
});

test("a missing or misshapen link is malformed", () => {
  assert.equal(check({ expires: null }), "malformed");
  assert.equal(check({ sig: null }), "malformed");
  assert.equal(check({ expires: "12abc" }), "malformed");
  assert.equal(check({ sig: "not-hex" }), "malformed");
  assert.equal(verifyMediaLink({ creativeId: "", expires: "1", sig: "0".repeat(64), secret: SECRET, nowSeconds: NOW }), "malformed");
});

test("the signature is bound to the creative id, so the same expiry does not verify another creative", () => {
  const token = signed("cr-1");
  assert.equal(
    verifyMediaLink({ creativeId: "cr-9", expires: String(token.expires), sig: token.sig, secret: SECRET, nowSeconds: NOW }),
    "bad_signature",
  );
});

test("the secret is read only when it is at least 32 characters", () => {
  assert.equal(mediaLinkSecret({} as NodeJS.ProcessEnv), null, "unset is not a secret");
  assert.equal(mediaLinkSecret({ MEDIA_LINK_SECRET: "short" } as NodeJS.ProcessEnv), null, "a short value never signs a link");
  assert.equal(mediaLinkSecret({ MEDIA_LINK_SECRET: `  ${"k".repeat(32)}  ` } as NodeJS.ProcessEnv), "k".repeat(32));
});

test("the public origin must be an https origin with no path", () => {
  assert.equal(publicMediaOrigin({} as NodeJS.ProcessEnv), null);
  assert.equal(publicMediaOrigin({ APP_URL: "https://app.example.test" } as NodeJS.ProcessEnv), "https://app.example.test");
  assert.equal(publicMediaOrigin({ APP_URL: "http://app.example.test" } as NodeJS.ProcessEnv), null, "plain http is never handed to a platform");
  assert.equal(publicMediaOrigin({ APP_URL: "https://app.example.test/path" } as NodeJS.ProcessEnv), null);
  assert.equal(publicMediaOrigin({ APP_URL: "http://127.0.0.1:8080" } as NodeJS.ProcessEnv), null, "a local origin cannot be fetched by a platform");
  assert.equal(
    publicMediaOrigin({ PUBLIC_APP_URL: "https://second.example.test" } as NodeJS.ProcessEnv),
    "https://second.example.test",
    "PUBLIC_APP_URL is the fallback when APP_URL is blank",
  );
});

test("the signed URL names the creative and carries only the expiry and the signature", () => {
  const url = signedMediaUrl({ origin: "https://app.example.test", creativeId: "cr 1/a", expires: 123, sig: "ab".repeat(32) });
  assert.equal(url, `https://app.example.test/api/media-links/cr%201%2Fa?expires=123&sig=${"ab".repeat(32)}`);
});

test("a TikTok host is verified only when it is a verified domain or one of its subdomains", () => {
  const domains = ["media.example.test"];
  assert.equal(hostIsVerified("https://media.example.test/api/media-links/cr-1?x=1", domains), true);
  assert.equal(hostIsVerified("https://cdn.media.example.test/api/media-links/cr-1", domains), true, "subdomains are covered");
  assert.equal(hostIsVerified("https://evilmedia.example.test/x", domains), false, "a host that only ends with the name is not covered");
  assert.equal(hostIsVerified("https://other.example.test/x", domains), false);
  assert.equal(hostIsVerified("http://media.example.test/x", domains), false, "TikTok pulls only over https");
  assert.equal(hostIsVerified("not a url", domains), false);
});

test("TIKTOK_VERIFIED_MEDIA_DOMAINS keeps bare hostnames and drops anything else", () => {
  const env = { TIKTOK_VERIFIED_MEDIA_DOMAINS: " Media.Example.test, https://bad.example.test/x, localhost, ,cdn.example.test " } as NodeJS.ProcessEnv;
  assert.deepEqual(tiktokVerifiedDomains(env), ["media.example.test", "cdn.example.test"]);
});

test("a platform with no secret or origin is not ready, and the reason names the setting, not the secret", () => {
  const instagram = mediaDeliveryFor("instagram", {} as NodeJS.ProcessEnv);
  assert.equal(instagram.ready, false);
  if (!instagram.ready) assert.match(instagram.reason, /MEDIA_LINK_SECRET/);

  const env = { MEDIA_LINK_SECRET: SECRET, APP_URL: "https://media.example.test" } as NodeJS.ProcessEnv;
  const noOrigin = mediaDeliveryFor("instagram", { MEDIA_LINK_SECRET: SECRET } as NodeJS.ProcessEnv);
  assert.equal(noOrigin.ready, false);
  const instagramReady = mediaDeliveryFor("instagram", env);
  assert.equal(instagramReady.ready, true);
  if (instagramReady.ready) {
    assert.equal(instagramReady.origin, "https://media.example.test");
    assert.equal(instagramReady.secret, SECRET, "the service signs with the secret it was given");
  }
});

test("TikTok is not ready when no domain is verified, or when its origin host is not one", () => {
  const env = { MEDIA_LINK_SECRET: SECRET, APP_URL: "https://media.example.test" } as NodeJS.ProcessEnv;
  const none = mediaDeliveryFor("tiktok", env);
  assert.equal(none.ready, false);
  if (!none.ready) assert.match(none.reason, /TIKTOK_VERIFIED_MEDIA_DOMAINS/);

  const other = mediaDeliveryFor("tiktok", { ...env, TIKTOK_VERIFIED_MEDIA_DOMAINS: "cdn.other.test" } as NodeJS.ProcessEnv);
  assert.equal(other.ready, false, "the origin host must be one of the verified domains");

  const verified = mediaDeliveryFor("tiktok", { ...env, TIKTOK_VERIFIED_MEDIA_DOMAINS: "media.example.test" } as NodeJS.ProcessEnv);
  assert.equal(verified.ready, true);
});
