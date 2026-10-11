import assert from "node:assert/strict";
import test from "node:test";
import { BOT_CHECK_MESSAGE, isBotChallenge, parseRobots, robotsAllows } from "./crawl-policy.ts";

test("an empty robots file allows every path", () => {
  assert.equal(robotsAllows("", "/anything"), true);
});

test("a wildcard group blocks the paths it names and allows the rest", () => {
  const robots = "User-agent: *\nDisallow: /private\n";
  assert.equal(robotsAllows(robots, "/private/notes"), false);
  assert.equal(robotsAllows(robots, "/public"), true);
});

test("a group that names the crawler overrides the wildcard group", () => {
  const robots = "User-agent: *\nAllow: /\n\nUser-agent: MeridianBot\nDisallow: /\n";
  assert.equal(robotsAllows(robots, "/products"), false);
});

test("a group for another crawler does not restrict Meridian", () => {
  const robots = "User-agent: Googlebot\nDisallow: /\n";
  assert.equal(robotsAllows(robots, "/products"), true);
});

test("the longest matching rule decides, and an allow inside a disallow reopens that path", () => {
  const robots = "User-agent: *\nDisallow: /a\nAllow: /a/b\n";
  assert.equal(robotsAllows(robots, "/a/b/c"), true);
  assert.equal(robotsAllows(robots, "/a/c"), false);
});

test("wildcards and a trailing dollar match file types and query strings as RFC 9309 describes", () => {
  const robots = "User-agent: *\nDisallow: /*.pdf$\n";
  assert.equal(robotsAllows(robots, "/guide.pdf"), false);
  assert.equal(robotsAllows(robots, "/guide.pdf?download=1"), true, "the dollar anchors the end of the path");
  assert.equal(robotsAllows(robots, "/guide.html"), true);
});

test("comments, case and consecutive user-agent lines are read as one group", () => {
  const robots = "# shared rules\nuser-agent: Googlebot # search\nUSER-AGENT: meridianbot\nDisallow: /tmp # temporary\n";
  assert.equal(robotsAllows(robots, "/tmp/file"), false);
  assert.equal(robotsAllows(robots, "/home"), true);
});

test("an empty disallow allows everything", () => {
  assert.equal(robotsAllows("User-agent: *\nDisallow:\n", "/any"), true);
});

test("parseRobots keeps each group's agents and rules", () => {
  const groups = parseRobots("User-agent: a\nUser-agent: b\nDisallow: /x\n\nUser-agent: *\nAllow: /y\n");
  assert.deepEqual(groups.map((group) => group.agents), [["a", "b"], ["*"]]);
  assert.equal(groups[0]?.rules.length, 1);
});

test("a 403 with a challenge header is a bot check, whatever its body says", () => {
  assert.equal(isBotChallenge({ status: 403, headers: { "cf-mitigated": "challenge" }, body: "" }), true);
});

test("a challenge page served with a blocking status is a bot check", () => {
  assert.equal(isBotChallenge({ status: 503, headers: {}, body: "<title>Just a moment...</title>" }), true);
  assert.equal(isBotChallenge({ status: 429, headers: {}, body: "Please complete the captcha to continue" }), true);
});

test("an ordinary refusal is not a bot check, and a successful page is never one", () => {
  assert.equal(isBotChallenge({ status: 403, headers: {}, body: "Forbidden" }), false);
  assert.equal(isBotChallenge({ status: 200, headers: {}, body: "captcha widget on a normal page" }), false);
});

test("the bot-check message says what Meridian does not do", () => {
  assert.match(BOT_CHECK_MESSAGE, /does not get past bot checks/);
});
