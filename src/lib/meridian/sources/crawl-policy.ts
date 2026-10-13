/**
 * The rules a public page read must pass before it happens. This module is pure, so it has no network and no Node imports.
 *
 * Two rules apply. First, a site's robots.txt is honored for the crawler's own name, using the longest-match rule of RFC 9309.
 * Second, a response that is a bot check (a CAPTCHA or a challenge page) is reported as the site blocking the read. Meridian
 * never tries to solve, route around or otherwise get past a bot check. The person can upload the page or use a connected source.
 */

/** The product token the robots file is matched against, and the name the crawler sends. */
export const CRAWLER_TOKEN = "meridianbot";
export const CRAWLER_USER_AGENT = "MeridianBot/1.0 (reads public pages for a brand's research; honors robots.txt)";

type RobotsRule = { allow: boolean; pattern: string };
type RobotsGroup = { agents: string[]; rules: RobotsRule[] };

/** Groups the lines of a robots file. Consecutive user-agent lines share one group, and comments and blank lines are ignored. */
export function parseRobots(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let previousWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!current || !previousWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      previousWasAgent = true;
      continue;
    }
    previousWasAgent = false;
    if (!current || value === "") continue;
    if (key === "allow" || key === "disallow") current.rules.push({ allow: key === "allow", pattern: value });
  }
  return groups;
}

/** The rules that apply to a token: every group that names it, or else every group that names "*". */
function rulesFor(groups: RobotsGroup[], token: string): RobotsRule[] {
  const named = groups.filter((group) => group.agents.some((agent) => agent !== "*" && (agent === token || token.includes(agent))));
  const chosen = named.length > 0 ? named : groups.filter((group) => group.agents.includes("*"));
  return chosen.flatMap((group) => group.rules);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/** A robots pattern: `*` matches any run of characters, and a trailing `$` anchors the end. Matching starts at the first character. */
function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body.split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${source}${anchored ? "$" : ""}`).test(path);
}

/**
 * Whether the robots file lets `token` read `path` (the path and query, such as `/offers?x=1`). The longest matching rule decides,
 * and an Allow wins a tie. With no matching rule, the path is allowed.
 */
export function robotsAllows(robotsText: string, path: string, token: string = CRAWLER_TOKEN): boolean {
  let best: RobotsRule | null = null;
  for (const rule of rulesFor(parseRobots(robotsText), token.toLowerCase())) {
    if (!patternMatches(rule.pattern, path)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) best = rule;
  }
  return best === null || best.allow;
}

/** The status codes a bot check is served with. A page that is not one of these is not classified as a bot check. */
const CHALLENGE_STATUSES = new Set([403, 429, 503]);
const CHALLENGE_BODY = /captcha|recaptcha|hcaptcha|turnstile|just a moment|cf-chl|attention required/i;

/**
 * Whether a response is a bot check: a blocking status with a challenge header or a CAPTCHA or challenge page. A plain 403 or
 * 429 with an ordinary body is not one, so it is reported as an error, not as a bot check.
 */
export function isBotChallenge(response: { status: number; headers: Record<string, string | undefined>; body: string }): boolean {
  if (!CHALLENGE_STATUSES.has(response.status)) return false;
  if ((response.headers["cf-mitigated"] ?? "").toLowerCase() === "challenge") return true;
  return CHALLENGE_BODY.test(response.body);
}

/** The message a person sees when a site runs a bot check. It says what Meridian did and what to do instead. */
export const BOT_CHECK_MESSAGE = "The site answered with a bot check (a CAPTCHA or challenge). Meridian does not get past bot checks. Upload the page, or use a connected source instead.";

/** The message a person sees when robots.txt does not allow the read. */
export const ROBOTS_MESSAGE = "This site's robots.txt does not allow MeridianBot to read this page, so the page was not read.";
