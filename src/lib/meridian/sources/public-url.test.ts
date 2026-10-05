import assert from "node:assert/strict";
import test from "node:test";
import { ipIsBlocked, publicUrlIssue } from "./public-url.ts";

test("private and local targets are blocked before a fetch", () => {
  assert.match(publicUrlIssue("http://127.0.0.1/admin") ?? "", /public host/);
  assert.match(publicUrlIssue("http://169.254.169.254/latest") ?? "", /public host/);
  assert.match(publicUrlIssue("http://10.1.1.1/") ?? "", /public host/);
  assert.match(publicUrlIssue("http://localhost/secret") ?? "", /Local/);
  assert.match(publicUrlIssue("file:///etc/passwd") ?? "", /http/);
  assert.equal(publicUrlIssue("https://example.com/pricing"), null);
  assert.equal(ipIsBlocked("8.8.8.8"), false);
  assert.equal(ipIsBlocked("192.168.1.9"), true);
});
