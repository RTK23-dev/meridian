import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { edlFixture, styleKitFixture } from "../../contracts/fixtures/index.ts";
import { compile } from "../compiler.ts";
import { COMPONENT_LIBRARY } from "../components/index.ts";
import { motionFindings, motionPasses } from "./lint.ts";

const page = (script: string) => `<!DOCTYPE html>\n<html>\n<body>\n<script>\n${script}\n</script>\n</body>\n</html>`;

describe("the motion lint", () => {
  it("blocks a named preset, gsap.defaults and a blur-in, and says what to do instead", () => {
    const findings = motionFindings(
      page(
        [
          'gsap.defaults({ duration: 0.6, ease: "power3.out" });',
          'tl.fromTo(a, { y: 24 }, { y: 0, duration: 0.6, ease: "back.out(1.7)" }, 0);',
          'tl.fromTo(b, { filter: "blur(12px)" }, { filter: "blur(0px)", duration: 0.4, ease: MotionKit.curve("kit.land") }, 0);',
        ].join("\n"),
      ),
    );
    assert.deepEqual(
      findings.map((f) => [f.rule, f.severity, f.line]),
      [
        ["named_preset", "block", 5],
        ["gsap_defaults", "block", 5],
        ["named_preset", "block", 6],
        ["blur_in", "block", 7],
      ],
    );
    assert.match(findings[0]!.message, /MotionKit\.curve/);
    assert.equal(motionPasses(page('tl.to(a, { x: 1, ease: "sine.inOut" });')), false);
  });

  it("warns on an even stagger and on a fade-in from nothing", () => {
    const findings = motionFindings(
      page(
        [
          "items.forEach(function (el, i) {",
          "  tl.fromTo(el, { opacity: 0, x: 24 }, { opacity: 1, x: 0, duration: 0.25, ease: MotionKit.curve('kit.land') }, 0.35 + i * 0.18);",
          "});",
          "tl.to(list, { y: 0, stagger: 0.08 });",
        ].join("\n"),
      ),
    );
    assert.deepEqual(
      findings.map((f) => f.rule).sort(),
      ["even_stagger", "even_stagger", "fade_in"],
    );
    assert.ok(findings.every((f) => f.severity === "warn"));
  });

  it("passes a curve chosen per move, a linear crossfade, stepped type-on and uneven reactions", () => {
    const findings = motionFindings(
      page(
        [
          "var MK = window.MotionKit;",
          'tl.fromTo(a, { y: 90 }, { y: 0, duration: MK.dur(90, 1), ease: MK.curve("kit.land") }, 0);',
          'tl.fromTo(b, { opacity: 0 }, { opacity: 1, duration: 0.2, ease: "none" }, 1);',
          'tl.fromTo(c, { clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0% 0 0)", duration: 0.5, ease: "steps(12)" }, 2);',
          "items.forEach(function (el, i) { MK.cut(tl, el, 3 + MK.react(i)); });",
        ].join("\n"),
      ),
    );
    assert.deepEqual(findings.filter((f) => f.rule !== "fade_in"), []);
    assert.ok(motionPasses(page('tl.to(a, { x: 1, ease: MotionKit.curve("kit.whip") });')));
  });

  it("only reads scripts: a CSS blur on a background is not a blur-in", () => {
    assert.deepEqual(motionFindings("<style>.bg { filter: blur(30px); }</style><script>tl.set(a, { autoAlpha: 1 }, 1);</script>"), []);
  });
});

describe("Meridian's motion is clean", () => {
  it("no component chooses a preset, an even stagger or a blur-in; only a fade the plan asks for remains", () => {
    for (const component of Object.values(COMPONENT_LIBRARY)) {
      const findings = motionFindings(component.template);
      assert.deepEqual(
        findings.filter((f) => f.rule !== "fade_in"),
        [],
        `${component.name}: ${JSON.stringify(findings, null, 2)}`,
      );
      assert.ok(findings.length <= 1, `${component.name} fades in more than once`);
    }
    assert.equal(motionFindings(COMPONENT_LIBRARY["title.hook"]!.template).length, 1, "title.hook keeps its chosen 'fade' entrance");
  });

  it("a component that scales its moves by the kit's motion intensity reads it first", () => {
    for (const component of Object.values(COMPONENT_LIBRARY)) {
      const code = component.template.replace(/--kit-motion|motion-kit|\/\/[^\n]*/g, "");
      if (/[^\w.]motion[^\w-]/.test(code)) {
        assert.match(component.template, /var motion = parseFloat\(kit\.getPropertyValue\("--kit-motion"\)\)/, component.name);
      }
    }
  });

  it("every animated component loads the kit after GSAP", () => {
    for (const component of Object.values(COMPONENT_LIBRARY)) {
      if (!component.template.includes("window.MotionKit")) continue;
      const gsap = component.template.indexOf("gsap.min.js");
      const kit = component.template.indexOf('<script src="../lib/motion-kit.js"></script>');
      assert.ok(gsap > 0 && kit > gsap, `${component.name} loads ../lib/motion-kit.js after GSAP`);
    }
  });

  it("the compiled root timeline passes, with every transition and effect drawn", () => {
    const edl = structuredClone(edlFixture);
    edl.tracks[1]!.clips[1]!.transitionIn = "whip";
    edl.effects.push({ atMs: 5000, kind: "shake", params: { amplitude: 8, durationMs: 300 } });
    edl.effects.push({ atMs: 9000, kind: "flash", params: { opacity: 0.6 } });
    const result = compile(edl, styleKitFixture);
    const index = new TextDecoder().decode(result.files.find((file) => file.path === "index.html")!.bytes);
    assert.deepEqual(motionFindings(index).filter((f) => f.severity === "block"), []);
  });
});
