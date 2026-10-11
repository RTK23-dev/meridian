import assert from "node:assert/strict";
import test from "node:test";
import { HIGGSFIELD_ORIGIN, HiggsfieldProvider, HiggsfieldRequestError, higgsfieldRequestUrl } from "./higgsfield.ts";
import type { CreativeSpec } from "../types.ts";
import type { CredentialResolution } from "../../credentials/contract.ts";

const KEY = "workspace-higgsfield-key-4242";
const ORG = "org-hf-test";
const ATTACKER = "https://attacker.example";

const spec: CreativeSpec = {
  id: "spec-hf-test",
  organizationId: ORG,
  brandId: "brand-hf-test",
  title: "Higgsfield origin test",
  modality: "video",
  format: "reel",
  aspectRatio: "9:16",
  durationTargetSeconds: 5,
  hookLine: "Stop",
  script: "Proof.",
  scenes: [],
};

const ready: (organizationId: string) => Promise<CredentialResolution> = async () => ({
  status: "ready",
  source: "workspace",
  secret: KEY,
  fingerprint: "test-fingerprint",
});

type Call = { url: string; method: string; redirect: RequestRedirect | undefined; authorization: string | null };

/** A fetch that records every call and answers with `respond`. Recorded calls never include a body, so no key is logged here. */
function recordingFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, method: init?.method ?? "GET", redirect: init?.redirect, authorization: headers.get("authorization") });
    return respond(url, init ?? {});
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** The host of a recorded call, or "" when the URL does not parse. */
function hostOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

test("higgsfieldRequestUrl: only an opaque request id reaches a URL, and it is built on the fixed origin", () => {
  assert.equal(higgsfieldRequestUrl("req_999", "status"), `${HIGGSFIELD_ORIGIN}/v1/requests/req_999/status`);
  assert.equal(higgsfieldRequestUrl("hf-req-1", "cancel"), `${HIGGSFIELD_ORIGIN}/v1/requests/hf-req-1/cancel`);
  for (const bad of ["", "https://attacker.example/steal", "a/b", "../status", "a.b", "req:1", "x".repeat(129)]) {
    assert.throws(
      () => higgsfieldRequestUrl(bad, "status"),
      (error: unknown) => error instanceof HiggsfieldRequestError && error.code === "INVALID_JOB_ID",
      `"${bad.slice(0, 40)}" is not an opaque request id`,
    );
  }
});

test("a status check whose stored URL is on another origin never sends the key there", async () => {
  const { calls, fetchImpl } = recordingFetch((url) => {
    if (url.endsWith("/v1/requests/req-evil-1/status")) return json({ status: "completed", video: { url: "https://cdn.higgsfield.ai/out.mp4" } });
    // Submission: the provider answers with URLs on an attacker's origin.
    return json({ request_id: "req-evil-1", status_url: `${ATTACKER}/steal`, cancel_url: `${ATTACKER}/cancel`, status: "queued" });
  });
  const provider = new HiggsfieldProvider({ fetchImpl, lookup: ready });

  const job = await provider.submitJob(spec);
  assert.equal(job.status, "QUEUED");
  assert.equal(job.statusUrl, `${ATTACKER}/steal`, "the returned URL is recorded as data");

  await provider.checkJobStatus(job.jobId, job.metadata);

  const toAttacker = calls.filter((call) => hostOf(call.url) === ATTACKER);
  assert.equal(toAttacker.length, 0, "no request is made to the provider-named origin");
  assert.equal(calls.filter((call) => call.authorization !== null && hostOf(call.url) !== HIGGSFIELD_ORIGIN).length, 0, "the key is sent to no other origin");
  assert.equal(calls.at(-1)?.url, `${HIGGSFIELD_ORIGIN}/v1/requests/req-evil-1/status`, "the poll is built from the request id");
  assert.equal(calls.at(-1)?.authorization, `Key ${KEY}`);
});

test("a status check whose job id is itself a URL is refused before any request, with no key sent", async () => {
  const { calls, fetchImpl } = recordingFetch(() => json({ status: "completed" }));
  const provider = new HiggsfieldProvider({ fetchImpl, lookup: ready });

  await assert.rejects(
    provider.checkJobStatus(`${ATTACKER}/steal`, { organizationId: ORG, statusUrl: `${ATTACKER}/steal` }),
    (error: unknown) => error instanceof HiggsfieldRequestError && error.code === "INVALID_JOB_ID",
  );
  assert.equal(calls.length, 0, "no request was sent");
});

test("a cancel whose stored cancel URL is on another origin never sends the key there", async () => {
  const { calls, fetchImpl } = recordingFetch(() => new Response(null, { status: 200 }));
  const provider = new HiggsfieldProvider({ fetchImpl, lookup: ready });

  await provider.cancelJob("req-evil-2", { organizationId: ORG, cancelUrl: `${ATTACKER}/cancel` });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${HIGGSFIELD_ORIGIN}/v1/requests/req-evil-2/cancel`);
  assert.equal(calls[0]!.authorization, `Key ${KEY}`);
  assert.equal(calls.filter((call) => hostOf(call.url) === ATTACKER).length, 0);
});

test("a cancel with a job id that is a URL is refused before any request", async () => {
  const { calls, fetchImpl } = recordingFetch(() => new Response(null, { status: 200 }));
  const provider = new HiggsfieldProvider({ fetchImpl, lookup: ready });

  await assert.rejects(
    provider.cancelJob(`${ATTACKER}/cancel`, { organizationId: ORG }),
    (error: unknown) => error instanceof HiggsfieldRequestError && error.code === "INVALID_JOB_ID",
  );
  assert.equal(calls.length, 0);
});

test("every authenticated status and cancel request asks for redirect: manual", async () => {
  const { calls, fetchImpl } = recordingFetch(() => json({ status: "queued" }));
  const provider = new HiggsfieldProvider({ fetchImpl, lookup: ready });

  await provider.checkJobStatus("req-manual-1", { organizationId: ORG });
  await provider.cancelJob("req-manual-1", { organizationId: ORG });

  const authenticated = calls.filter((call) => call.authorization !== null);
  assert.equal(authenticated.length, 2);
  assert.ok(authenticated.every((call) => call.redirect === "manual"), "redirects are never followed with the key");
});

test("a redirect on a status check is an error, and the redirect target is not requested", async () => {
  const { calls, fetchImpl } = recordingFetch((url) => {
    if (url.startsWith(ATTACKER)) return json({ status: "completed", video: { url: "https://cdn.higgsfield.ai/x.mp4" } });
    return new Response(null, { status: 302, headers: { Location: `${ATTACKER}/collect` } });
  });
  const provider = new HiggsfieldProvider({ fetchImpl, lookup: ready });

  await assert.rejects(
    provider.checkJobStatus("req-redirect-1", { organizationId: ORG }),
    (error: unknown) => error instanceof HiggsfieldRequestError && error.code === "REDIRECT_REFUSED" && error.status === 302,
  );
  assert.equal(calls.length, 1, "the redirect was not followed");
  assert.equal(calls[0]!.redirect, "manual");
  assert.equal(calls.filter((call) => hostOf(call.url) === ATTACKER).length, 0, "the redirect target received no request");
});

test("an opaque redirect on a status check is also an error", async () => {
  const { fetchImpl } = recordingFetch(() => ({ type: "opaqueredirect", status: 0, ok: false, body: null }) as unknown as Response);
  const provider = new HiggsfieldProvider({ fetchImpl, lookup: ready });

  await assert.rejects(
    provider.checkJobStatus("req-opaque-1", { organizationId: ORG }),
    (error: unknown) => error instanceof HiggsfieldRequestError && error.code === "REDIRECT_REFUSED",
  );
});

test("a redirect on a cancel is an error that is reported, not swallowed", async () => {
  const { calls, fetchImpl } = recordingFetch(() => new Response(null, { status: 307, headers: { Location: `${ATTACKER}/cancel` } }));
  const provider = new HiggsfieldProvider({ fetchImpl, lookup: ready });

  await assert.rejects(
    provider.cancelJob("req-redirect-2", { organizationId: ORG }),
    (error: unknown) => error instanceof HiggsfieldRequestError && error.code === "REDIRECT_REFUSED",
  );
  assert.equal(calls.length, 1);
});

test("a failed status check carries its HTTP status and never the key or the response body", async () => {
  for (const status of [401, 403, 404, 429, 503]) {
    const { fetchImpl } = recordingFetch(() => new Response(`provider says ${KEY}`, { status }));
    const provider = new HiggsfieldProvider({ fetchImpl, lookup: ready });
    await assert.rejects(
      provider.checkJobStatus("req-status-code", { organizationId: ORG }),
      (error: unknown) => {
        assert.ok(error instanceof HiggsfieldRequestError, `status ${status} is a HiggsfieldRequestError`);
        assert.equal(error.status, status);
        assert.equal(error.message.includes(KEY), false, "the message does not carry the key");
        return true;
      },
    );
  }
});

test("a status response that is not the expected contract is a malformed-response error with no status", async () => {
  const bodies: Array<() => Response> = [
    () => new Response("<html>gateway</html>", { status: 200 }),
    () => json(null),
    () => json({ video: { url: "https://cdn.higgsfield.ai/x.mp4" } }),
  ];
  for (const body of bodies) {
    const { fetchImpl } = recordingFetch(body);
    const provider = new HiggsfieldProvider({ fetchImpl, lookup: ready });
    await assert.rejects(
      provider.checkJobStatus("req-malformed-1", { organizationId: ORG }),
      (error: unknown) => error instanceof HiggsfieldRequestError && error.code === "MALFORMED_RESPONSE" && error.status === undefined,
    );
  }
});

test("a network failure has no status, so the poller treats it as transient", async () => {
  const fetchImpl = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const provider = new HiggsfieldProvider({ fetchImpl, lookup: ready });

  await assert.rejects(provider.checkJobStatus("req-network-1", { organizationId: ORG }), TypeError);
});

test("a submission whose request id is not opaque is not tracked, since it could not be polled safely", async () => {
  const { fetchImpl } = recordingFetch(() => json({ request_id: "https://attacker.example/x", status_url: `${HIGGSFIELD_ORIGIN}/v1/requests/x/status`, status: "queued" }));
  const provider = new HiggsfieldProvider({ fetchImpl, lookup: ready });

  const job = await provider.submitJob(spec);
  assert.equal(job.status, "SUBMISSION_UNKNOWN");
  assert.equal(job.errorCode, "MALFORMED_RESPONSE");
  assert.equal(job.jobId, "");
});

test("without a usable workspace key, a status check throws and sends nothing", async () => {
  const { calls, fetchImpl } = recordingFetch(() => json({ status: "completed" }));
  const provider = new HiggsfieldProvider({
    fetchImpl,
    lookup: async () => ({ status: "not_configured", reason: "No Higgsfield key is saved for this workspace." }),
  });

  await assert.rejects(provider.checkJobStatus("req-nokey-1", { organizationId: ORG }), /Cannot check Higgsfield job status/);
  assert.equal(calls.length, 0);
});
