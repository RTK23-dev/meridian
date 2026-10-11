import assert from "node:assert/strict";
import test from "node:test";
import { parseTrustedOrigins, trustedOriginsFor } from "./trusted-origins.ts";

const LOCAL = ["http://localhost:8080", "http://127.0.0.1:8080", "http://[::1]:8080"];

test("the request's own origin is trusted, so the app works on whatever host it is served from", () => {
  const origins = trustedOriginsFor({
    baseURL: "https://app.example.com",
    extraOrigins: [],
    localDevOrigins: LOCAL,
    isProduction: true,
    requestUrl: "http://192.168.1.10:8080/api/auth/sign-up/email",
  });
  assert.ok(origins.includes("http://192.168.1.10:8080"));
});

test("a cross-site origin is never added: the request's own origin is the only thing the request contributes", () => {
  const origins = trustedOriginsFor({
    baseURL: "https://app.example.com",
    extraOrigins: [],
    localDevOrigins: LOCAL,
    isProduction: true,
    requestUrl: "https://app.example.com/api/auth/sign-up/email",
  });
  assert.deepEqual(origins, ["https://app.example.com"]);
  assert.ok(!origins.includes("https://evil.example"));
});

test("loopback origins are trusted in development only", () => {
  const dev = trustedOriginsFor({ baseURL: "http://localhost:8080", extraOrigins: [], localDevOrigins: LOCAL, isProduction: false });
  for (const origin of LOCAL) assert.ok(dev.includes(origin), origin);
  const prod = trustedOriginsFor({ baseURL: "https://app.example.com", extraOrigins: [], localDevOrigins: LOCAL, isProduction: true });
  for (const origin of LOCAL) assert.ok(!prod.includes(origin), origin);
});

test("extra origins from MERIDIAN_TRUSTED_ORIGINS are added and duplicates are removed", () => {
  const origins = trustedOriginsFor({
    baseURL: "https://app.example.com",
    extraOrigins: parseTrustedOrigins(" https://staging.example.com , https://app.example.com,"),
    localDevOrigins: LOCAL,
    isProduction: true,
    requestUrl: "https://app.example.com/x",
  });
  assert.deepEqual(origins, ["https://app.example.com", "https://staging.example.com"]);
});

test("a request URL that cannot be parsed adds nothing", () => {
  const origins = trustedOriginsFor({ baseURL: "https://app.example.com", extraOrigins: [], localDevOrigins: LOCAL, isProduction: true, requestUrl: "not a url" });
  assert.deepEqual(origins, ["https://app.example.com"]);
});

test("parseTrustedOrigins ignores blanks and whitespace", () => {
  assert.deepEqual(parseTrustedOrigins(undefined), []);
  assert.deepEqual(parseTrustedOrigins(" , "), []);
});
