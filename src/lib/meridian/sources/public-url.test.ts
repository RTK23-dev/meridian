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

test("IPv6 wrappers around private addresses and special-use ranges are blocked", () => {
  for (const url of [
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:10.0.0.1]/",
    "http://[::ffff:169.254.169.254]/latest/meta-data",
    "http://[::]/",
    "http://[::1]/",
    "http://[64:ff9b::7f00:1]/",
    "http://[2002:7f00:1::]/",
    "http://[fec0::1]/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
    "http://[ff02::1]/",
    "http://[2001:db8::1]/",
  ]) assert.match(publicUrlIssue(url) ?? "", /public host/, url);
});

test("reserved IPv4 ranges are blocked while public mapped addresses remain allowed", () => {
  for (const ip of ["192.0.0.1", "192.0.2.5", "198.18.0.1", "198.51.100.7", "203.0.113.9", "100.64.0.1", "0.0.0.0", "255.255.255.255", "not-an-ip", "1:2:3:4:5:6:7:8:9"]) {
    assert.equal(ipIsBlocked(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808", "2001:4860:4860::8888"]) {
    assert.equal(ipIsBlocked(ip), false, ip);
  }
});
