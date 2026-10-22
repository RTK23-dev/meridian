import assert from "node:assert/strict";
import test from "node:test";
import { redactProviderText, sendWithRetry, type Transport } from "./http.ts";
import { probeTikTok } from "./tiktok.ts";

// Contains characters that URL-encode, so the test covers the encoded form that appears in the query string.
const SECRET = "tt/secret+val=9";
const APP_ID = "7000000000000000001";
const ADVERTISER_PATH = "/oauth2/advertiser/get/";

test("a transport failure during advertiser lookup returns no secret and no request URL", async () => {
  const advertiserUrls: string[] = [];
  const transport: Transport = async (request) => {
    if (request.url.includes("/user/info/")) {
      return { status: 200, body: JSON.stringify({ code: 0, data: { display_name: "Acme" } }), headers: {} };
    }
    advertiserUrls.push(request.url);
    // A runtime whose transport error echoes the full request URL, query string included.
    throw new Error(`socket hang up while requesting ${request.url}`);
  };

  const result = await probeTikTok({ accessToken: "tt-access-token", appId: APP_ID, appSecret: SECRET }, transport);

  assert.equal(result.ok, false, "a token with no advertiser found is not connected to an account");
  assert.match(result.ok ? "" : result.error, /no advertiser account/);
  assert.equal(advertiserUrls.length, 3, "the lookup is still attempted with retries");
  assert.match(advertiserUrls[0], /[?&]secret=/, "the documented query-string contract is unchanged");
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(SECRET), false, "the raw secret is not returned");
  assert.equal(serialized.includes(encodeURIComponent(SECRET)), false, "the encoded secret is not returned");
  assert.equal(serialized.includes(ADVERTISER_PATH), false, "the request URL is not returned");
});

test("the recorded account is the token's own advertiser; the deployment's advertiser id is never used for a token", async () => {
  const DEPLOYMENT_ADVERTISER = "7999999999999999999";
  const advertisers = (rows: unknown[]): Transport => async (request) =>
    request.url.includes("/user/info/")
      ? { status: 200, body: JSON.stringify({ code: 0, data: { display_name: "Acme" } }), headers: {} }
      : { status: 200, body: JSON.stringify({ code: 0, data: { list: rows } }), headers: {} };

  const own = await probeTikTok(
    { accessToken: "tt-access-token", appId: APP_ID, appSecret: SECRET, advertiserId: DEPLOYMENT_ADVERTISER },
    advertisers([{ advertiser_id: "7100000000000000002", advertiser_name: "Acme Shop" }]),
  );
  assert.equal(own.ok, true);
  assert.equal(own.ok ? own.accountId : "", "7100000000000000002");

  const none = await probeTikTok({ accessToken: "tt-access-token", appId: APP_ID, appSecret: SECRET, advertiserId: DEPLOYMENT_ADVERTISER }, advertisers([]));
  assert.equal(none.ok, false, "a token with no advertiser is not an account");
  assert.match(none.ok ? "" : none.error, /no advertiser account/);
  assert.equal(JSON.stringify(none).includes(DEPLOYMENT_ADVERTISER), false, "the deployment's advertiser id is not recorded for the token");

  const noAppCredentials = await probeTikTok({ accessToken: "tt-access-token", advertiserId: DEPLOYMENT_ADVERTISER }, advertisers([]));
  assert.equal(noAppCredentials.ok, false, "without the app's credentials no advertiser is found, and the environment id does not stand in");
  assert.equal(JSON.stringify(noAppCredentials).includes(DEPLOYMENT_ADVERTISER), false);
});

test("sendWithRetry error text carries neither the request URL nor the named secret", async () => {
  const transport: Transport = async (request) => {
    throw new Error(`fetch failed: ${request.url}`);
  };
  const url = `https://business-api.tiktok.com/open_api/v1.3${ADVERTISER_PATH}?app_id=${APP_ID}&secret=${encodeURIComponent(SECRET)}`;

  const result = await sendWithRetry(transport, { method: "GET", url, headers: {} }, { attempts: 1, redact: [SECRET] });

  assert.equal(result.ok, false);
  assert.equal(result.error.includes(SECRET), false);
  assert.equal(result.error.includes(encodeURIComponent(SECRET)), false);
  assert.equal(result.error.includes(ADVERTISER_PATH), false);
  assert.match(result.error, /fetch failed/, "the failure reason is still reported");
});

test("error text never carries a secret-looking query value, even when no secret was named", () => {
  assert.equal(
    redactProviderText("failed at https://h.example/p?app_id=1&secret=abc123&lang=en"),
    "failed at https://h.example/p?app_id=1&secret=[redacted]&lang=en",
  );
  assert.equal(redactProviderText("access_token=xyz was rejected"), "access_token=[redacted] was rejected");
  assert.equal(redactProviderText("Provider returned 500."), "Provider returned 500.", "ordinary text is untouched");
});
