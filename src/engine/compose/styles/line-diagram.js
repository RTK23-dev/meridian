/* eslint-disable */
// The line-art diagram: a diagram that builds itself step by step on a deep navy ground, in thin white lines with monospace numbers and one
// warm accent. A cycle places the steps round a loop and closes it in the accent; a flow stacks them top to bottom. Each step's node draws
// as a stroke, its label types on, then the arrow to the next step draws and a few dots run along it. One caption line per step; the
// takeaway arrives in the accent at the end. The last second clears back to the title and the grid, so the video loops.
//
// Look (chosen, Meridian's own): ground #0E1A33 with a faint dot grid, lines #EAF0FA at 4 px, accent #F2A33D, numbers in DejaVu Sans Mono,
// labels in Inter. No fills except the accent dot on the active step.
(function (root) {
  "use strict";
  var K = root.MeridianStyleKit;
  var W = K.W, H = K.H;
  var C = { ground: "#0E1A33", dot: "rgba(234,240,250,0.10)", line: "#EAF0FA", soft: "rgba(234,240,250,0.55)", accent: "#F2A33D" };

  function times(spec) { return K.timeline(spec.durationMs / 1000, spec.steps.length + 1, 1.4, 1.4); }

  function nodes(spec) {
    var n = spec.steps.length;
    if (spec.layout === "cycle") {
      var R = n <= 3 ? 280 : 320, cx = W / 2, cy = 1000;
      return spec.steps.map(function (s, i) { var a = -Math.PI / 2 + (i / n) * Math.PI * 2; return { x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R, a: a, cx: cx, cy: cy, R: R }; });
    }
    var top = 560, bottom = 1420, gap = (bottom - top) / Math.max(1, n - 1);
    return spec.steps.map(function (s, i) { return { x: W / 2 + (i % 2 ? 90 : -90), y: top + i * gap }; });
  }

  /** Strokes a path built by `build`, drawn up to fraction p of its length (approximated by dash offset on a known length). */
  function partial(ctx, length, p, build, colour, width) {
    if (p <= 0) return;
    ctx.save();
    ctx.strokeStyle = colour; ctx.lineWidth = width; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.setLineDash([length, length + 10]);
    ctx.lineDashOffset = length * (1 - K.clamp(p, 0, 1));
    ctx.beginPath(); build(ctx); ctx.stroke();
    ctx.restore();
  }
  function arrowHead(ctx, x, y, angle, colour, alpha) {
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.fillStyle = colour;
    ctx.translate(x, y); ctx.rotate(angle);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-22, -11); ctx.lineTo(-22, 11); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  function draw(ctx, t, frame, spec) {
    var tl = times(spec);
    var n = spec.steps.length;
    var N = nodes(spec);
    var back = 1 - K.move(t, tl.duration - 0.85, 0.8, "leave");
    ctx.fillStyle = C.ground; ctx.fillRect(0, 0, W, H);
    for (var gy = 60; gy < H; gy += 60) for (var gx = 60; gx < W; gx += 60) { ctx.fillStyle = C.dot; ctx.fillRect(gx - 2, gy - 2, 4, 4); }

    K.text(ctx, spec.title, { x: W / 2, y: 220, size: 70, weight: 700, font: "Inter Display", colour: C.line, maxWidth: W - 200, lineHeight: 1.1 });
    ctx.fillStyle = C.accent; ctx.fillRect(W / 2 - 50, 220 + (spec.title.length > 24 ? 172 : 92), 100, 6);

    ctx.save();
    ctx.globalAlpha = back;
    var R = N[0].R;
    for (var i = 0; i < n; i++) {
      var beat = tl.beats[i];
      var p = N[i];
      // the arrow to the next step (and, for a cycle, the closing arrow in the accent)
      var last = i === n - 1;
      if (!last || spec.layout === "cycle") {
        var q = N[(i + 1) % n];
        var arrowP = last ? K.move(t, tl.beats[n].start, 0.9, "wind") : K.move(t, beat.start + 0.9, beat.end - beat.start - 1.0, "wind");
        var colour = last ? C.accent : C.line;
        if (spec.layout === "cycle") {
          var a0 = p.a + 0.32, a1 = q.a - 0.32 + (last ? Math.PI * 2 : 0);
          if (a1 < a0) a1 += Math.PI * 2;
          var rr = R;
          partial(ctx, rr * (a1 - a0), arrowP, function (c) { c.arc(p.cx, p.cy, rr, a0, a1); }, colour, 4);
          if (arrowP >= 1) arrowHead(ctx, p.cx + Math.cos(a1) * rr, p.cy + Math.sin(a1) * rr, a1 + Math.PI / 2, colour, 1);
          // dots running along a drawn arrow
          if (arrowP >= 1) for (var d = 0; d < 3; d++) {
            var u = ((t * 0.45 + d / 3) % 1);
            var ad = a0 + (a1 - a0) * u;
            ctx.save(); ctx.fillStyle = colour; ctx.globalAlpha *= 0.8;
            ctx.beginPath(); ctx.arc(p.cx + Math.cos(ad) * rr, p.cy + Math.sin(ad) * rr, 6, 0, Math.PI * 2); ctx.fill();
            ctx.restore();
          }
        } else {
          var sx = p.x, sy = p.y + 70, ex = q.x, ey = q.y - 70;
          var len = Math.hypot(ex - sx, ey - sy);
          partial(ctx, len * 1.15, arrowP, function (c) { c.moveTo(sx, sy); c.bezierCurveTo(sx, (sy + ey) / 2, ex, (sy + ey) / 2, ex, ey); }, colour, 4);
          if (arrowP >= 1) arrowHead(ctx, ex, ey, Math.PI / 2, colour, 1);
          if (arrowP >= 1) for (var d2 = 0; d2 < 2; d2++) {
            var u2 = ((t * 0.5 + d2 / 2) % 1), mt = 1 - u2;
            var bxp = mt * mt * mt * sx + 3 * mt * mt * u2 * sx + 3 * mt * u2 * u2 * ex + u2 * u2 * u2 * ex;
            var byp = mt * mt * mt * sy + 3 * mt * mt * u2 * ((sy + ey) / 2) + 3 * mt * u2 * u2 * ((sy + ey) / 2) + u2 * u2 * u2 * ey;
            ctx.fillStyle = colour; ctx.beginPath(); ctx.arc(bxp, byp, 6, 0, Math.PI * 2); ctx.fill();
          }
        }
      }
    }
    for (var i = 0; i < n; i++) {
      var beat = tl.beats[i];
      var p = N[i];
      var drawNode = K.move(t, beat.start, 0.7, "reveal");
      var active = t >= beat.start && t < beat.end;
      // the node
      partial(ctx, 2 * Math.PI * 64, drawNode, function (c) { c.arc(p.x, p.y, 64, -Math.PI / 2, Math.PI * 1.5); }, active ? C.accent : C.line, 4);
      if (drawNode > 0.6) {
        K.text(ctx, String(i + 1).padStart(2, "0"), { x: p.x, y: p.y - 26, size: 46, weight: 700, font: "DejaVu Sans Mono", colour: active ? C.accent : C.line, appear: K.clamp((drawNode - 0.6) / 0.4, 0, 1), rise: 0 });
      }
      // the label: outside the loop for a cycle, beside the node for a flow
      var labelP = K.clamp((t - beat.start - 0.35) / 0.6, 0, 1);
      if (labelP > 0) {
        var label = K.typed(spec.steps[i].label, labelP);
        if (spec.layout === "cycle") {
          // the top node's label sits above it; every other label sits below its node, inside the frame
          var lx = K.clamp(p.x, 210, W - 210), ly = Math.sin(p.a) < -0.7 ? p.y - 132 : p.y + 84;
          // a knocked-out band of ground behind the word, so a line passing behind it reads as interrupted, as on a printed diagram
          ctx.save(); ctx.font = "600 42px Inter";
          var bw = ctx.measureText(spec.steps[i].label).width + 36;
          ctx.fillStyle = C.ground; ctx.fillRect(lx - bw / 2, ly - 6, bw, 60);
          ctx.restore();
          K.text(ctx, label, { x: lx, y: ly, size: 42, weight: 600, colour: C.line });
        } else {
          var side = i % 2 ? -1 : 1;
          ctx.save(); ctx.textAlign = side > 0 ? "left" : "right";
          K.text(ctx, label, { x: p.x + side * 100, y: p.y - 24, size: 44, weight: 600, colour: C.line, align: side > 0 ? "left" : "right" });
          ctx.restore();
        }
      }
    }
    // the centre of a cycle: a quiet counter of the steps drawn so far
    if (spec.layout === "cycle") {
      var drawn = Math.max(0, Math.min(n, K.beatAt(tl, t) + 1));
      K.text(ctx, drawn + " / " + n, { x: N[0].cx, y: N[0].cy - 28, size: 52, weight: 700, font: "DejaVu Sans Mono", colour: C.soft });
    }
    // the caption, then the takeaway in the accent
    var at = K.beatAt(tl, t);
    if (at >= 0 && at < n) {
      var b = tl.beats[at];
      K.caption(ctx, spec.steps[at].caption, { y: 1600, colour: C.line, size: 50, weight: 500, appear: K.clamp((t - b.start) / 0.3, 0, 1), rise: 12 });
    } else if (at >= n) {
      K.caption(ctx, spec.takeaway, { y: 1600, colour: C.accent, size: 56, weight: 700, appear: K.clamp((t - tl.beats[n].start) / 0.4, 0, 1), rise: 12 });
    }
    ctx.restore();
  }

  function cues(spec) {
    var tl = times(spec);
    var list = [];
    for (var i = 0; i < spec.steps.length; i++) {
      list.push({ at: tl.beats[i].start, kind: "pop" });
      for (var c = 0; c < Math.min(8, spec.steps[i].label.length); c++) list.push({ at: tl.beats[i].start + 0.35 + c * 0.07, kind: "type" });
      list.push({ at: tl.beats[i].start + 0.9, kind: "whoosh" });
    }
    list.push({ at: tl.beats[spec.steps.length].start + 0.2, kind: "chime" });
    return list;
  }

  root.MeridianStyles.line_diagram = { draw: draw, cues: cues, bed: "pluck" };
})(typeof window !== "undefined" ? window : globalThis);
