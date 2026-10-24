import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  PUBLIC_SITE_ROUTES,
  blockingViolations,
  isOwnConsoleError,
  pageFailures,
  summarize,
} from "./public-site-checks.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** A page that passes every rule. Each test changes one field to show that rule. */
function passingObservation(overrides = {}) {
  return {
    status: 200,
    title: "Product · Meridian",
    h1Count: 1,
    width: 390,
    overflowPx: 0,
    consoleErrors: [],
    pageErrors: [],
    seriousViolations: [],
    skipLinkFocusedFirst: true,
    skipLinkMovesFocusToMain: true,
    focusRingVisible: true,
    animatedUnderReduce: 0,
    ...overrides,
  };
}

const expectation = { title: "Product · Meridian", keyboard: true, reducedMotion: true };

describe("the rules for one public page", () => {
  test("a page that meets every rule has no failures", () => {
    assert.deepEqual(pageFailures(passingObservation(), expectation), []);
  });

  test("a page that does not answer 200 fails", () => {
    assert.match(pageFailures(passingObservation({ status: 404 }), expectation)[0], /answered 404/);
  });

  test("a title other than the expected one fails", () => {
    assert.match(pageFailures(passingObservation({ title: "Meridian" }), expectation)[0], /title is "Meridian"/);
  });

  test("a page with no h1, or two, fails", () => {
    assert.match(pageFailures(passingObservation({ h1Count: 0 }), expectation)[0], /0 h1/);
    assert.match(pageFailures(passingObservation({ h1Count: 2 }), expectation)[0], /2 h1/);
  });

  test("sideways scrolling at a phone width fails, and names the width", () => {
    const failures = pageFailures(passingObservation({ overflowPx: 37 }), expectation);
    assert.match(failures[0], /scrolls sideways by 37px at 390px wide/);
  });

  test("a console error or a page error fails", () => {
    assert.match(pageFailures(passingObservation({ consoleErrors: ["Each child in a list needs a key"] }), expectation)[0], /console error/);
    assert.match(pageFailures(passingObservation({ pageErrors: ["Cannot read properties of undefined"] }), expectation)[0], /page error/);
  });

  test("a serious accessibility violation fails and names the rule and the element", () => {
    const failures = pageFailures(
      passingObservation({ seriousViolations: [{ id: "color-contrast", impact: "serious", nodes: ["main p"] }] }),
      expectation,
    );
    assert.equal(failures.length, 1);
    assert.match(failures[0], /color-contrast/);
    assert.match(failures[0], /main p/);
  });

  test("keyboard rules apply only where the page was tested for keyboard use", () => {
    const failing = passingObservation({ skipLinkFocusedFirst: false, focusRingVisible: false });
    assert.equal(pageFailures(failing, { title: "Product · Meridian", keyboard: false }).length, 0);
    assert.equal(pageFailures(failing, expectation).length, 2);
  });

  test("a focused link with no visible ring fails", () => {
    assert.match(pageFailures(passingObservation({ focusRingVisible: false }), expectation).join("\n"), /no visible focus ring/);
  });

  test("an animating element under reduced motion fails, and is ignored when reduced motion was not tested", () => {
    const animating = passingObservation({ animatedUnderReduce: 2 });
    assert.match(pageFailures(animating, expectation).join("\n"), /2 element\(s\) still animate/);
    assert.equal(pageFailures(animating, { title: "Product · Meridian", keyboard: true }).length, 0);
  });
});

describe("the blocking accessibility findings", () => {
  test("keeps serious and critical findings, and drops minor and moderate ones", () => {
    const axe = [
      { id: "color-contrast", impact: "serious", nodes: [{ target: ["main", "p"] }] },
      { id: "region", impact: "moderate", nodes: [{ target: ["footer"] }] },
      { id: "landmark-one-main", impact: "critical", nodes: [{ target: ["body"] }] },
      { id: "tabindex", impact: "minor", nodes: [{ target: ["main"] }] },
    ];
    assert.deepEqual(
      blockingViolations(axe).map((item) => item.id),
      ["color-contrast", "landmark-one-main"],
    );
  });

  test("names at most three nodes per finding", () => {
    const nodes = [1, 2, 3, 4, 5].map((n) => ({ target: [`p:nth-child(${n})`] }));
    assert.equal(blockingViolations([{ id: "color-contrast", impact: "serious", nodes }])[0].nodes.length, 3);
  });
});

describe("which console errors count", () => {
  const origin = "http://127.0.0.1:8080";

  test("an error from the app's own script counts", () => {
    assert.equal(isOwnConsoleError({ type: "error", location: { url: `${origin}/assets/app.js` } }, origin), true);
  });

  test("an error from a third-party host does not count: it is the network, not the page", () => {
    assert.equal(isOwnConsoleError({ type: "error", location: { url: "https://fonts.googleapis.com/css2" } }, origin), false);
  });

  test("a warning does not count, and an error with no location counts", () => {
    assert.equal(isOwnConsoleError({ type: "warning", location: { url: `${origin}/x.js` } }, origin), false);
    assert.equal(isOwnConsoleError({ type: "error", location: {} }, origin), true);
  });
});

describe("the summary", () => {
  test("passes only when every page passes", () => {
    assert.equal(summarize([{ label: "/product 390px", failures: [] }]).ok, true);
    const failed = summarize([{ label: "/docs 390px", failures: ["answered 500, not 200"] }]);
    assert.equal(failed.ok, false);
    assert.deepEqual(failed.failed, [{ label: "/docs 390px", failures: ["answered 500, not 200"] }]);
  });
});

describe("the routes the smoke test checks", () => {
  test("each route's expected title is the title its route file sets", () => {
    for (const route of PUBLIC_SITE_ROUTES) {
      const file = `${ROOT}src/routes${route.path}.tsx`;
      assert.ok(existsSync(file), `${file} exists`);
      assert.ok(readFileSync(file, "utf8").includes(`"${route.title}"`), `${route.path} sets the title "${route.title}"`);
    }
  });
});
