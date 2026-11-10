/* eslint-disable */
// The paper-cut story: a scene of cut-paper layers stacked back to front, each with a soft shadow on the layer behind it and a fine paper
// fibre, lit one by one at the start, then a slow parallax push-in. The story is told in serif lines on a paper strip, one per beat. On
// the last beat the light (a lighthouse beam, a window, a street lamp or a campfire, by scene) finds the hero. The push-in returns to its
// start and the layers settle back, so the last frame meets the first and the video loops.
//
// Look (chosen, Meridian's own): matte paper colours per time of day, a warm accent for the hero, soft drop shadows (blur 24, offset 10)
// between layers, edges with a small deterministic wobble so they read as cut by hand. Serif type (Charter) for the title and the story.
(function (root) {
  "use strict";
  var K = root.MeridianStyleKit;
  var W = K.W, H = K.H;

  var SKIES = {
    night: { sky: ["#0F1A33", "#1D2F57"], disc: "#F3E9C9", layers: ["#22365F", "#1B2B4D", "#15223D", "#101A30", "#0B1324"], ink: "#F3E9C9", hero: "#E5523B", glow: "rgba(255,226,150,", paper: "#F3E9C9" },
    dusk: { sky: ["#3B2A5C", "#E58B5A"], disc: "#FFD9A0", layers: ["#7A4E7A", "#5E3B66", "#462D55", "#331F42", "#221430"], ink: "#FFF1DE", hero: "#F2B33D", glow: "rgba(255,214,150,", paper: "#FFF1DE" },
    day: { sky: ["#9CCBE3", "#E9F2EE"], disc: "#FFF4D6", layers: ["#A9C7B5", "#86AE96", "#668F77", "#4C7360", "#365646"], ink: "#24343A", hero: "#E5523B", glow: "rgba(255,244,200,", paper: "#FBF6EA" },
  };

  function wobble(seed, x) { return Math.sin(x * 0.013 + seed) * 6 + Math.sin(x * 0.041 + seed * 2.3) * 2.5; }

  /** Fills a layer from a top edge function (x → y) down to the bottom, with a soft shadow on what is behind and a paper fibre. */
  function layer(ctx, edge, colour, seed, frame, opts) {
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 10;
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.moveTo(-40, H + 40);
    for (var x = -40; x <= W + 40; x += 12) ctx.lineTo(x, edge(x) + wobble(seed, x));
    ctx.lineTo(W + 40, H + 40);
    ctx.closePath();
    ctx.fill();
    ctx.shadowColor = "transparent";
    // paper fibre: seeded light flecks inside the shape
    ctx.clip();
    for (var i = 0; i < 260; i++) {
      var fx = K.hash(seed * 1000 + i) * W, fy = K.hash(seed * 2000 + i * 3) * H;
      ctx.fillStyle = "rgba(255,255,255," + (0.025 + 0.03 * K.hash(i + seed)).toFixed(3) + ")";
      ctx.fillRect(fx, fy, 2 + 3 * K.hash(i * 5 + seed), 1.5);
    }
    if (opts && opts.highlight) {
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (var x2 = -40; x2 <= W + 40; x2 += 12) { var y2 = edge(x2) + wobble(seed, x2) + 2; if (x2 === -40) ctx.moveTo(x2, y2); else ctx.lineTo(x2, y2); }
      ctx.stroke();
    }
    ctx.restore();
  }

  function cutShape(ctx, path, colour, shadow) {
    ctx.save();
    if (shadow !== false) { ctx.shadowColor = "rgba(0,0,0,0.35)"; ctx.shadowBlur = 18; ctx.shadowOffsetY = 8; }
    ctx.fillStyle = colour;
    ctx.beginPath(); path(ctx); ctx.fill();
    ctx.restore();
  }

  // ---------- the scenes: each returns its layers (back to front) and draws its hero with a light level ----------
  function sceneLayers(scene, pal, t) {
    var L = pal.layers;
    var sway = function (k) { return Math.sin(t * 0.9 + k) * 6; };
    if (scene === "lighthouse") {
      return [
        { edge: function (x) { return 1080 + Math.sin(x * 0.004) * 60 - x * 0.05; }, colour: L[0] },
        { edge: function (x) { return 1240 + Math.sin(x * 0.02 + t * 0.8) * 14 + sway(1); }, colour: L[1] },
        { edge: function (x) { return x > 660 ? 1010 + Math.sin(x * 0.03) * 10 : 1010 + Math.min(260, (660 - x) * 1.5); }, colour: L[3], hero: "lighthouse" },
        { edge: function (x) { return 1390 + Math.sin(x * 0.018 + t * 1.1 + 2) * 18 + sway(2); }, colour: L[2], boat: true },
        { edge: function (x) { return 1520 + Math.sin(x * 0.016 + t * 1.3 + 4) * 20 + sway(3); }, colour: L[4] },
      ];
    }
    if (scene === "mountains") {
      return [
        { edge: function (x) { return 900 + Math.abs(((x + 200) % 520) - 260) * 0.9 - 60; }, colour: L[0] },
        { edge: function (x) { return 1040 + Math.abs(((x + 60) % 640) - 320) * 0.85 - 120; }, colour: L[1] },
        { edge: function (x) { return 1240 + Math.sin(x * 0.006) * 40; }, colour: L[2], hero: "cabin" },
        { edge: function (x) { return 1420 + Math.sin(x * 0.02 + t * 0.7) * 8; }, colour: L[3], trees: true },
        { edge: function (x) { return 1560 + Math.sin(x * 0.012) * 26; }, colour: L[4] },
      ];
    }
    if (scene === "city") {
      var sky = function (base, w, seed) { return function (x) { var i = Math.floor((x + 400) / w); return base - 80 - K.hash(i * 31 + seed) * 360; }; };
      return [
        { edge: sky(1180, 90, 3), colour: L[0], windows: 0.25 },
        { edge: sky(1300, 120, 9), colour: L[1], windows: 0.5, hero: "tower" },
        { edge: sky(1440, 150, 17), colour: L[2], windows: 0.8 },
        { edge: function (x) { return 1600 + Math.sin(x * 0.01) * 10; }, colour: L[3], lamps: true },
        { edge: function (x) { return 1720; }, colour: L[4] },
      ];
    }
    return [
      { edge: function (x) { return 1000 + Math.sin(x * 0.01) * 50; }, colour: L[0], pines: 0.8 },
      { edge: function (x) { return 1140 + Math.sin(x * 0.014 + 1) * 40; }, colour: L[1], pines: 1 },
      { edge: function (x) { return 1300 + Math.sin(x * 0.009 + 2) * 30; }, colour: L[2], hero: "tent" },
      { edge: function (x) { return 1450 + Math.sin(x * 0.02 + 3) * 22; }, colour: L[3], pines: 1.3 },
      { edge: function (x) { return 1600 + Math.sin(x * 0.012 + 4) * 18; }, colour: L[4] },
    ];
  }

  function hero(ctx, kind, layerEdge, pal, light, t) {
    if (kind === "lighthouse") {
      var x = 820, base = layerEdge(x);
      cutShape(ctx, function (c) { c.moveTo(x - 46, base + 4); c.lineTo(x - 30, base - 300); c.lineTo(x + 30, base - 300); c.lineTo(x + 46, base + 4); c.closePath(); }, "#EDE3CC");
      for (var s = 0; s < 3; s++) cutShape(ctx, function (c) { var y = base - 60 - s * 90; c.rect(x - 42 + s * 5, y - 30, 84 - s * 10, 30); }, pal.hero, false);
      cutShape(ctx, function (c) { c.rect(x - 34, base - 360, 68, 60); }, "#2A2A2A");
      var lamp = ctx.createRadialGradient(x, base - 330, 4, x, base - 330, 60 + 40 * light);
      lamp.addColorStop(0, pal.glow + "0.95)"); lamp.addColorStop(1, pal.glow + "0)");
      ctx.fillStyle = lamp; ctx.beginPath(); ctx.arc(x, base - 330, 100, 0, Math.PI * 2); ctx.fill();
      cutShape(ctx, function (c) { c.moveTo(x - 44, base - 360); c.lineTo(x, base - 410); c.lineTo(x + 44, base - 360); c.closePath(); }, "#2A2A2A");
      return { x: x, y: base - 330 };
    }
    if (kind === "cabin") {
      var cx = 560, cb = layerEdge(cx);
      cutShape(ctx, function (c) { c.rect(cx - 90, cb - 110, 180, 120); }, "#7A4B33");
      cutShape(ctx, function (c) { c.moveTo(cx - 116, cb - 104); c.lineTo(cx, cb - 196); c.lineTo(cx + 116, cb - 104); c.closePath(); }, "#4A2C22");
      cutShape(ctx, function (c) { c.rect(cx - 30, cb - 80, 60, 50); }, K.css(K.mix(K.rgb("#3A2A22"), K.rgb("#FFD27A"), light)), false);
      return { x: cx, y: cb - 55 };
    }
    if (kind === "tower") {
      var tx = 540, tb = layerEdge(tx);
      cutShape(ctx, function (c) { c.moveTo(tx - 60, tb + 40); c.lineTo(tx - 40, tb - 420); c.lineTo(tx, tb - 520); c.lineTo(tx + 40, tb - 420); c.lineTo(tx + 60, tb + 40); c.closePath(); }, pal.layers[1]);
      for (var w = 0; w < 7; w++) cutShape(ctx, function (c) { c.rect(tx - 18, tb - 380 + w * 52, 36, 24); }, K.css(K.mix(K.rgb(pal.layers[0]), K.rgb("#FFD27A"), K.clamp(light * 7 - (6 - w), 0, 1))), false);
      cutShape(ctx, function (c) { c.arc(tx, tb - 528, 10, 0, Math.PI * 2); }, pal.hero, false);
      return { x: tx, y: tb - 300 };
    }
    var fx = 540, fb = layerEdge(fx);
    cutShape(ctx, function (c) { c.moveTo(fx - 150, fb - 4); c.lineTo(fx - 40, fb - 150); c.lineTo(fx + 70, fb - 4); c.closePath(); }, pal.hero);
    cutShape(ctx, function (c) { c.moveTo(fx - 70, fb - 4); c.lineTo(fx - 40, fb - 70); c.lineTo(fx - 10, fb - 4); c.closePath(); }, "#2A1C14", false);
    for (var f = 0; f < 3; f++) {
      var fl = 30 + 16 * Math.sin(t * 9 + f * 2) * light;
      cutShape(ctx, function (c) { c.moveTo(fx + 120 - 18 + f * 12, fb); c.quadraticCurveTo(fx + 120 + f * 6, fb - fl * light - 6, fx + 120 + 18 - f * 6, fb); c.closePath(); }, f === 1 ? "#FFD27A" : "#F2803D", false);
    }
    return { x: fx + 120, y: fb - 30 };
  }

  function times(spec) { return K.timeline(spec.durationMs / 1000, spec.beats.length, 2.2, 1.6); }

  function draw(ctx, t, frame, spec) {
    var pal = SKIES[spec.time];
    var tl = times(spec);
    var T = tl.duration;
    var layers = sceneLayers(spec.scene, pal, t);
    var n = spec.beats.length;
    // the push-in: in and back over the whole video, so the ends meet
    var push = 1 + 0.055 * Math.pow(Math.sin(Math.PI * t / T), 2);
    var back = 1 - K.move(t, T - 0.9, 0.85, "leave");
    var sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, pal.sky[0]); sky.addColorStop(1, pal.sky[1]);
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
    // stars at night
    if (spec.time === "night") for (var s = 0; s < 70; s++) {
      var tw = 0.4 + 0.6 * Math.abs(Math.sin(t * 1.3 + s));
      ctx.fillStyle = "rgba(243,233,201," + (0.5 * tw).toFixed(3) + ")";
      ctx.fillRect(K.hash(s * 3) * W, K.hash(s * 7 + 1) * 900, 3, 3);
    }
    // the disc (moon or sun) rises a little
    var rise = K.move(t, 0.2, 1.6, "reveal");
    var discX = spec.scene === "lighthouse" ? 280 : 760;
    cutShape(ctx, function (c) { c.arc(discX, 700 - 60 * rise, 96, 0, Math.PI * 2); }, pal.disc);

    ctx.save();
    ctx.translate(W / 2, H * 0.62);
    ctx.scale(push, push);
    ctx.translate(-W / 2, -H * 0.62);
    var lightAt = tl.beats[n - 1].start + 0.3;
    var light = K.move(t, lightAt, 1.2, "reveal") * back;
    var heroPoint = null;
    for (var i = 0; i < layers.length; i++) {
      var L = layers[i];
      var on = K.move(t, 0.3 + i * 0.32, 0.7, "land") * (i === 0 ? 1 : back + (1 - back) * 0);
      var visible = i === 0 ? 1 : K.clamp(on, 0, 1);
      if (visible <= 0) continue;
      ctx.save();
      // each layer slides up into place and moves with the push at its own depth (parallax)
      var depth = (i + 1) / layers.length;
      ctx.translate(0, (1 - visible) * 140 + (push - 1) * 600 * depth);
      ctx.globalAlpha = visible;
      layer(ctx, L.edge, L.colour, i + 1, frame, { highlight: true });
      if (L.windows) for (var wx = 0; wx < 26; wx++) {
        var bx = 30 + wx * 40, by = L.edge(bx) + 40 + K.hash(wx * 11 + i) * 160;
        if (K.hash(wx * 13 + i * 5) < L.windows * 0.6) { ctx.fillStyle = "rgba(255,214,122," + (0.25 + 0.6 * K.hash(wx + i)).toFixed(3) + ")"; ctx.fillRect(bx, by, 12, 16); }
      }
      if (L.pines) for (var p = 0; p < 9; p++) {
        var px = 40 + p * 125 + K.hash(p + i * 9) * 40, pb = L.edge(px) + 8, ph = 120 * L.pines * (0.7 + 0.5 * K.hash(p * 3 + i));
        cutShape(ctx, function (c) { c.moveTo(px - ph * 0.28, pb); c.lineTo(px, pb - ph); c.lineTo(px + ph * 0.28, pb); c.closePath(); }, L.colour);
      }
      if (L.trees) for (var q = 0; q < 6; q++) {
        var qx = 80 + q * 190, qb = L.edge(qx) + 6;
        cutShape(ctx, function (c) { c.moveTo(qx - 40, qb); c.lineTo(qx, qb - 170); c.lineTo(qx + 40, qb); c.closePath(); }, pal.layers[3]);
      }
      if (L.lamps) for (var m = 0; m < 4; m++) {
        var mx = 140 + m * 270, mb = L.edge(mx);
        cutShape(ctx, function (c) { c.rect(mx - 4, mb - 160, 8, 160); }, pal.layers[4]);
        var lg = ctx.createRadialGradient(mx, mb - 166, 2, mx, mb - 166, 70);
        lg.addColorStop(0, pal.glow + (0.4 + 0.5 * light).toFixed(3) + ")"); lg.addColorStop(1, pal.glow + "0)");
        ctx.fillStyle = lg; ctx.beginPath(); ctx.arc(mx, mb - 166, 70, 0, Math.PI * 2); ctx.fill();
      }
      if (L.hero) heroPoint = hero(ctx, L.hero, L.edge, pal, light, t);
      if (L.boat) {
        var bxp = 300 + Math.sin(t * 0.25) * 30, bb = L.edge(bxp) + 6 + Math.sin(t * 1.4) * 4;
        cutShape(ctx, function (c) { c.moveTo(bxp - 70, bb - 20); c.lineTo(bxp + 70, bb - 20); c.lineTo(bxp + 50, bb + 10); c.lineTo(bxp - 50, bb + 10); c.closePath(); }, "#2A1C14");
        cutShape(ctx, function (c) { c.moveTo(bxp - 6, bb - 24); c.lineTo(bxp - 6, bb - 150); c.lineTo(bxp + 60, bb - 30); c.closePath(); }, pal.hero);
        if (light > 0 && heroPoint) {
          // the beam: from the lamp, sweeping down to the boat
          var aim = Math.atan2(bb - 80 - heroPoint.y, bxp - heroPoint.x);
          var sweep = K.lerp(-0.4, aim, light);
          ctx.save();
          ctx.globalCompositeOperation = "lighter";
          var grad = ctx.createLinearGradient(heroPoint.x, heroPoint.y, bxp, bb - 60);
          grad.addColorStop(0, pal.glow + (0.6 * light).toFixed(3) + ")"); grad.addColorStop(1, pal.glow + (0.12 * light).toFixed(3) + ")");
          ctx.fillStyle = grad;
          ctx.beginPath(); ctx.moveTo(heroPoint.x, heroPoint.y);
          var reach = Math.hypot(bxp - heroPoint.x, bb - 80 - heroPoint.y) + 120;
          ctx.lineTo(heroPoint.x + Math.cos(sweep - 0.07) * reach, heroPoint.y + Math.sin(sweep - 0.07) * reach);
          ctx.lineTo(heroPoint.x + Math.cos(sweep + 0.07) * reach, heroPoint.y + Math.sin(sweep + 0.07) * reach);
          ctx.closePath(); ctx.fill();
          // the pool of light where the beam lands, once it has found the boat
          var found = K.clamp((light - 0.7) / 0.3, 0, 1);
          var pool = ctx.createRadialGradient(bxp, bb - 60, 4, bxp, bb - 60, 170);
          pool.addColorStop(0, pal.glow + (0.5 * found).toFixed(3) + ")"); pool.addColorStop(1, pal.glow + "0)");
          ctx.fillStyle = pool; ctx.beginPath(); ctx.arc(bxp, bb - 60, 170, 0, Math.PI * 2); ctx.fill();
          ctx.restore();
        }
      }
      ctx.restore();
    }
    // a warm glow on the hero once the light finds it (not the lighthouse, whose beam does it)
    if (heroPoint && spec.scene !== "lighthouse" && light > 0) {
      var hg = ctx.createRadialGradient(heroPoint.x, heroPoint.y, 4, heroPoint.x, heroPoint.y, 260);
      hg.addColorStop(0, pal.glow + (0.45 * light).toFixed(3) + ")"); hg.addColorStop(1, pal.glow + "0)");
      ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.fillStyle = hg; ctx.beginPath(); ctx.arc(heroPoint.x, heroPoint.y, 260, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }
    ctx.restore();

    // the title, set in the sky from frame 0
    K.text(ctx, spec.title, { x: W / 2, y: 250, size: 80, weight: 700, font: "Charter", colour: pal.ink, maxWidth: W - 200, lineHeight: 1.1, shadow: "rgba(0,0,0,0.3)", shadowBlur: 12 });

    // the story line on a paper strip
    var at = K.beatAt(tl, t);
    if (at >= 0 && at < n) {
      var b = tl.beats[at];
      var a = K.clamp((t - b.start) / 0.35, 0, 1) * back;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.translate(0, (1 - a) * 20);
      ctx.font = "italic 400 50px Charter";
      var lines = K.wrap(ctx, spec.beats[at].caption, W - 260);
      var h = lines.length * 62 + 60;
      ctx.shadowColor = "rgba(0,0,0,0.35)"; ctx.shadowBlur = 16; ctx.shadowOffsetY = 6;
      ctx.fillStyle = pal.paper;
      ctx.beginPath();
      ctx.moveTo(90, 1640); ctx.lineTo(W - 90, 1636); ctx.lineTo(W - 96, 1640 + h); ctx.lineTo(96, 1644 + h); ctx.closePath(); ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.fillStyle = "#2A2420"; ctx.textAlign = "center"; ctx.textBaseline = "top";
      for (var li = 0; li < lines.length; li++) ctx.fillText(lines[li], W / 2, 1670 + li * 62);
      ctx.restore();
    }
    K.grain(ctx, frame % 3, 0.05, 4);
  }

  function cues(spec) {
    var tl = times(spec);
    var list = [];
    for (var i = 1; i < 5; i++) list.push({ at: 0.3 + i * 0.32, kind: "type" });
    for (var b = 0; b < spec.beats.length; b++) list.push({ at: tl.beats[b].start, kind: "tick" });
    list.push({ at: tl.beats[spec.beats.length - 1].start + 0.3, kind: "whoosh" });
    list.push({ at: tl.beats[spec.beats.length - 1].start + 0.9, kind: "chime" });
    return list;
  }

  root.MeridianStyles.paper_cut = { draw: draw, cues: cues, bed: "pad" };
})(typeof window !== "undefined" ? window : globalThis);
