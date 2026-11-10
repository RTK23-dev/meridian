// The stacked data chart: a bar chart whose columns are stacks of tokens (gold coins, cash bundles or blocks) that drop and settle one by
// one on a lit stage. Each column's height follows its value; its figure (the brief's own words, never computed here) pops on when the
// stack lands. A key says what one token stands for, the source sits small at the foot (or an ILLUSTRATIVE DATA mark when the figures are
// not real), and the takeaway closes in gold. The stacks lift away in the last second, back to the empty stage, so the video loops.
//
// Look (chosen, Meridian's own): stage #0B1530 under a soft spotlight, gold #E9B949 coins with darker rims, green #4E9F6B bundles with a
// paper band, blue #4F7FD6 blocks; type in Inter, figures in Inter Display.
(function (root) {
  "use strict";
  var K = root.MeridianStyleKit;
  var W = K.W, H = K.H;
  var C = { stage: "#0B1530", stage2: "#16244A", text: "#F4F1E8", soft: "rgba(244,241,232,0.6)", gold: "#E9B949", goldRim: "#B58A26", goldTop: "#F6D57A",
    green: "#4E9F6B", greenDark: "#2F6E46", band: "#F1E6C8", blue: "#4F7FD6", blueDark: "#2E5AA8", floor: "#1C2B55" };
  var FLOOR_Y = 1360;

  function times(spec) { return K.timeline(spec.durationMs / 1000, spec.bars.length + 1, 1.6, 1.5); }

  function tokenHeight(kind) { return kind === "coins" ? 22 : kind === "cash" ? 30 : 40; }

  function drawToken(ctx, kind, x, y, w, seed) {
    var jitter = (K.hash(seed) - 0.5) * 6;
    x += jitter;
    if (kind === "coins") {
      var rx = w / 2, ry = w * 0.16, h = 16;
      ctx.fillStyle = C.goldRim;
      ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI); ctx.lineTo(x - rx, y - h); ctx.ellipse(x, y - h, rx, ry, 0, Math.PI, 0, true); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.18)"; ctx.lineWidth = 2;
      for (var r = 1; r < 6; r++) { ctx.beginPath(); ctx.moveTo(x - rx + r * rx / 3, y - h + ry * 0.3); ctx.lineTo(x - rx + r * rx / 3, y + ry * 0.3); ctx.stroke(); }
      ctx.fillStyle = C.gold; ctx.beginPath(); ctx.ellipse(x, y - h, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = C.goldTop; ctx.beginPath(); ctx.ellipse(x - rx * 0.1, y - h - ry * 0.1, rx * 0.72, ry * 0.62, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = C.goldRim; ctx.lineWidth = 2; ctx.beginPath(); ctx.ellipse(x - rx * 0.1, y - h - ry * 0.1, rx * 0.45, ry * 0.38, 0, 0, Math.PI * 2); ctx.stroke();
    } else if (kind === "cash") {
      var bw = w, bh = 26, depth = w * 0.22;
      ctx.fillStyle = C.greenDark;
      ctx.beginPath(); ctx.moveTo(x - bw / 2, y); ctx.lineTo(x + bw / 2, y); ctx.lineTo(x + bw / 2 + depth * 0.5, y - depth * 0.35); ctx.lineTo(x + bw / 2 + depth * 0.5, y - depth * 0.35 - bh); ctx.lineTo(x + bw / 2, y - bh); ctx.lineTo(x - bw / 2, y - bh); ctx.closePath(); ctx.fill();
      ctx.fillStyle = C.green; ctx.fillRect(x - bw / 2, y - bh, bw, bh);
      ctx.fillStyle = "#6CBF88";
      ctx.beginPath(); ctx.moveTo(x - bw / 2, y - bh); ctx.lineTo(x + bw / 2, y - bh); ctx.lineTo(x + bw / 2 + depth * 0.5, y - bh - depth * 0.35); ctx.lineTo(x - bw / 2 + depth * 0.5, y - bh - depth * 0.35); ctx.closePath(); ctx.fill();
      ctx.fillStyle = C.band; ctx.fillRect(x - 14, y - bh, 28, bh);
      ctx.strokeStyle = "rgba(0,0,0,0.15)"; ctx.lineWidth = 2; ctx.strokeRect(x - bw / 2 + 6, y - bh + 6, bw - 12, bh - 12);
    } else {
      var s = w * 0.8, d = s * 0.3;
      ctx.fillStyle = C.blueDark; ctx.fillRect(x - s / 2 + d, y - s - d * 0.6 + d * 0.6, s * 0.3, s);
      ctx.fillStyle = C.blue; ctx.fillRect(x - s / 2, y - 36, s, 36);
      ctx.fillStyle = "#7FA5E8"; ctx.beginPath(); ctx.moveTo(x - s / 2, y - 36); ctx.lineTo(x + s / 2, y - 36); ctx.lineTo(x + s / 2 + d * 0.5, y - 36 - d * 0.4); ctx.lineTo(x - s / 2 + d * 0.5, y - 36 - d * 0.4); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.2)"; ctx.lineWidth = 2; ctx.strokeRect(x - s / 2, y - 36, s, 36);
    }
  }

  function draw(ctx, t, frame, spec) {
    var tl = times(spec);
    var n = spec.bars.length;
    var back = 1 - K.move(t, tl.duration - 0.85, 0.8, "leave");
    // the stage under a soft spotlight
    var g = ctx.createRadialGradient(W / 2, 980, 60, W / 2, 1000, 1100);
    g.addColorStop(0, C.stage2); g.addColorStop(1, C.stage);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // the floor
    ctx.fillStyle = C.floor;
    ctx.beginPath(); ctx.ellipse(W / 2, FLOOR_Y + 20, 520, 70, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(244,241,232,0.12)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(W / 2, FLOOR_Y + 20, 520, 70, 0, 0, Math.PI * 2); ctx.stroke();

    K.text(ctx, spec.title, { x: W / 2, y: 200, size: 74, weight: 800, font: "Inter Display", colour: C.text, maxWidth: W - 180, lineHeight: 1.08 });
    // the key: one token = unit
    var keyY = spec.title.length > 24 ? 400 : 320;
    ctx.save();
    drawToken(ctx, spec.token, W / 2 - 150, keyY + 40, 56, 1);
    ctx.restore();
    K.text(ctx, "= " + spec.unit + " each", { x: W / 2 - 100, y: keyY + 6, size: 44, weight: 700, colour: C.soft, align: "left" });

    var counts = spec.bars.map(function (b) { return Math.max(1, Math.round(b.value / spec.perToken)); });
    var maxCount = Math.max.apply(null, counts);
    var spacing = Math.min(170, 900 / n), x0 = W / 2 - spacing * (n - 1) / 2;
    // one token per perToken, always counted; tall stacks use thinner tokens so the tallest fits the stage
    var th = Math.min(tokenHeight(spec.token), 860 / maxCount);
    var tokenW = Math.min(118, spacing * 0.72);
    ctx.save();
    ctx.globalAlpha = back;
    for (var i = 0; i < n; i++) {
      var bar = spec.bars[i];
      var x = x0 + i * spacing;
      var count = counts[i];
      var beat = tl.beats[i];
      var span = Math.max(0.6, beat.end - beat.start - 0.7);
      for (var k = 0; k < count; k++) {
        var start = beat.start + (k / count) * span;
        var p = K.clamp((t - start) / 0.42, 0, 1);
        if (p <= 0) break;
        var restY = FLOOR_Y - k * th;
        var fall = K.move(t, start, 0.42, "heavy");
        var bounce = p >= 1 ? 0 : Math.sin(K.clamp((t - start - 0.3) / 0.12, 0, 1) * Math.PI) * 8;
        var y = K.lerp(restY - 700, restY, fall) - bounce;
        ctx.save();
        ctx.globalAlpha *= K.clamp(p * 3, 0, 1);
        drawToken(ctx, spec.token, x, y, tokenW, i * 100 + k);
        ctx.restore();
      }
      // the figure pops on when the stack has landed
      var topY = FLOOR_Y - count * th - 40;
      var done = K.clamp((t - (beat.start + span + 0.42)) / 0.35, 0, 1);
      if (done > 0) {
        var s = K.settle(t, beat.start + span + 0.42, 0.45, 0.2);
        ctx.save();
        ctx.translate(x, topY - 44);
        ctx.scale(0.5 + 0.5 * s, 0.5 + 0.5 * s);
        K.text(ctx, bar.display, { x: 0, y: -30, size: 52, weight: 800, font: "Inter Display", colour: C.gold, appear: done, rise: 0 });
        ctx.restore();
      }
      K.text(ctx, bar.label, { x: x, y: FLOOR_Y + 70, size: 38, weight: 700, colour: C.text, appear: K.clamp((t - beat.start + 0.4) / 0.3, 0, 1), rise: 8 });
    }
    // the takeaway
    var at = K.beatAt(tl, t);
    if (at >= n) K.caption(ctx, spec.takeaway, { y: 1560, colour: C.gold, size: 58, weight: 800, appear: K.clamp((t - tl.beats[n].start) / 0.35, 0, 1), rise: 12 });
    ctx.restore();
    // the source, or the illustrative mark: always on screen
    K.text(ctx, spec.illustrative ? "ILLUSTRATIVE DATA, NOT REAL FIGURES" : "Source: " + spec.source, { x: W / 2, y: 1730, size: 30, weight: 600, colour: C.soft, maxWidth: W - 200, letterSpacing: spec.illustrative ? 2 : 0 });
    K.vignette(ctx, 0.35);
  }

  function cues(spec) {
    var tl = times(spec);
    var list = [];
    for (var i = 0; i < spec.bars.length; i++) {
      var count = Math.max(1, Math.round(spec.bars[i].value / spec.perToken));
      var beat = tl.beats[i];
      var span = Math.max(0.6, beat.end - beat.start - 0.7);
      for (var k = 0; k < count; k += 2) list.push({ at: beat.start + (k / count) * span + 0.4, kind: spec.token === "coins" ? "tick" : "thud" });
      list.push({ at: beat.start + span + 0.42, kind: "pop" });
    }
    list.push({ at: tl.beats[spec.bars.length].start + 0.1, kind: "chime" });
    return list;
  }

  root.MeridianStyles.stacked_chart = { draw: draw, cues: cues, bed: "groove" };
})(typeof window !== "undefined" ? window : globalThis);
