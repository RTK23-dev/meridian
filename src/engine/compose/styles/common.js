// Shared drawing helpers for the code-drawn styles (isometric, paper-cut, line diagram, stacked chart). Plain browser JavaScript with no
// dependency, loaded before a style module. Every style draws a frame as a pure function of time (seek-safe, like a HyperFrames timeline):
// no wall clock, no Math.random; randomness comes from a seeded hash.
//
// Motion follows the motion kit (compose/motion/kit.ts): moves wind up, travel and settle on hand-shaped curves chosen per move; text cuts
// on or rises a short way, never on a named preset.
(function (root) {
  "use strict";

  var W = 1080;
  var H = 1920;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function hash(n) { n = (n | 0) ^ 0x9e3779b9; n = Math.imul(n ^ (n >>> 16), 0x85ebca6b); n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35); return ((n ^ (n >>> 16)) >>> 0) / 4294967296; }
  function hash2(a, b) { return hash(Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663)); }

  // The motion kit's curves, as cubic beziers (compose/motion/kit.ts KIT_CURVES).
  var CURVES = {
    land: [0.1, 0.75, 0.15, 1], heavy: [0.75, 0, 0.18, 1], whip: [0.85, 0, 0.15, 1], reveal: [0.22, 1, 0.36, 1],
    leave: [0.55, 0, 0.9, 0.35], wind: [0.45, 0, 0.55, 1], drift: [0.4, 0, 0.6, 1], linear: [0, 0, 1, 1],
  };
  function bez(p, t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    var x1 = p[0], y1 = p[1], x2 = p[2], y2 = p[3];
    var lo = 0, hi = 1, u = t;
    for (var i = 0; i < 24; i++) {
      u = (lo + hi) / 2;
      var x = 3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u;
      if (x < t) lo = u; else hi = u;
    }
    return 3 * (1 - u) * (1 - u) * u * y1 + 3 * (1 - u) * u * u * y2 + u * u * u;
  }
  /** Progress of a move from `start` lasting `dur` seconds on the named curve, 0 before and 1 after. */
  function move(t, start, dur, curve) {
    return bez(CURVES[curve || "land"], clamp((t - start) / dur, 0, 1));
  }
  /** A settle with a small overshoot (a spring that lands past its mark and comes back), for things that pop on. */
  function settle(t, start, dur, overshoot) {
    var p = clamp((t - start) / dur, 0, 1);
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    var o = overshoot === undefined ? 0.12 : overshoot;
    return 1 + o * Math.sin(p * Math.PI * 1.5) * (1 - p) - Math.pow(1 - p, 3) * (1 + o * 0.4);
  }

  function rgb(hex) { return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]; }
  function css(c, a) { return a === undefined ? "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")" : "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")"; }
  function mix(a, b, t) { return [Math.round(lerp(a[0], b[0], t)), Math.round(lerp(a[1], b[1], t)), Math.round(lerp(a[2], b[2], t))]; }
  function shade(hex, k) { var c = rgb(hex); return k < 0 ? mix(c, [0, 0, 0], -k) : mix(c, [255, 255, 255], k); }

  /** Splits text into lines that fit `maxWidth` in the context's current font. Never breaks inside a word. */
  function wrap(ctx, text, maxWidth) {
    var words = String(text).split(/\s+/).filter(Boolean);
    var lines = [];
    var line = "";
    for (var i = 0; i < words.length; i++) {
      var next = line ? line + " " + words[i] : words[i];
      if (ctx.measureText(next).width > maxWidth && line) { lines.push(line); line = words[i]; } else line = next;
    }
    if (line) lines.push(line);
    return lines;
  }

  /**
   * Draws a block of text. Options: x, y (top), font, size, weight, colour, align, maxWidth, lineHeight, alpha, rise (pixels it rises
   * from as it appears), appear (0..1), letterSpacing (px), shadow. Returns the block's height.
   */
  function text(ctx, value, o) {
    var size = o.size || 48;
    ctx.save();
    ctx.font = (o.weight || 700) + " " + size + "px " + (o.font || "Inter");
    ctx.textAlign = o.align || "center";
    ctx.textBaseline = "top";
    if (o.letterSpacing) ctx.letterSpacing = o.letterSpacing + "px";
    var lines = o.maxWidth ? wrap(ctx, value, o.maxWidth) : [String(value)];
    var lh = size * (o.lineHeight || 1.15);
    var appear = o.appear === undefined ? 1 : o.appear;
    // multiplied, never set: text inside a fading group fades with it (the loop back to the opening frame)
    ctx.globalAlpha *= (o.alpha === undefined ? 1 : o.alpha) * clamp(appear * 1.6, 0, 1);
    var dy = (o.rise || 0) * (1 - appear);
    if (o.shadow) { ctx.shadowColor = o.shadow; ctx.shadowBlur = o.shadowBlur || 0; ctx.shadowOffsetY = o.shadowOffsetY || 0; }
    ctx.fillStyle = o.colour || "#fff";
    for (var i = 0; i < lines.length; i++) ctx.fillText(lines[i], o.x, o.y + dy + i * lh);
    ctx.restore();
    return lines.length * lh;
  }

  /** Types a string on: the first n characters of it, n growing with `p` (0..1). */
  function typed(value, p) {
    var s = String(value);
    return s.slice(0, Math.round(clamp(p, 0, 1) * s.length));
  }

  /** A fine, seeded grain over the frame (fixed per frame index, so a render is identical every time). */
  function grain(ctx, frame, amount, cell) {
    var size = cell || 6;
    ctx.save();
    for (var y = 0; y < H; y += size) {
      for (var x = 0; x < W; x += size) {
        var n = hash2(x * 31 + frame * 7, y * 17 + frame);
        if (n > 0.5) { ctx.fillStyle = "rgba(255,255,255," + ((n - 0.5) * amount).toFixed(3) + ")"; ctx.fillRect(x, y, size, size); }
        else { ctx.fillStyle = "rgba(0,0,0," + ((0.5 - n) * amount).toFixed(3) + ")"; ctx.fillRect(x, y, size, size); }
      }
    }
    ctx.restore();
  }

  function vignette(ctx, strength) {
    var g = ctx.createRadialGradient(W / 2, H / 2, H * 0.25, W / 2, H / 2, H * 0.75);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0," + strength + ")");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /**
   * The timeline every style shares: a title beat, then one beat per step, then a hold that returns to the opening frame so the video
   * loops. All in seconds. `introS` and `outroS` are the style's own.
   */
  function timeline(durationS, steps, introS, outroS) {
    var body = Math.max(0.5, durationS - introS - outroS);
    var each = body / Math.max(1, steps);
    var beats = [];
    for (var i = 0; i < steps; i++) beats.push({ index: i, start: introS + i * each, end: introS + (i + 1) * each });
    return { introEnd: introS, beats: beats, outroStart: durationS - outroS, duration: durationS, each: each };
  }

  /** The index of the step beat at time t, or -1 before the first and steps.length after the last. */
  function beatAt(tl, t) {
    if (t < tl.introEnd) return -1;
    for (var i = 0; i < tl.beats.length; i++) if (t < tl.beats[i].end) return i;
    return tl.beats.length;
  }

  /** The caption band every style uses for its step line: bottom third, inside the safe area, one line at a time, cut on. */
  function caption(ctx, value, o) {
    if (!value) return;
    var y = o.y === undefined ? H * 0.78 : o.y;
    text(ctx, value, {
      x: W / 2, y: y, size: o.size || 54, weight: o.weight || 700, font: o.font || "Inter", colour: o.colour || "#fff",
      maxWidth: o.maxWidth || W - 200, lineHeight: 1.18, appear: o.appear, rise: o.rise === undefined ? 18 : o.rise, alpha: o.alpha,
      shadow: o.shadow, shadowBlur: o.shadowBlur,
    });
  }

  root.MeridianStyleKit = {
    W: W, H: H, clamp: clamp, lerp: lerp, hash: hash, hash2: hash2, move: move, settle: settle, rgb: rgb, css: css, mix: mix, shade: shade,
    wrap: wrap, text: text, typed: typed, grain: grain, vignette: vignette, roundRect: roundRect, timeline: timeline, beatAt: beatAt,
    caption: caption,
  };
  root.MeridianStyles = root.MeridianStyles || {};
})(typeof window !== "undefined" ? window : globalThis);
