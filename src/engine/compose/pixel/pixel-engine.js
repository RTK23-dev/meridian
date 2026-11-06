/* eslint-disable */
// The code-drawn 8-bit crew: draws a directed film (direction/film.ts) from its pixel build (stage.ts), one frame at a time, as a pure
// function of time, so any frame can be drawn in any order (seek-safe, like a HyperFrames timeline). Plain browser JavaScript with no
// dependency, so a composition or the agent renderer can load it as a file.
//
// The look it holds (docs/engine/STYLE_PRESET_PIXEL_EXPLAINER.md):
// - a 180 x 320 logical frame, scaled by a whole number, so a pixel is one size on screen at every zoom;
// - shapes shaded with a 4x4 ordered dither between three tones of one colour, and a dark outline;
// - objects with faces (eyes with a highlight, a line mouth, brows), and expressions that follow the stakes;
// - a 5x7 pixel font, upper case, white with a dark outline, the payoff words in the keyword colour, cut on (never faded);
// - soft glows and a fine grain over the pixels.
// Motion: character animation is held to the shot's cadence (on twos by default); the camera moves on ones. Moves wind up, whip and
// settle past their mark (the motion kit's curves); nothing eases on a named preset.
(function (root) {
  "use strict";

  var W = 180;
  var H = 320;

  // ---------- small helpers ----------
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function hash(n) { n = (n | 0) ^ 0x9e3779b9; n = Math.imul(n ^ (n >>> 16), 0x85ebca6b); n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35); return ((n ^ (n >>> 16)) >>> 0) / 4294967296; }
  function hash2(a, b) { return hash(Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663)); }
  function rgb(hex) { return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]; }
  function mixc(a, b, t) { return [Math.round(lerp(a[0], b[0], t)), Math.round(lerp(a[1], b[1], t)), Math.round(lerp(a[2], b[2], t))]; }
  function darken(c, k) { return mixc(c, [8, 9, 26], k); }
  function lighten(c, k) { return mixc(c, [255, 250, 235], k); }
  var BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  function bayer(x, y) { return (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16; }

  // The motion kit's curves (compose/motion/kit.ts KIT_CURVES), as cubic beziers.
  var CURVES = {
    "kit.land": [0.1, 0.75, 0.15, 1], "kit.heavy": [0.75, 0, 0.18, 1], "kit.whip": [0.85, 0, 0.15, 1], "kit.reveal": [0.22, 1, 0.36, 1],
    "kit.leave": [0.55, 0, 0.9, 0.35], "kit.wind": [0.45, 0, 0.55, 1], "kit.drift": [0.4, 0, 0.6, 1], linear: [0, 0, 1, 1],
  };
  function bez(p, t) {
    var x1 = p[0], y1 = p[1], x2 = p[2], y2 = p[3];
    if (t <= 0) return 0; if (t >= 1) return 1;
    var u = t;
    for (var i = 0; i < 8; i++) {
      var x = 3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u - t;
      var dx = 3 * (1 - u) * (1 - u) * x1 + 6 * (1 - u) * u * (x2 - x1) + 3 * u * u * (1 - x2);
      if (Math.abs(dx) < 1e-6) break;
      u = clamp(u - x / dx, 0, 1);
    }
    return 3 * (1 - u) * (1 - u) * u * y1 + 3 * (1 - u) * u * u * y2 + u * u * u;
  }
  function ease(name, t) { return bez(CURVES[name] || CURVES["kit.land"], clamp(t, 0, 1)); }
  /** Wind up (backwards), whip to the mark, pass it by the overshoot and settle back: one move's progress, 0 to 1. */
  function arc(p, anticipation, overshoot, curve) {
    p = clamp(p, 0, 1);
    var a = anticipation || 0, o = overshoot || 0;
    var wind = a > 0 ? 0.3 : 0;
    if (p < wind) return -a * ease("kit.wind", p / wind) * (1 - p / wind * 0.2);
    var q = wind > 0 ? (p - wind) / (1 - wind) : p;
    var start = wind > 0 ? -a * 0.8 : 0;
    if (o <= 0) return lerp(start, 1, ease(curve || "kit.whip", q));
    if (q < 0.62) return lerp(start, 1 + o, ease(curve || "kit.whip", q / 0.62));
    return 1 + o - o * ease("kit.land", (q - 0.62) / 0.38);
  }

  // ---------- the 5x7 pixel font ----------
  var G = {
    A: ".###.#...##...#######...##...##...#", B: "####.#...##...#####.#...##...#####.", C: ".###.#...##....#....#....#...#.###.",
    D: "####.#...##...##...##...##...#####.", E: "######....#....####.#....#....#####", F: "######....#....####.#....#....#....",
    G: ".###.#...##....#.####...##...#.####", H: "#...##...##...#######...##...##...#", I: ".###...#....#....#....#....#...###.",
    J: "..###...#....#....#....#.#..#..##..", K: "#...##..#.#.#..##...#.#..#..#.#...#", L: "#....#....#....#....#....#....#####",
    M: "#...###.###.#.##.#.##...##...##...#", N: "#...##...###..##.#.##..###...##...#", O: ".###.#...##...##...##...##...#.###.",
    P: "####.#...##...#####.#....#....#....", Q: ".###.#...##...##...##.#.##..#..##.#", R: "####.#...##...#####.#.#..#..#.#...#",
    S: ".#####....#.....###.....#....#####.", T: "#####..#....#....#....#....#....#..", U: "#...##...##...##...##...##...#.###.",
    V: "#...##...##...##...##...#.#.#...#..", W: "#...##...##...##.#.##.#.##.#.#.#.#.", X: "#...##...#.#.#...#...#.#.#...##...#",
    Y: "#...##...#.#.#...#....#....#....#..", Z: "#####....#...#...#...#...#....#####",
    "0": ".###.#...##..###.#.###..##...#.###.", "1": "..#...##....#....#....#....#...###.", "2": ".###.#...#....#...#...#...#...#####",
    "3": "####.....#....#.###.....#....#####.", "4": "...#...##..#.#.#..#.#####...#....#.", "5": "######....####.....#....##...#.###.",
    "6": "..##..#...#....####.#...##...#.###.", "7": "#####....#...#...#...#....#....#...", "8": ".###.#...##...#.###.#...##...#.###.",
    "9": ".###.#...##...#.####....#...#..##..",
    ".": "..........................##...##..", ",": ".....................##....#...#...", ":": "......##...##.........##...##......",
    "!": "..#....#....#....#....#.........#..", "?": ".###.#...#....#...#...#.........#..", "'": "..#....#...#.......................",
    "-": "................###................", "+": "......#....#..#####..#....#........", "=": "..........#####.....#####..........",
    "/": "....#...#....#...#...#....#...#....", "%": "##..###.#....#...#...#....#.###..##", "(": "...#...#...#....#....#.....#.....#.",
    ")": ".#.....#.....#....#....#...#...#...", "&": ".##..#..#.#.#...#...#.#.##..#..##.#", "~": "...........#...#.#.#...#...........",
    "°": ".##..#..#.#..#..##.................", "×": ".....#...#.#.#...#...#.#.#...#.....", "÷": ".......#.......#####.......#.......",
    "↓": "..#....#....#..#.#.#.###...#.......", "→": "......#......#.#####...#...#.......", '"': ".#.#..#.#..........................",
    "*": "......#..#.#.#.###.#.#.#..#........", "<": "...#...#...#...#.....#.....#.....#.", ">": ".#.....#.....#.....#...#...#...#...",
  };
  G["−"] = G["-"];
  function glyph(ch) {
    var g = G[ch] || G[ch.toUpperCase()];
    if (!g) return null;
    while (g.length < 35) g += ".";
    return g;
  }
  function textWidth(s, scale, bold) { return s.length * (bold ? 7 : 6) * scale - scale; }

  // ---------- the frame buffer ----------
  function Frame() { this.px = new Uint8ClampedArray(W * H * 4); }
  Frame.prototype.set = function (x, y, c) {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    var i = (y * W + x) * 4; this.px[i] = c[0]; this.px[i + 1] = c[1]; this.px[i + 2] = c[2]; this.px[i + 3] = 255;
  };
  Frame.prototype.get = function (x, y) { var i = (y * W + x) * 4; return [this.px[i], this.px[i + 1], this.px[i + 2]]; };

  function drawText(f, s, x, y, colour, outline, scale, keyRanges, flashKey, bold) {
    scale = scale || 1;
    var adv = bold ? 7 : 6, thick = bold ? 2 : 1;
    var chars = s.split("");
    for (var pass = 0; pass < 2; pass++) {
      for (var k = 0; k < chars.length; k++) {
        var g = glyph(chars[k]);
        if (!g) continue;
        var key = keyRanges && keyRanges[k];
        var col = pass === 0 ? outline : key ? (flashKey ? [255, 255, 255] : key) : colour;
        var ox = x + k * adv * scale;
        for (var r = 0; r < 7; r++) for (var c = 0; c < 5; c++) {
          if (g[r * 5 + c] !== "#") continue;
          for (var sy = 0; sy < scale; sy++) for (var sx = 0; sx < scale * thick; sx++) {
            var px = ox + c * scale + sx, py = y + r * scale + sy;
            if (pass === 0) { for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) f.set(px + dx, py + dy + (dy === 1 && dx === 1 ? 0 : 0), col); f.set(px + 1, py + 2, col); }
            else f.set(px, py, col);
          }
        }
      }
    }
  }

  // ---------- shapes: inside tests in local coordinates u, v (-1 to 1) ----------
  var SHAPES = {
    circle: function (u, v) { return u * u + v * v <= 1; },
    ellipse: function (u, v) { return u * u + v * v <= 1; },
    box: function (u, v) { return Math.abs(u) <= 1 && Math.abs(v) <= 1; },
    roundrect: function (u, v) { return Math.pow(Math.abs(u), 6) + Math.pow(Math.abs(v), 6) <= 1; },
    capsule: function (u, v, a) {
      if (a >= 1) { var r = 1 / a; var cu = clamp(u, -1 + r, 1 - r); return ((u - cu) * a) * ((u - cu) * a) + v * v <= 1; }
      var r2 = a; var cv = clamp(v, -1 + r2, 1 - r2); return u * u + ((v - cv) / a) * ((v - cv) / a) <= 1;
    },
    blob: function (u, v, a, seed) { var th = Math.atan2(v, u); var rr = 0.9 + 0.07 * Math.sin(3 * th + seed * 6) + 0.04 * Math.sin(5 * th + seed * 11); return u * u + v * v <= rr * rr; },
    droplet: function (u, v) { if (u * u + ((v - 0.32) / 0.68) * ((v - 0.32) / 0.68) <= 1) return true; return v >= -1 && v < 0.32 && Math.abs(u) <= ((v + 1) / 1.32) * 0.95; },
    spike: function (u, v) { return v >= -1 && v <= 1 && Math.abs(u) <= (v + 1) / 2; },
    hexagon: function (u, v) { return Math.abs(v) <= 0.87 && 0.87 * Math.abs(u) + 0.5 * Math.abs(v) <= 0.87; },
    star: function (u, v) { var th = Math.atan2(v, u) - Math.PI / 2; var r = Math.sqrt(u * u + v * v); var k = Math.pow((Math.cos(5 * th) + 1) / 2, 2); return r <= 0.42 + 0.58 * k; },
    bubble: function (u, v) { var r = u * u + v * v; return r <= 1 && r >= 0.62; },
    ring: function (u, v) { var r = u * u + v * v; return r <= 1 && r >= 0.78; },
    arrow: function (u, v) { if (u <= 0.25 && u >= -1 && Math.abs(v) <= 0.36) return true; return u > 0.25 && u <= 1 && Math.abs(v) <= ((1 - u) / 0.75); },
    cloud: function (u, v) { function d(cx, cy, r) { return (u - cx) * (u - cx) + (v - cy) * (v - cy) <= r * r; } return d(-0.5, 0.2, 0.5) || d(0.1, -0.15, 0.62) || d(0.55, 0.2, 0.45) || (v >= 0.1 && v <= 0.65 && Math.abs(u) <= 0.9); },
    wave: function (u, v, a, seed, t) { return Math.abs(v - 0.55 * Math.sin(Math.PI * (u * 2 + t * 2 + seed))) <= 0.3; },
    bowl: function (u, v) { if (v < -0.35) return u * u + ((v + 0.35) / 0.25) * ((v + 0.35) / 0.25) <= 1; return v <= 1 && u * u + ((v + 0.35) / 1.35) * ((v + 0.35) / 1.35) <= 1; },
    microwave: function (u, v) { return Math.pow(Math.abs(u), 10) + Math.pow(Math.abs(v), 10) <= 1; },
  };

  // ---------- backdrops: a colour for every world point ----------
  function bandColour(cols, t, x, y) {
    var n = cols.length - 1; var p = clamp(t, 0, 0.9999) * n; var i = Math.floor(p); var fr = p - i;
    return fr > bayer(x, y) ? cols[Math.min(n, i + 1)] : cols[i];
  }
  var BACKDROPS = {
    plain: function (cols) { return function (wx, wy, sx, sy) { return bandColour(cols, (sy / H), sx, sy); }; },
    kitchen_night: function (cols, seed) {
      // wall gradient, tile grid, a night window top left, the counter at y > 70
      return function (wx, wy, sx, sy) {
        if (wy > 70) {
          if (wy < 76) return wy < 72 ? cols[5] : cols[4];
          var door = ((Math.floor((wx + 400) / 44)) & 1) === 0;
          var edge = ((wx + 400) % 44 + 44) % 44;
          if (edge < 1.2) return cols[0];
          if (Math.abs(edge - 22) < 2 && wy > 84 && wy < 94) return cols[3];
          return wy > 150 ? cols[0] : door ? cols[1] : mixc(cols[1], cols[0], 0.3);
        }
        // window
        if (wx > -84 && wx < -30 && wy > -188 && wy < -118) {
          if (Math.abs(wx + 57) < 1 || Math.abs(wy + 153) < 1 || wx < -82 || wx > -32 || wy < -186 || wy > -120) return cols[4];
          if ((wx + 46) * (wx + 46) + (wy + 172) * (wy + 172) < 30 && !((wx + 43) * (wx + 43) + (wy + 174) * (wy + 174) < 26)) return [240, 226, 190];
          var hgt = -126 - 8 * hash(Math.floor((wx + 200) / 5) + seed) - 4;
          if (wy > hgt) return (hash2(Math.floor(wx), Math.floor(wy)) > 0.86 && wy > hgt + 2) ? [246, 205, 110] : cols[0];
          return hash2(Math.floor(wx * 3), Math.floor(wy * 3)) > 0.995 ? [220, 220, 255] : mixc(cols[0], cols[1], clamp((wy + 188) / 70, 0, 1));
        }
        var tx = ((wx + 600) % 14 + 14) % 14, ty = ((wy + 600) % 14 + 14) % 14;
        var base = bandColour([cols[2], cols[1]], clamp((wy + 160) / 230, 0, 1), sx, sy);
        if (tx < 0.9 || ty < 0.9) return darken(base, 0.25);
        return base;
      };
    },
    micro_field: function (cols, seed, tt) {
      return function (wx, wy, sx, sy) {
        var px = wx * 0.4, py = wy * 0.4 - tt * 3;
        var cx = Math.floor(px / 40), cy = Math.floor(py / 40);
        var best = 9;
        for (var j = -1; j <= 1; j++) for (var i = -1; i <= 1; i++) {
          var hx = (cx + i) * 40 + 40 * hash2(cx + i + seed, cy + j), hy = (cy + j) * 40 + 40 * hash2(cy + j, cx + i + seed * 3);
          var r = 10 + 14 * hash2(cx + i, cy + j + 7);
          var d = Math.sqrt((px - hx) * (px - hx) + (py - hy) * (py - hy)) / r;
          if (d < best) best = d;
        }
        var g = clamp((sy / H) * 0.8 + 0.1, 0, 1);
        var bg = bandColour([cols[0], cols[1]], g, sx, sy);
        if (best < 1) return (1 - best) * 0.55 > bayer(sx, sy) ? cols[2] : bg;
        if (hash2(Math.floor(px * 2), Math.floor(py * 2)) > 0.996) return cols[3];
        return bg;
      };
    },
    night_city: function (cols, seed) {
      return function (wx, wy, sx, sy) {
        var skyT = clamp((wy + 200) / 260, 0, 1);
        var col = Math.floor((wx + 1000) / 9);
        var top = 20 - 50 * hash(col + seed);
        if (wy > top) {
          var lit = hash2(Math.floor(wx / 3), Math.floor(wy / 4)) > 0.82 && ((Math.floor(wx) % 3) !== 0) && ((Math.floor(wy) % 4) > 1);
          return lit ? [248, 204, 90] : cols[1];
        }
        if (hash2(Math.floor(wx * 2), Math.floor(wy * 2)) > 0.997) return [230, 230, 255];
        return bandColour([cols[0], cols[2], cols[3]], skyT, sx, sy);
      };
    },
    sunset_land: function (cols) {
      return function (wx, wy, sx, sy) {
        if (wy > 20) return bandColour([cols[3], cols[4]], clamp((wy - 20) / 140, 0, 1), sx, sy);
        return bandColour([cols[0], cols[1], cols[2], cols[3]], clamp((wy + 160) / 180, 0, 1), sx, sy);
      };
    },
    body_plum: function (cols, seed, tt) {
      return function (wx, wy, sx, sy) {
        var arch = Math.abs(wy + 60 - 0.004 * wx * wx);
        if (arch < 3) return cols[3];
        var d = Math.sin(wx * 0.05 + tt * 0.6) * Math.sin(wy * 0.04 - tt * 0.4);
        var base = bandColour([cols[0], cols[1]], clamp((sy / H), 0, 1), sx, sy);
        return d > 0.6 && (d - 0.6) * 2 > bayer(sx, sy) ? cols[2] : base;
      };
    },
    fields_night: function (cols, seed) {
      return function (wx, wy, sx, sy) {
        var fx = Math.floor((wx + 1000) / 26), fy = Math.floor((wy + 1000) / 18);
        var k = Math.floor(hash2(fx + seed, fy) * 3);
        var c = cols[1 + k];
        if (((wx + 1000) % 26) < 1 || ((wy + 1000) % 18) < 1) return cols[0];
        return c;
      };
    },
    space: function (cols, seed) {
      return function (wx, wy, sx, sy) {
        if (hash2(Math.floor(wx * 1.5), Math.floor(wy * 1.5) + seed) > 0.993) return [235, 235, 255];
        return bandColour([cols[0], cols[1]], clamp(sy / H, 0, 1), sx, sy);
      };
    },
  };
  var DEFAULT_BACKDROP = {
    plain: ["#0b0d26", "#1c2256"], kitchen_night: ["#090b22", "#1a1f4d", "#262b63", "#3c3a75", "#7a5a3a", "#b0844f"],
    micro_field: ["#0a0c26", "#16194a", "#232a66", "#9fe3ec"], night_city: ["#0d1133", "#151a45", "#2b2a6b", "#5a3d7a"],
    sunset_land: ["#12163c", "#471f47", "#b8563c", "#e9a65a", "#eea676"], body_plum: ["#1d0b2a", "#3b164f", "#5a2a6a", "#7a4a7a"],
    fields_night: ["#070a1d", "#13271c", "#22331f", "#453331"], space: ["#05061a", "#141a4a"],
  };

  // ---------- the engine ----------
  function create(canvas, film, build, options) {
    options = options || {};
    var scale = Math.max(1, Math.round(canvas.width / W));
    var ctx = canvas.getContext("2d");
    var low = document.createElement("canvas"); low.width = W; low.height = H;
    var lctx = low.getContext("2d");
    var image = lctx.createImageData(W, H);
    var fps = film.fps;
    var shots = film.shots;
    var stages = {};
    build.stages.forEach(function (s) { stages[s.shotId] = s; });
    var look = film.look;
    var textCol = rgb(look.palette.text), keyCol = rgb(look.palette.keyword), outlineCol = [10, 11, 30];
    var grain = makeGrain();
    // The microwave's display counts down to the film's beep, when it has one.
    var beepMs = film.durationMs;
    for (var bi = shots.length - 1; bi >= 0; bi--) if (shots[bi].sound.hitSfx === "beep") { beepMs = shots[bi].startMs + shots[bi].oneMoment.hitAtMs; break; }

    function makeGrain() {
      var g = document.createElement("canvas"); g.width = 256; g.height = 256;
      var gc = g.getContext("2d"); var d = gc.createImageData(256, 256);
      for (var i = 0; i < 256 * 256; i++) { var v = 128 + (hash(i * 7 + 3) - 0.5) * 120; d.data[i * 4] = v; d.data[i * 4 + 1] = v; d.data[i * 4 + 2] = v; d.data[i * 4 + 3] = 255; }
      gc.putImageData(d, 0, 0); return g;
    }

    function shotAt(ms) {
      for (var i = 0; i < shots.length; i++) if (ms < shots[i].endMs) return i;
      return shots.length - 1;
    }

    function holdOf(shot) { return shot.motionStyle.cadence === "threes" ? 3 : shot.motionStyle.cadence === "twos" ? 2 : 1; }

    /** An actor's state at a time in its shot. `delay` shifts the actor's clock (a copy in a field reacting late). */
    function actorState(actor, t, delay, shot, initRot) {
      var s = { x: actor.x, y: actor.y, w: actor.w, h: actor.h, scale: 1, sx: 1, sy: 1, rot: (actor.rotate || 0) + (initRot || 0), colour: rgb(actor.colour), colourTo: null, colourMix: 0,
        expression: actor.face ? actor.face.expression : null, visible: actor.hidden !== true, blink: false, glow: 1, look: actor.face && actor.face.look ? actor.face.look.slice() : [0, 0], vx: 0, vy: 0 };
      var acts = actor.actions.slice().sort(function (a, b) { return a.atMs - b.atMs; });
      var tt = t - delay;
      for (var i = 0; i < acts.length; i++) {
        var a = acts[i];
        if (tt < a.atMs) continue;
        var p = clamp((tt - a.atMs) / a.durMs, 0, 1);
        var to = a.to || {};
        switch (a.do) {
          case "enter": { s.visible = true; var e = arc(p, 0, a.overshoot == null ? 0.18 : a.overshoot, a.curve || "kit.land"); s.scale *= Math.max(0, e); break; }
          case "exit": { var x = 1 - ease(a.curve || "kit.leave", p); s.scale *= x; if (p >= 1) s.visible = false; break; }
          case "move": case "grow": case "shrink": case "rotate": {
            var f = arc(p, a.anticipation || 0, a.overshoot || 0, a.curve);
            var fPrev = arc(clamp(p - 1 / (fps * a.durMs / 1000), 0, 1), a.anticipation || 0, a.overshoot || 0, a.curve);
            if (to.x !== undefined) { s.vx += (to.x - s.x) * (f - fPrev); s.x = lerp(s.x, to.x, f); }
            if (to.y !== undefined) { s.vy += (to.y - s.y) * (f - fPrev); s.y = lerp(s.y, to.y, f); }
            if (to.w !== undefined) s.w = lerp(s.w, to.w, f);
            if (to.h !== undefined) s.h = lerp(s.h, to.h, f);
            if (to.scale !== undefined) s.scale *= lerp(1, to.scale, f);
            if (to.rotate !== undefined) s.rot = lerp(s.rot, to.rotate, f);
            if (to.expression && p > 0.5) s.expression = to.expression;
            break;
          }
          case "pop": { var k = p < 0.22 ? ease("kit.whip", p / 0.22) : 1 - ease("kit.land", (p - 0.22) / 0.78); s.scale *= 1 + (a.amount != null ? a.amount / 100 : 0.3) * k; s.sy *= 1 - 0.08 * k; if (to.expression) s.expression = to.expression; break; }
          case "squash": { var q = p * (a.durMs / 1000); var env = p < 0.15 ? p / 0.15 : Math.exp(-6 * (p - 0.15)) * Math.cos(13 * (p - 0.15)); var amt = (a.amount != null ? a.amount / 100 : 0.3) * env; s.sx *= 1 + amt; s.sy *= 1 - amt; if (to.expression) s.expression = to.expression; break; }
          case "spin": { if (p < 1) s.rot += 360 * (a.hz || 1) * (tt - a.atMs) / 1000; else s.rot += 360 * (a.hz || 1) * a.durMs / 1000; break; }
          case "wiggle": { if (p < 1) s.rot += (a.amount || 10) * Math.sin(2 * Math.PI * (a.hz || 2) * (tt - a.atMs) / 1000) * (1 - p * 0.3); break; }
          case "jitter": {
            if (p < 1) { var step = Math.floor((tt - a.atMs) / (1000 / (a.hz || 15))); var am = a.amount || 2; var seed = (actor.id.length * 31 + delay) | 0; s.x += (hash2(step, seed) - 0.5) * 2 * am; s.y += (hash2(seed, step + 99) - 0.5) * 2 * am; if (to.rotate !== undefined) s.rot += (hash2(step, seed + 5) > 0.5 ? 1 : -1) * to.rotate; }
            break;
          }
          case "colour": { if (to.colour) { s.colourTo = rgb(to.colour); s.colourMix = ease(a.curve || "kit.reveal", p); if (p >= 1) { s.colour = s.colourTo; s.colourTo = null; s.colourMix = 0; } } break; }
          case "express": { if (to.expression) s.expression = to.expression; if (p < 1) s.scale *= 1 + 0.07 * Math.sin(Math.PI * clamp((tt - a.atMs) / 140, 0, 1)); break; }
          case "mirror": { s.sx *= Math.cos(Math.PI * p); break; }
          case "blink": { if (tt - a.atMs < Math.min(a.durMs, 140)) s.blink = true; break; }
          case "shake": { if (p < 1) s.x += (a.amount || 3) * (1 - p) * Math.sin(2 * Math.PI * (a.hz || 18) * (tt - a.atMs) / 1000); break; }
          case "bob": { if (p < 1) s.y += (a.amount || 2) * Math.sin(2 * Math.PI * (a.hz || 1) * (tt - a.atMs) / 1000 + delay * 0.01); break; }
          case "glow": { if (p < 1) s.glow *= 1 + (a.amount != null ? a.amount / 100 : 0.8) * Math.sin(Math.PI * p); break; }
        }
        if (to.alpha !== undefined && a.do !== "enter" && a.do !== "exit") s.visible = to.alpha > 0.01 || p < 1;
      }
      if (shot && shot.motionStyle.squashStretch) {
        var speed = Math.sqrt(s.vx * s.vx + s.vy * s.vy) / Math.max(4, s.h);
        var st = clamp(speed * 1.6, 0, 0.45);
        if (st > 0.02) { if (Math.abs(s.vy) >= Math.abs(s.vx)) { s.sy *= 1 + st; s.sx *= 1 - st * 0.5; } else { s.sx *= 1 + st; s.sy *= 1 - st * 0.5; } }
      }
      return s;
    }

    function cameraState(stage, t, length) {
      var c = stage.camera; var start = c.atMs || 0; var dur = c.durMs || (length - start);
      var p = ease(c.curve || (c.move === "dive_in" ? "kit.heavy" : "kit.drift"), clamp((t - start) / Math.max(1, dur), 0, 1));
      if (c.move === "dive_in" || c.move === "dive_out") {
        // A scale cut: zoom is interpolated on a log scale, so the dive keeps an even speed through the scales.
        var z = Math.exp(lerp(Math.log(c.from.zoom), Math.log(c.to.zoom), p));
        return { x: lerp(c.from.x, c.to.x, p), y: lerp(c.from.y, c.to.y, p), zoom: z };
      }
      return { x: lerp(c.from.x, c.to.x, p), y: lerp(c.from.y, c.to.y, p), zoom: lerp(c.from.zoom, c.to.zoom, p) };
    }

    function drawActor(f, actor, s, cam, idx, t, glows, shot, ghost) {
      if (!s.visible || s.scale <= 0.01) return;
      // A mirrored actor (a flip) has a negative width: the shape is drawn mirrored, and edge-on for a frame mid-flip.
      var hwS = (s.w / 2) * s.scale * s.sx * cam.zoom, hw = Math.abs(hwS), hh = (s.h / 2) * s.scale * s.sy * cam.zoom;
      if (hw < 0.5 || hh < 0.5) return;
      var cx = (s.x - cam.x) * cam.zoom + W / 2 + cam.ox, cy = (s.y - cam.y) * cam.zoom + H / 2 + cam.oy;
      var r = (s.rot * Math.PI) / 180, cr = Math.cos(r), sr = Math.sin(r);
      var ext = Math.ceil(Math.sqrt(hw * hw + hh * hh)) + 2;
      if (cx + ext < 0 || cx - ext > W || cy + ext < 0 || cy - ext > H) return;
      var inside = SHAPES[actor.shape] || SHAPES.ellipse;
      var aspect = hw / hh;
      var seed = (actor.id.charCodeAt(0) + idx * 0.37) % 1;
      var x0 = Math.floor(cx - ext), x1 = Math.ceil(cx + ext), y0 = Math.floor(cy - ext), y1 = Math.ceil(cy + ext);
      var bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      var mask = new Uint8Array(bw * bh);
      var tsec = t / 1000;
      for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) {
        var dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        var u = (dx * cr + dy * sr) / hwS, v = (-dx * sr + dy * cr) / hh;
        if (u < -1.05 || u > 1.05 || v < -1.05 || v > 1.05) continue;
        if (inside(u, v, aspect, seed, tsec)) mask[(y - y0) * bw + (x - x0)] = 1;
      }
      var base = s.colour, toCol = s.colourTo;
      var shadeHex = actor.shade ? rgb(actor.shade) : null;
      var outline = actor.outline === false ? null : darken(base, 0.72);
      for (var yy = 0; yy < bh; yy++) for (var xx = 0; xx < bw; xx++) {
        if (!mask[yy * bw + xx]) continue;
        var X = x0 + xx, Y = y0 + yy;
        if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
        var edge = xx === 0 || yy === 0 || xx === bw - 1 || yy === bh - 1 || !mask[yy * bw + xx - 1] || !mask[yy * bw + xx + 1] || !mask[(yy - 1) * bw + xx] || !mask[(yy + 1) * bw + xx];
        var c = base;
        if (toCol && s.colourMix > bayer(X, Y)) c = toCol;
        if (ghost) { if (bayer(X, Y) < 0.5) f.set(X, Y, lighten(c, 0.15)); continue; }
        if (edge && outline) { f.set(X, Y, toCol && s.colourMix > 0.5 ? darken(toCol, 0.72) : outline); continue; }
        var ddx = X + 0.5 - cx, ddy = Y + 0.5 - cy;
        var lu = (ddx * cr + ddy * sr) / hwS, lv = (-ddx * sr + ddy * cr) / hh;
        var light = 0.5 - 0.32 * lu - 0.42 * lv;
        var shade = shadeHex || darken(c, 0.38);
        if (light < 0.32 && (0.32 - light) * 3.2 > bayer(X, Y)) c = shade;
        else if (light > 0.8 && (light - 0.8) * 4 > bayer(X, Y)) c = lighten(c, 0.35);
        f.set(X, Y, c);
      }
      if (ghost) return;
      if (actor.shape === "microwave") drawMicrowave(f, cx, cy, hw, hh, base, t);
      if (actor.shape === "bowl") drawBowlTop(f, cx, cy, hw, hh, base, s);
      if (actor.shape === "bubble") f.set(Math.round(cx - hw * 0.45), Math.round(cy - hh * 0.45), [255, 255, 255]);
      if (actor.face) drawFace(f, actor, s, cx, cy, hw, hh, cr, sr, cam);
      if (actor.label && idx === 0) drawLabel(f, actor.label, cx, cy, hw, hh);
      if (actor.glow) glows.push({ x: cx, y: cy, r: Math.max(hw, hh) * 1.7, c: actor.glow, k: s.glow });
    }

    function drawMicrowave(f, cx, cy, hw, hh, base, t) {
      // window on the left two thirds, control panel on the right with the countdown display
      var wx0 = Math.round(cx - hw * 0.86), wx1 = Math.round(cx + hw * 0.36), wy0 = Math.round(cy - hh * 0.72), wy1 = Math.round(cy + hh * 0.72);
      var on = options.microwaveOn ? options.microwaveOn(t) : 1;
      var inner = mixc([20, 18, 30], [255, 196, 96], 0.55 * on), dark = darken(base, 0.75);
      for (var y = wy0; y <= wy1; y++) for (var x = wx0; x <= wx1; x++) {
        if (x === wx0 || x === wx1 || y === wy0 || y === wy1) { f.set(x, y, dark); continue; }
        var g = 1 - Math.abs((y - wy0) / (wy1 - wy0) - 0.35) * 1.2;
        f.set(x, y, g * 0.9 > bayer(x, y) ? inner : darken(inner, 0.35));
      }
      // turntable
      var ty = wy1 - Math.max(2, Math.round((wy1 - wy0) * 0.14));
      for (var x2 = wx0 + 3; x2 <= wx1 - 3; x2++) f.set(x2, ty, darken(inner, 0.5));
      var px0 = Math.round(cx + hw * 0.5), px1 = Math.round(cx + hw * 0.86);
      var remain = Math.max(0, Math.ceil((beepMs - (options.filmMs || 0)) / 1000));
      var txt = "0" + (Math.floor(remain / 60)) + ":" + ("0" + (remain % 60)).slice(-2);
      txt = txt.slice(-4);
      var dw = textWidth(txt, 1), dx = Math.round((px0 + px1) / 2 - dw / 2), dy = Math.round(cy - hh * 0.62);
      for (var yy = dy - 2; yy <= dy + 8; yy++) for (var xx = dx - 2; xx <= dx + dw + 1; xx++) f.set(xx, yy, [12, 20, 16]);
      drawText(f, txt, dx, dy, [120, 255, 170], [12, 20, 16], 1, null, false);
      for (var b = 0; b < 3; b++) { var by = Math.round(cy - hh * 0.1 + b * hh * 0.28); for (var bx = px0 + 1; bx <= px1 - 1; bx++) { f.set(bx, by, darken(base, 0.45)); f.set(bx, by + 1, darken(base, 0.45)); } }
    }

    function drawBowlTop(f, cx, cy, hw, hh, base, s) {
      var top = cy + (-0.35) * hh;
      var soup = rgb(look.palette.hero);
      var ry = hh * 0.25, rx = hw * 0.92;
      for (var y = Math.floor(top - ry); y <= Math.ceil(top + ry); y++) for (var x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        var u = (x + 0.5 - cx) / rx, v = (y + 0.5 - top) / ry;
        var d = u * u + v * v;
        if (d <= 1) f.set(x, y, d > 0.72 ? darken(soup, 0.3) : (v < -0.2 && 0.4 > bayer(x, y)) ? lighten(soup, 0.3) : soup);
      }
    }

    function eye(f, x, y, r, look, mode) {
      var white = [250, 248, 240], ink = [16, 14, 30];
      if (mode === "closed") { for (var i = -Math.round(r); i <= Math.round(r); i++) f.set(x + i, y, ink); return; }
      if (mode === "squint_left" || mode === "squint_right") {
        var dir = mode === "squint_left" ? 1 : -1;
        for (var k = 0; k <= Math.round(r); k++) { f.set(x - dir * k, y - k, ink); f.set(x - dir * k, y + k, ink); }
        return;
      }
      if (mode === "x") { for (var j = -Math.round(r); j <= Math.round(r); j++) { f.set(x + j, y + j, ink); f.set(x + j, y - j, ink); } return; }
      var rr = Math.max(1, r);
      for (var yy = -Math.ceil(rr); yy <= Math.ceil(rr); yy++) for (var xx = -Math.ceil(rr); xx <= Math.ceil(rr); xx++) {
        var d = xx * xx + yy * yy;
        if (d <= rr * rr + 0.5) f.set(x + xx, y + yy, d >= (rr - 0.8) * (rr - 0.8) && rr > 2 ? ink : white);
      }
      var pr = Math.max(1, rr * (mode === "small" ? 0.35 : 0.55));
      var px = x + Math.round(look[0] * (rr - pr)), py = y + Math.round(look[1] * (rr - pr));
      for (var y2 = -Math.ceil(pr); y2 <= Math.ceil(pr); y2++) for (var x2 = -Math.ceil(pr); x2 <= Math.ceil(pr); x2++) if (x2 * x2 + y2 * y2 <= pr * pr + 0.3) f.set(px + x2, py + y2, ink);
      if (rr >= 2) f.set(px - Math.max(0, Math.round(pr * 0.4)), py - Math.max(0, Math.round(pr * 0.4)), white);
      if (mode === "lid") for (var x3 = -Math.ceil(rr); x3 <= Math.ceil(rr); x3++) for (var y3 = -Math.ceil(rr); y3 <= 0; y3++) if (x3 * x3 + y3 * y3 <= rr * rr + 0.5) f.set(x + x3, y + y3, y3 === 0 ? ink : f.lidColour);
    }

    function drawFace(f, actor, s, cx, cy, hw, hh, cr, sr, cam) {
      var face = actor.face, ex = s.expression || "calm";
      var size = face.size ? face.size * s.scale * cam.zoom : Math.max(1.2, Math.min(hw, hh) * 0.26);
      if (ex === "surprised") size *= 1.18;
      var ink = [16, 14, 30];
      var fv = actor.shape === "droplet" ? 0.42 : actor.shape === "bowl" ? 0.35 : 0.06;
      var fcx = cx - fv * hh * sr, fcy = cy + fv * hh * cr;
      function at(u, v) { return [Math.round(fcx + u * hw), Math.round(fcy + (v - fv) * hh)]; }
      f.lidColour = darken(s.colour, 0.15);
      var mode = s.blink ? "closed" : ex === "sleepy" ? "closed" : ex === "smug" ? "lid" : ex === "dizzy" ? "x" : ex === "surprised" ? "small" : null;
      var eyes = face.eyes === "one" ? [[0.05, -0.2]] : [[-0.34, -0.12], [0.34, -0.12]];
      if (actor.shape === "droplet") eyes = face.eyes === "one" ? [[0, 0.25]] : [[-0.32, 0.28], [0.32, 0.28]];
      if (actor.shape === "bowl") eyes = [[-0.3, 0.2], [0.3, 0.2]];
      if (actor.shape === "microwave") eyes = [];
      for (var i = 0; i < eyes.length; i++) {
        var p = at(eyes[i][0], eyes[i][1]);
        var m = mode;
        if (ex === "strained" && !s.blink) m = i === 0 ? "squint_left" : "squint_right";
        eye(f, p[0], p[1], size, s.look, m);
        if (ex === "angry" || ex === "worried") {
          var dir = (i === 0 ? 1 : -1) * (ex === "angry" ? 1 : -1);
          var by = p[1] - Math.round(size) - 2;
          for (var k = -Math.round(size); k <= Math.round(size); k++) f.set(p[0] + k, by + Math.round(k * dir * 0.5), ink);
        }
      }
      var mouthV = actor.shape === "droplet" ? 0.62 : actor.shape === "bowl" ? 0.55 : 0.32;
      var mp = at(0, mouthV);
      var mw = Math.max(1, Math.round(Math.min(hw, hh) * 0.22));
      if (ex === "surprised") { for (var a = 0; a < 12; a++) { var th = a / 12 * Math.PI * 2; f.set(mp[0] + Math.round(Math.cos(th) * Math.max(1, mw * 0.5)), mp[1] + Math.round(Math.sin(th) * Math.max(1, mw * 0.6)), ink); } }
      else if (ex === "strained" || ex === "dizzy" || ex === "worried") { for (var w = -mw; w <= mw; w++) f.set(mp[0] + w, mp[1] + ((w & 1) ? 1 : 0), ink); }
      else if (ex === "angry") { for (var w2 = -mw; w2 <= mw; w2++) f.set(mp[0] + w2, mp[1] + (Math.abs(w2) === mw ? 1 : 0), ink); }
      else if (ex === "sleepy") { f.set(mp[0], mp[1], ink); f.set(mp[0] + 1, mp[1], ink); }
      else {
        var wide = ex === "happy" ? 1.4 : 1;
        var mm = Math.max(1, Math.round(mw * wide));
        for (var w3 = -mm; w3 <= mm; w3++) { var lift = Math.abs(w3) >= mm - 0 ? -1 : 0; if (ex === "smug" && w3 < 0) lift = 0; f.set(mp[0] + w3, mp[1] + lift, ink); }
        if (ex === "happy") for (var w4 = -mm + 1; w4 <= mm - 1; w4++) f.set(mp[0] + w4, mp[1] + 1, [190, 60, 70]);
      }
    }

    function drawLabel(f, label, cx, cy, hw, hh) {
      var txt = label.text.toUpperCase(); var tw = textWidth(txt, 1);
      var col = label.colour ? rgb(label.colour) : textCol;
      var x, y;
      if (label.side === "above") { x = Math.round(cx - tw / 2); y = Math.round(cy - hh - 12); }
      else if (label.side === "below") { x = Math.round(cx - tw / 2); y = Math.round(cy + hh + 5); }
      else if (label.side === "left") { x = Math.round(cx - hw - tw - 6); y = Math.round(cy - 3); }
      else { x = Math.round(cx + hw + 6); y = Math.round(cy - 3); }
      x = clamp(x, 2, W - tw - 2);
      drawText(f, txt, x, y, col, outlineCol, 1, null, false);
    }

    function drawFx(f, fx, t, cam, flashes) {
      var p = (t - fx.atMs) / fx.durMs;
      if (p < 0 || p > 1) return;
      var col = rgb(fx.colour);
      var cx = (fx.x - cam.x) * cam.zoom + W / 2 + cam.ox, cy = (fx.y - cam.y) * cam.zoom + H / 2 + cam.oy;
      var n = fx.count || 14, size = (fx.size || 30) * cam.zoom;
      var i, a, d;
      switch (fx.kind) {
        case "ring": {
          var rr = ease("kit.reveal", p) * size;
          for (a = 0; a < 160; a++) { var th = a / 160 * Math.PI * 2; if ((1 - p) > bayer(a, 3)) { f.set(Math.round(cx + Math.cos(th) * rr), Math.round(cy + Math.sin(th) * rr * 0.9), col); } }
          break;
        }
        case "burst": case "sparks": {
          for (i = 0; i < n; i++) {
            var ang = hash(i * 13 + fx.atMs) * Math.PI * 2, sp = (0.5 + hash(i * 7 + 1) * 0.5) * size;
            d = ease("kit.reveal", p) * sp;
            var px = cx + Math.cos(ang) * d, py = cy + Math.sin(ang) * d + 30 * p * p * cam.zoom * (fx.kind === "burst" ? 1 : 0.2);
            if (hash(i + 77) < 1 - p * 0.8) { f.set(Math.round(px), Math.round(py), col); if (fx.kind === "sparks") f.set(Math.round(px - Math.cos(ang) * 2), Math.round(py - Math.sin(ang) * 2), darken(col, 0.3)); }
          }
          break;
        }
        case "steam": {
          for (i = 0; i < n; i++) {
            var ph = (p * 1.4 + hash(i * 3)) % 1;
            var sx = cx + (hash(i * 5 + 2) - 0.5) * size * 0.9 + Math.sin(ph * 9 + i) * 3 * cam.zoom;
            var sy = cy - ph * size * 1.4;
            var r = Math.max(1, (1.5 + ph * 2.5) * cam.zoom * 0.6);
            if (ph > 0.85) continue;
            for (var yy = -Math.ceil(r); yy <= Math.ceil(r); yy++) for (var xx = -Math.ceil(r); xx <= Math.ceil(r); xx++) if (xx * xx + yy * yy <= r * r && (1 - ph) * 0.9 > bayer(Math.round(sx + xx), Math.round(sy + yy))) f.set(Math.round(sx + xx), Math.round(sy + yy), col);
          }
          break;
        }
        case "bubbles": {
          for (i = 0; i < n; i++) {
            var q = (p + hash(i * 11)) % 1;
            var bx = cx + (hash(i * 9 + 4) - 0.5) * size, byy = cy - q * size * 1.5;
            var br = 1 + Math.floor(hash(i) * 2);
            for (a = 0; a < 10; a++) { var t2 = a / 10 * Math.PI * 2; f.set(Math.round(bx + Math.cos(t2) * br), Math.round(byy + Math.sin(t2) * br), col); }
          }
          break;
        }
        case "rain": {
          for (i = 0; i < n * 4; i++) { var rx = (hash(i * 3) * W + t * 0.02) % W, ry = (hash(i * 5) * H + t * 0.4) % H; f.set(Math.round(rx), Math.round(ry), col); f.set(Math.round(rx), Math.round(ry) + 1, col); }
          break;
        }
        case "waves": {
          for (var band = 0; band < 3; band++) for (var x = 0; x < W; x++) {
            var yv = cy + (band - 1) * size * 0.5 + Math.sin((x / W) * Math.PI * 4 - t / 120 + band) * 4;
            if ((1 - Math.abs(p - 0.5) * 2) * 0.8 > bayer(x, band)) f.set(x, Math.round(yv), col);
          }
          break;
        }
        case "flash": { flashes.push({ k: 1 - ease("kit.reveal", p), c: fx.colour }); break; }
        case "shake": break;
      }
    }

    function cardAt(ms) { return film.cards.filter(function (c) { return ms >= c.atMs && ms < c.untilMs; }); }

    function keyRanges(line, keywords) {
      var marks = {}; var up = line.toUpperCase();
      (keywords || []).forEach(function (k) { var i = up.indexOf(k.toUpperCase()); if (i >= 0) for (var j = 0; j < k.length; j++) marks[i + j] = keyCol; });
      return marks;
    }

    var BAND_Y = { top: 60, centre: 150, bottom: 244 };

    function drawCards(f, ms) {
      var cards = cardAt(ms);
      var used = { top: 0, centre: 0, bottom: 0 };
      cards.forEach(function (card) {
        var lines = card.lines.map(function (l) { return l.toUpperCase(); });
        var y = BAND_Y[card.band] + used[card.band];
        // The keyword flashes white for one drawing when a card cuts on; frame 0 is the finished hook, so the first card never flashes.
        var fresh = card.atMs > 0 && ms - card.atMs < 2000 / fps;
        if (card.kind === "bubble") {
          var tw = Math.max.apply(null, lines.map(function (l) { return textWidth(l, 1); }));
          var bx = Math.round(W / 2 - tw / 2) - 4, bw = tw + 8, bh = lines.length * 10 + 5;
          for (var yy = y - 3; yy < y - 3 + bh; yy++) for (var xx = bx; xx < bx + bw; xx++) f.set(xx, yy, (yy === y - 3 || yy === y - 4 + bh || xx === bx || xx === bx + bw - 1) ? outlineCol : [250, 248, 240]);
          for (var k = 0; k < 3; k++) for (var q = -k; q <= 0; q++) f.set(W / 2 + q + 2, y - 3 + bh + 2 - k, k === 2 ? outlineCol : [250, 248, 240]);
          lines.forEach(function (l, i) { drawText(f, l, Math.round(W / 2 - textWidth(l, 1) / 2), y + i * 10, outlineCol, [250, 248, 240], 1, null, false); });
          used[card.band] += bh + 6;
          return;
        }
        var colour = card.kind === "source" ? [176, 172, 200] : textCol;
        lines.forEach(function (l, i) {
          drawText(f, l, Math.round(W / 2 - textWidth(l, 1, true) / 2), y + i * 11, colour, outlineCol, 1, keyRanges(l, card.keywords), fresh, true);
        });
        used[card.band] += lines.length * 11 + 5;
      });
      return used;
    }

    function formatHud(h, v) {
      if (h.format === "timer") { var s = Math.max(0, v); var m = Math.floor(s / 60); var sec = s - m * 60; return m + ":" + ("0" + Math.floor(sec)).slice(-2) + "." + ("0" + Math.floor((sec % 1) * 100)).slice(-2); }
      if (h.format === "decimal1") return v.toFixed(1);
      if (h.format === "decimal2") return v.toFixed(2);
      if (h.format === "thousands") return Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      return String(Math.round(v));
    }

    function drawHud(f, ms, used) {
      film.hud.forEach(function (h) {
        if (ms < h.fromMs || ms >= h.untilMs) return;
        var countFor = Math.min(h.untilMs - h.fromMs, h.countMs || 2400);
        var p = ease("kit.reveal", clamp((ms - h.fromMs) / countFor, 0, 1));
        var v = h.format === "timer" ? (ms - h.fromMs) / 1000 : lerp(h.from, h.to, p);
        var txt = formatHud(h, v);
        var sc = txt.length > 14 ? 1 : 2;
        var bold = sc === 1;
        var y = BAND_Y[h.band] + (used ? used[h.band] : 0);
        drawText(f, txt, Math.round(W / 2 - textWidth(txt, sc, bold) / 2), y, keyCol, outlineCol, sc, null, false, bold);
        if (h.unit) drawText(f, h.unit.toUpperCase(), Math.round(W / 2 - textWidth(h.unit, 1) / 2), y + 7 * sc + 4, textCol, outlineCol, 1, null, false);
      });
    }

    function renderAt(seconds) {
      var ms = Math.round(seconds * 1000);
      options.filmMs = ms;
      var i = shotAt(ms), shot = shots[i], stage = stages[shot.shotId];
      var local = ms - shot.startMs, length = shot.endMs - shot.startMs;
      var hold = holdOf(shot);
      var frame = Math.floor((local / 1000) * fps + 1e-6);
      var held = ((frame - (frame % hold)) / fps) * 1000;
      var cam = cameraState(stage, local, length);
      cam.ox = 0; cam.oy = 0;
      var flashes = [];
      stage.fx.forEach(function (fx) {
        if (fx.kind !== "shake") return;
        var p = (local - fx.atMs) / fx.durMs; if (p < 0 || p > 1) return;
        var amp = (fx.size || 4) * (1 - p) * (1 - p);
        cam.ox = Math.round((hash(frame * 3 + 1) - 0.5) * 2 * amp); cam.oy = Math.round((hash(frame * 5 + 2) - 0.5) * 2 * amp);
      });
      var f = new Frame();
      var bcols = (stage.backdrop.colours || DEFAULT_BACKDROP[stage.backdrop.kind]).map(rgb);
      var bd = BACKDROPS[stage.backdrop.kind](bcols, stage.backdrop.seed || 1, local / 1000);
      for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
        var wx = (x + 0.5 - W / 2 - cam.ox) / cam.zoom + cam.x, wy = (y + 0.5 - H / 2 - cam.oy) / cam.zoom + cam.y;
        f.set(x, y, bd(wx, wy, x, y));
      }
      var glows = [];
      var actors = stage.actors.slice().sort(function (a, b) { return (a.z || 0) - (b.z || 0); });
      var smear = shot.motionStyle.smears;
      var prevT = held - (hold * 1000) / fps;
      actors.forEach(function (actor) {
        var rep = actor.repeat;
        if (!rep) {
          if (smear && prevT >= 0) drawActor(f, actor, actorState(actor, prevT, 0, shot), cam, 0, prevT, [], shot, true);
          drawActor(f, actor, actorState(actor, held, 0, shot), cam, 0, held, glows, shot);
          return;
        }
        var n = 0;
        for (var r = 0; r < rep.rows; r++) for (var c = 0; c < rep.cols; c++) {
          var jit = rep.jitter || 0;
          var delay = n === 0 ? 0 : Math.round((rep.stagger || 0) * (0.35 + 0.65 * hash(n * 17 + 3)));
          var rot0 = (hash(n * 7) - 0.5) * (rep.spin || 0);
          var ox = c * rep.dx + (hash(n * 3 + 1) - 0.5) * 2 * jit, oy = r * rep.dy + (hash(n * 5 + 2) - 0.5) * 2 * jit;
          if (smear && prevT >= 0) {
            var g0 = actorState(actor, prevT, delay, shot, rot0); g0.x += ox; g0.y += oy;
            drawActor(f, actor, g0, cam, n, prevT, [], shot, true);
          }
          var s = actorState(actor, held, delay, shot, rot0);
          s.x += ox; s.y += oy;
          drawActor(f, actor, s, cam, n, held, n < 24 ? glows : [], shot);
          n++;
        }
      });
      stage.fx.forEach(function (fx) { drawFx(f, fx, local, cam, flashes); });
      var used = drawCards(f, ms);
      drawHud(f, ms, used);
      image.data.set(f.px);
      lctx.putImageData(image, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(low, 0, 0, W * scale, H * scale);
      ctx.globalCompositeOperation = "lighter";
      glows.forEach(function (g) {
        var c = rgb(g.c); var rad = g.r * scale;
        var grd = ctx.createRadialGradient(g.x * scale, g.y * scale, 0, g.x * scale, g.y * scale, rad);
        grd.addColorStop(0, "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + (0.26 * g.k).toFixed(3) + ")");
        grd.addColorStop(1, "rgba(" + c[0] + "," + c[1] + "," + c[2] + ",0)");
        ctx.fillStyle = grd; ctx.fillRect(g.x * scale - rad, g.y * scale - rad, rad * 2, rad * 2);
      });
      flashes.forEach(function (fl) { var c = rgb(fl.c); ctx.fillStyle = "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + (0.55 * fl.k).toFixed(3) + ")"; ctx.fillRect(0, 0, W * scale, H * scale); });
      ctx.globalCompositeOperation = "source-over";
      var vg = ctx.createRadialGradient(W * scale / 2, H * scale * 0.45, H * scale * 0.3, W * scale / 2, H * scale * 0.5, H * scale * 0.75);
      vg.addColorStop(0, "rgba(0,0,0,0)"); vg.addColorStop(1, "rgba(4,4,16,0.32)");
      ctx.fillStyle = vg; ctx.fillRect(0, 0, W * scale, H * scale);
      ctx.globalAlpha = 0.07; ctx.globalCompositeOperation = "soft-light";
      var gx = -Math.floor(hash(frame * 13 + i) * 256), gy = -Math.floor(hash(frame * 29 + i) * 256);
      for (var yy = gy; yy < H * scale; yy += 256) for (var xx = gx; xx < W * scale; xx += 256) ctx.drawImage(grain, xx, yy);
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
      return { shotId: shot.shotId, frame: frame };
    }

    return { renderAt: renderAt, durationMs: film.durationMs, fps: fps };
  }

  root.PixelEngine = { create: create, W: W, H: H, version: "pixel-engine@1" };
})(typeof window !== "undefined" ? window : globalThis);
