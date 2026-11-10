// The isometric explainer: a route of labelled stages on a cream isometric ground, each stage a small model built from shaded boxes, joined
// by a cable that runs along the isometric axes. A glowing packet travels the route; each stage rises as the packet sets off for it, and its
// label pops on when the packet arrives. One caption line per stage in the bottom third. The last second returns to the opening frame
// (the ground and the title), so the video loops.
//
// Look (chosen, Meridian's own): cream ground #F2EADB with a faint tile grid, ink navy #1F2A44 for type and outlines, a restrained blue
// family for the models, warm yellow #F2B33D for the packet and the lit windows, one red accent. Soft drop shadows, no outlines on faces.
(function (root) {
  "use strict";
  var K = root.MeridianStyleKit;
  var W = K.W, H = K.H;

  var C = {
    ground: "#F2EADB", tile: "#E4D8C3", ink: "#1F2A44", inkSoft: "#5A6481", blue: "#3B6FB6", blueLight: "#8DB2E0", blueDark: "#28497A",
    slab: "#E7DCC8", slabSide: "#CDBFA6", slabSide2: "#BDAE94", yellow: "#F2B33D", yellowGlow: "#FFD77A", red: "#E05A47", green: "#6FA56B",
    greenDark: "#4F7F4C", white: "#FBF8F1", grey: "#AEB4C2",
  };
  var UNIT = 132;
  var EX = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)];
  var EY = [-Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)];

  function iso(origin, gx, gy, z) { return [origin[0] + (gx * EX[0] + gy * EY[0]) * UNIT, origin[1] + (gx * EX[1] + gy * EY[1]) * UNIT - (z || 0)]; }

  /** A shaded box standing on screen point p (the centre of its footprint): w along x, d along y, h up, in pixels. */
  function box(ctx, p, w, d, h, top, left, right, alpha) {
    var hx = [EX[0] * w / 2, EX[1] * w / 2], hy = [EY[0] * d / 2, EY[1] * d / 2];
    var A = [p[0] - hx[0] - hy[0], p[1] - hx[1] - hy[1]];
    var B = [p[0] + hx[0] - hy[0], p[1] + hx[1] - hy[1]];
    var Cc = [p[0] + hx[0] + hy[0], p[1] + hx[1] + hy[1]];
    var D = [p[0] - hx[0] + hy[0], p[1] - hx[1] + hy[1]];
    ctx.save();
    if (alpha !== undefined) ctx.globalAlpha *= alpha;
    // right face (B-C) and left face (C-D), then the top
    ctx.fillStyle = right;
    ctx.beginPath(); ctx.moveTo(B[0], B[1]); ctx.lineTo(Cc[0], Cc[1]); ctx.lineTo(Cc[0], Cc[1] - h); ctx.lineTo(B[0], B[1] - h); ctx.closePath(); ctx.fill();
    ctx.fillStyle = left;
    ctx.beginPath(); ctx.moveTo(Cc[0], Cc[1]); ctx.lineTo(D[0], D[1]); ctx.lineTo(D[0], D[1] - h); ctx.lineTo(Cc[0], Cc[1] - h); ctx.closePath(); ctx.fill();
    ctx.fillStyle = top;
    ctx.beginPath(); ctx.moveTo(A[0], A[1] - h); ctx.lineTo(B[0], B[1] - h); ctx.lineTo(Cc[0], Cc[1] - h); ctx.lineTo(D[0], D[1] - h); ctx.closePath(); ctx.fill();
    ctx.restore();
    return { A: A, B: B, C: Cc, D: D, h: h };
  }
  function shadow(ctx, p, w, d, alpha) {
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.fillStyle = "rgba(31,42,68,0.16)";
    ctx.beginPath();
    ctx.ellipse(p[0] + 10, p[1] + 8, (w + d) * 0.48, (w + d) * 0.26, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  function up(p, z) { return [p[0], p[1] - z]; }
  /** A dot of light on the left face: u across (0..1 from C to D), v up (0..1). */
  function leftFacePoint(b, u, v) { return [K.lerp(b.C[0], b.D[0], u), K.lerp(b.C[1], b.D[1], u) - b.h * v]; }
  function rightFacePoint(b, u, v) { return [K.lerp(b.B[0], b.C[0], u), K.lerp(b.B[1], b.C[1], u) - b.h * v]; }
  function faceQuad(ctx, b, face, u0, u1, v0, v1, colour) {
    var f = face === "left" ? leftFacePoint : rightFacePoint;
    var a = f(b, u0, v0), c = f(b, u1, v0), d = f(b, u1, v1), e = f(b, u0, v1);
    ctx.fillStyle = colour;
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(c[0], c[1]); ctx.lineTo(d[0], d[1]); ctx.lineTo(e[0], e[1]); ctx.closePath(); ctx.fill();
  }

  function tree(ctx, p, s) {
    ctx.save();
    ctx.fillStyle = "rgba(31,42,68,0.14)";
    ctx.beginPath(); ctx.ellipse(p[0] + 6, p[1] + 4, 20 * s, 10 * s, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#8C6A4A"; ctx.fillRect(p[0] - 3 * s, p[1] - 18 * s, 6 * s, 18 * s);
    ctx.fillStyle = C.greenDark;
    ctx.beginPath(); ctx.moveTo(p[0], p[1] - 70 * s); ctx.lineTo(p[0] + 20 * s, p[1] - 14 * s); ctx.lineTo(p[0], p[1] - 8 * s); ctx.closePath(); ctx.fill();
    ctx.fillStyle = C.green;
    ctx.beginPath(); ctx.moveTo(p[0], p[1] - 70 * s); ctx.lineTo(p[0] - 20 * s, p[1] - 14 * s); ctx.lineTo(p[0], p[1] - 8 * s); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  // ---------- the models: each stands on point p, with lit (0..1) for windows, screens and lights ----------
  var MODELS = {
    phone: function (ctx, p, lit) {
      var b = box(ctx, p, 44, 18, 120, C.blueDark, C.ink, "#2B3656");
      faceQuad(ctx, b, "left", 0.12, 0.88, 0.1, 0.9, K.css(K.mix(K.rgb("#3A4A70"), K.rgb(C.yellowGlow), lit)));
      return 130;
    },
    laptop: function (ctx, p, lit) {
      box(ctx, p, 130, 90, 10, C.grey, "#8D93A3", "#9DA3B2");
      var s = box(ctx, [p[0] + EY[0] * -40, p[1] + EY[1] * -40], 126, 8, 80, C.ink, C.ink, "#2B3656");
      faceQuad(ctx, s, "left", 0.08, 0.92, 0.1, 0.9, K.css(K.mix(K.rgb("#3A4A70"), K.rgb(C.blueLight), lit)));
      return 100;
    },
    tower: function (ctx, p, lit) {
      box(ctx, p, 60, 60, 12, C.slab, C.slabSide, C.slabSide2);
      ctx.save();
      ctx.strokeStyle = C.inkSoft; ctx.lineWidth = 5; ctx.lineCap = "round";
      var top = up(p, 230);
      [[-26, 0], [26, 0], [0, -14], [0, 14]].forEach(function (o) { ctx.beginPath(); ctx.moveTo(p[0] + o[0], p[1] + o[1] - 12); ctx.lineTo(top[0], top[1]); ctx.stroke(); });
      ctx.lineWidth = 3;
      for (var i = 1; i < 5; i++) { var y = p[1] - 12 - i * 42, wv = 26 * (1 - i / 5.5); ctx.beginPath(); ctx.moveTo(p[0] - wv, y); ctx.lineTo(p[0] + wv, y - 10); ctx.stroke(); }
      ctx.restore();
      box(ctx, up(p, 150), 30, 10, 34, C.white, C.grey, "#C9CED8");
      box(ctx, up(p, 190), 30, 10, 30, C.white, C.grey, "#C9CED8");
      ctx.fillStyle = K.css(K.rgb(C.red), 0.5 + 0.5 * lit);
      ctx.beginPath(); ctx.arc(top[0], top[1] - 6, 9, 0, Math.PI * 2); ctx.fill();
      if (lit > 0) { ctx.strokeStyle = K.css(K.rgb(C.yellow), lit * 0.9); ctx.lineWidth = 4; for (var r = 1; r <= 3; r++) { ctx.beginPath(); ctx.arc(top[0], top[1] - 6, 16 + r * 16, -Math.PI * 0.85, -Math.PI * 0.15); ctx.stroke(); } }
      return 250;
    },
    cable: function (ctx, p, lit) {
      box(ctx, p, 90, 90, 14, C.slab, C.slabSide, C.slabSide2);
      ctx.save();
      for (var i = 0; i < 4; i++) {
        ctx.fillStyle = i % 2 ? "#2F3B5C" : C.ink;
        ctx.beginPath(); ctx.ellipse(p[0], p[1] - 24 - i * 18, 52, 28, 0, 0, Math.PI * 2); ctx.fill();
      }
      ctx.strokeStyle = K.css(K.rgb(C.yellow), 0.35 + 0.65 * lit); ctx.lineWidth = 4;
      for (var j = 0; j < 4; j++) { ctx.beginPath(); ctx.ellipse(p[0], p[1] - 24 - j * 18, 40, 20, 0, 0.2, Math.PI - 0.2); ctx.stroke(); }
      ctx.restore();
      return 110;
    },
    server: function (ctx, p, lit) {
      var h = 0;
      for (var i = 0; i < 3; i++) {
        var b = box(ctx, up(p, h), 100, 100, 52, "#4B5B85", C.ink, "#34416A");
        for (var k = 0; k < 4; k++) faceQuad(ctx, b, "left", 0.12 + k * 0.2, 0.2 + k * 0.2, 0.42, 0.58, K.css(K.mix(K.rgb("#56648A"), K.rgb(k % 2 ? C.yellowGlow : "#7DE3A3"), lit)));
        faceQuad(ctx, b, "right", 0.15, 0.85, 0.3, 0.38, "#28324F");
        h += 56;
      }
      return h + 20;
    },
    cloud: function (ctx, p, lit) {
      box(ctx, p, 60, 60, 10, C.slab, C.slabSide, C.slabSide2);
      var c = up(p, 120);
      ctx.save();
      ctx.fillStyle = "rgba(31,42,68,0.12)";
      ctx.beginPath(); ctx.ellipse(p[0], p[1] + 2, 60, 22, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = C.white;
      [[-46, 10, 34], [0, -10, 48], [44, 8, 36], [20, 22, 30], [-20, 22, 30]].forEach(function (o) { ctx.beginPath(); ctx.arc(c[0] + o[0], c[1] + o[1], o[2], 0, Math.PI * 2); ctx.fill(); });
      ctx.fillStyle = K.css(K.rgb(C.blueLight), 0.35 + 0.4 * lit);
      ctx.beginPath(); ctx.arc(c[0] + 10, c[1] + 4, 14, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      return 180;
    },
    house: function (ctx, p, lit) {
      var b = box(ctx, p, 110, 100, 72, C.white, "#E2D9C8", "#D2C7B2");
      faceQuad(ctx, b, "left", 0.2, 0.42, 0.25, 0.65, K.css(K.mix(K.rgb("#7A8094"), K.rgb(C.yellowGlow), lit)));
      faceQuad(ctx, b, "left", 0.58, 0.8, 0.25, 0.65, K.css(K.mix(K.rgb("#7A8094"), K.rgb(C.yellowGlow), lit)));
      faceQuad(ctx, b, "right", 0.35, 0.6, 0, 0.6, "#8C6A4A");
      // the roof: a prism along x
      var r = 34, top = b.h + 46;
      var L = [K.lerp(b.A[0], b.D[0], 0.5), K.lerp(b.A[1], b.D[1], 0.5)], R = [K.lerp(b.B[0], b.C[0], 0.5), K.lerp(b.B[1], b.C[1], 0.5)];
      ctx.fillStyle = C.red;
      ctx.beginPath(); ctx.moveTo(b.D[0] - 4, b.D[1] - b.h + 2); ctx.lineTo(b.C[0] + 4, b.C[1] - b.h + 2); ctx.lineTo(R[0], R[1] - top); ctx.lineTo(L[0], L[1] - top); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#B8473A";
      ctx.beginPath(); ctx.moveTo(b.B[0] + 4, b.B[1] - b.h); ctx.lineTo(b.C[0] + 4, b.C[1] - b.h + 2); ctx.lineTo(R[0], R[1] - top); ctx.closePath(); ctx.fill();
      return top + 10 + r * 0;
    },
    factory: function (ctx, p, lit, t) {
      var b = box(ctx, p, 150, 110, 70, "#C9CED8", "#9EA6B8", "#B3BAC9");
      for (var i = 0; i < 3; i++) faceQuad(ctx, b, "left", 0.1 + i * 0.28, 0.28 + i * 0.28, 0.3, 0.7, K.css(K.mix(K.rgb("#6E7690"), K.rgb(C.yellowGlow), lit)));
      var ch = box(ctx, [b.B[0] - 22, b.B[1] - 6], 26, 26, b.h + 80, C.red, "#B8473A", "#C9503F");
      for (var s = 0; s < 3; s++) {
        var ph = ((t || 0) * 0.5 + s / 3) % 1;
        ctx.fillStyle = "rgba(251,248,241," + (0.8 * (1 - ph)).toFixed(3) + ")";
        ctx.beginPath(); ctx.arc(ch.B[0] - 14 + ph * 30, ch.B[1] - ch.h - 16 - ph * 70, 12 + ph * 16, 0, Math.PI * 2); ctx.fill();
      }
      return b.h + 110;
    },
    store: function (ctx, p, lit) {
      var b = box(ctx, p, 120, 96, 84, C.white, "#E2D9C8", "#D2C7B2");
      faceQuad(ctx, b, "left", 0.12, 0.88, 0.1, 0.5, K.css(K.mix(K.rgb("#7A8094"), K.rgb(C.yellowGlow), lit)));
      for (var i = 0; i < 6; i++) faceQuad(ctx, b, "left", i / 6, (i + 1) / 6, 0.62, 0.8, i % 2 ? C.white : C.red);
      return b.h + 10;
    },
    truck: function (ctx, p, lit) {
      var cargo = box(ctx, [p[0] - 16, p[1] - 8], 120, 64, 70, C.white, "#E2D9C8", "#D2C7B2");
      faceQuad(ctx, cargo, "left", 0.1, 0.9, 0.35, 0.65, C.blue);
      var cab = box(ctx, [p[0] + EX[0] * 82 - 16, p[1] + EX[1] * 82 - 8], 46, 64, 54, C.blue, C.blueDark, "#305A96");
      faceQuad(ctx, cab, "left", 0.15, 0.85, 0.5, 0.85, K.css(K.mix(K.rgb(C.blueLight), K.rgb(C.yellowGlow), lit * 0.6)));
      ctx.fillStyle = C.ink;
      [[-50, 20], [10, 52], [60, 78]].forEach(function (o) { ctx.beginPath(); ctx.ellipse(p[0] + o[0], p[1] + o[1] - 30, 13, 15, -0.5, 0, Math.PI * 2); ctx.fill(); });
      return 90;
    },
    warehouse: function (ctx, p, lit) {
      var b = box(ctx, p, 170, 120, 66, "#D9CDB7", "#B9AA8F", "#C8BA9F");
      faceQuad(ctx, b, "left", 0.3, 0.7, 0, 0.62, K.css(K.mix(K.rgb("#8A7B62"), K.rgb(C.yellowGlow), lit * 0.8)));
      for (var i = 0; i < 4; i++) faceQuad(ctx, b, "left", 0.3, 0.7, i * 0.15 + 0.05, i * 0.15 + 0.08, "#7C6E57");
      return b.h + 20;
    },
    bank: function (ctx, p, lit) {
      var base = box(ctx, p, 150, 110, 16, C.white, "#E2D9C8", "#D2C7B2");
      for (var i = 0; i < 4; i++) {
        var cp = leftFacePoint(base, 0.15 + i * 0.23, 0);
        box(ctx, [cp[0] + EY[0] * -10, cp[1] + EY[1] * -10 - 16], 14, 14, 70, C.white, "#E2D9C8", "#D2C7B2");
      }
      var top = box(ctx, up(p, 86), 150, 110, 18, C.white, "#E2D9C8", "#D2C7B2");
      ctx.fillStyle = K.css(K.mix(K.rgb(C.blue), K.rgb(C.yellow), lit));
      ctx.beginPath(); ctx.moveTo(top.D[0], top.D[1] - top.h); ctx.lineTo(top.C[0], top.C[1] - top.h); ctx.lineTo(K.lerp(top.D[0], top.C[0], 0.5), K.lerp(top.D[1], top.C[1], 0.5) - top.h - 44); ctx.closePath(); ctx.fill();
      return 160;
    },
    sun: function (ctx, p, lit, t) {
      box(ctx, p, 60, 60, 10, C.slab, C.slabSide, C.slabSide2);
      var c = up(p, 130);
      ctx.save();
      ctx.translate(c[0], c[1]);
      ctx.rotate((t || 0) * 0.3);
      ctx.strokeStyle = C.yellow; ctx.lineWidth = 8; ctx.lineCap = "round";
      for (var i = 0; i < 10; i++) { var a = (i / 10) * Math.PI * 2; ctx.beginPath(); ctx.moveTo(Math.cos(a) * 58, Math.sin(a) * 58); ctx.lineTo(Math.cos(a) * 78, Math.sin(a) * 78); ctx.stroke(); }
      ctx.restore();
      var g = ctx.createRadialGradient(c[0], c[1], 6, c[0], c[1], 90 + 30 * lit);
      g.addColorStop(0, "rgba(255,215,122,0.65)"); g.addColorStop(1, "rgba(255,215,122,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(c[0], c[1], 120, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = C.yellow; ctx.beginPath(); ctx.arc(c[0], c[1], 46, 0, Math.PI * 2); ctx.fill();
      return 220;
    },
    panel: function (ctx, p, lit) {
      box(ctx, p, 30, 30, 50, C.grey, "#8D93A3", "#9DA3B2");
      var c = up(p, 60);
      ctx.save();
      ctx.translate(c[0], c[1]);
      ctx.transform(1, 0.5, -1, 0.5, 0, 0);
      ctx.rotate(0);
      ctx.fillStyle = K.css(K.mix(K.rgb(C.blueDark), K.rgb(C.blue), 0.3 + 0.5 * lit));
      ctx.fillRect(-70, -50, 140, 100);
      ctx.strokeStyle = K.css(K.rgb(C.blueLight), 0.8); ctx.lineWidth = 3;
      for (var i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(-70 + i * 35, -50); ctx.lineTo(-70 + i * 35, 50); ctx.stroke(); }
      for (var j = 1; j < 3; j++) { ctx.beginPath(); ctx.moveTo(-70, -50 + j * 33); ctx.lineTo(70, -50 + j * 33); ctx.stroke(); }
      ctx.restore();
      return 130;
    },
    battery: function (ctx, p, lit) {
      var b = box(ctx, p, 70, 70, 120, C.ink, "#2B3656", "#34416A");
      box(ctx, up(p, 120), 30, 30, 14, C.grey, "#8D93A3", "#9DA3B2");
      for (var i = 0; i < 4; i++) faceQuad(ctx, b, "left", 0.2, 0.8, 0.1 + i * 0.2, 0.25 + i * 0.2, i / 4 < lit ? "#7DE3A3" : "#3A4A70");
      return 150;
    },
    satellite: function (ctx, p, lit, t) {
      var c = up(p, 120 + Math.sin((t || 0) * 1.5) * 8);
      ctx.fillStyle = "rgba(31,42,68,0.12)";
      ctx.beginPath(); ctx.ellipse(p[0], p[1], 70, 24, 0, 0, Math.PI * 2); ctx.fill();
      box(ctx, c, 46, 46, 46, C.white, C.grey, "#C9CED8");
      [[-1], [1]].forEach(function (s) {
        ctx.save(); ctx.translate(c[0] + s[0] * 80, c[1] - 30); ctx.transform(1, 0.5 * s[0], 0, 1, 0, 0);
        ctx.fillStyle = K.css(K.mix(K.rgb(C.blueDark), K.rgb(C.blue), 0.4 + 0.5 * lit)); ctx.fillRect(-50, -18, 100, 36);
        ctx.restore();
      });
      return 190;
    },
  };

  function layout(spec) {
    var n = spec.stages.length;
    var step = 2.7;
    var pts = [];
    var g = [0, 0];
    for (var i = 0; i < n; i++) {
      pts.push([g[0], g[1]]);
      if (i % 2 === 0) g = [g[0] + step, g[1]]; else g = [g[0], g[1] + step];
    }
    // centre the route: screen bounds of the ground points
    var probe = pts.map(function (q) { return iso([0, 0], q[0], q[1], 0); });
    var minX = Math.min.apply(null, probe.map(function (q) { return q[0]; })), maxX = Math.max.apply(null, probe.map(function (q) { return q[0]; }));
    var minY = Math.min.apply(null, probe.map(function (q) { return q[1]; })), maxY = Math.max.apply(null, probe.map(function (q) { return q[1]; }));
    var origin = [W / 2 - (minX + maxX) / 2, 1030 - (minY + maxY) / 2];
    return { grid: pts, screen: pts.map(function (q) { return iso(origin, q[0], q[1], 0); }), origin: origin };
  }

  function times(spec) {
    var tl = K.timeline(spec.durationMs / 1000, spec.stages.length, 1.6, 1.8);
    return tl;
  }

  function pill(ctx, p, side, label, appear, n) {
    if (appear <= 0) return;
    var s = K.settle(appear, 0, 1, 0.18);
    ctx.save();
    ctx.font = "700 40px Inter";
    var tw = ctx.measureText(label).width;
    var w = tw + 52, h = 66;
    var x = side < 0 ? p[0] - 130 - w : p[0] + 130;
    x = K.clamp(x, 70, W - 70 - w);
    var y = p[1] - 210;
    ctx.translate(x + w / 2, y + h / 2);
    ctx.scale(0.6 + 0.4 * s, 0.6 + 0.4 * s);
    ctx.globalAlpha *= K.clamp(appear * 2, 0, 1);
    ctx.fillStyle = "rgba(31,42,68,0.18)";
    K.roundRect(ctx, -w / 2 + 6, -h / 2 + 8, w, h, 18); ctx.fill();
    ctx.fillStyle = C.ink;
    K.roundRect(ctx, -w / 2, -h / 2, w, h, 18); ctx.fill();
    ctx.fillStyle = C.yellow;
    ctx.beginPath(); ctx.arc(-w / 2 + 2, 0, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C.white; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(label, 0, 2);
    // the number tag
    ctx.fillStyle = C.yellow;
    ctx.beginPath(); ctx.arc(-w / 2, -h / 2, 22, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C.ink; ctx.font = "800 26px Inter"; ctx.fillText(String(n), -w / 2, -h / 2 + 1);
    ctx.restore();
  }

  function draw(ctx, t, frame, spec) {
    var tl = times(spec);
    var L = layout(spec);
    var n = spec.stages.length;
    // the return to the opening frame: everything but the ground and the title leaves over the last 0.8 s
    var out = 1 - K.move(t, tl.duration - 0.85, 0.8, "leave");

    ctx.fillStyle = C.ground;
    ctx.fillRect(0, 0, W, H);
    // the tile grid, drifting a little so the ground is never dead (periodic, so it loops)
    ctx.save();
    ctx.strokeStyle = C.tile; ctx.lineWidth = 2;
    var drift = ((t / tl.duration) % 1) * UNIT;
    for (var k = -20; k <= 20; k++) {
      var a = iso(L.origin, k - 0.5, -20, 0), b = iso(L.origin, k - 0.5, 20, 0);
      ctx.beginPath(); ctx.moveTo(a[0] + drift * EX[0] * 0, a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      var c2 = iso(L.origin, -20, k - 0.5, 0), d2 = iso(L.origin, 20, k - 0.5, 0);
      ctx.beginPath(); ctx.moveTo(c2[0], c2[1]); ctx.lineTo(d2[0], d2[1]); ctx.stroke();
    }
    ctx.restore();

    // the title, held from frame 0
    K.text(ctx, spec.title.toUpperCase(), { x: W / 2, y: 236, size: 76, weight: 800, font: "Inter Display", colour: C.ink, maxWidth: W - 180, letterSpacing: 2 });
    ctx.fillStyle = C.yellow;
    ctx.fillRect(W / 2 - 60, 236 + (spec.title.length > 22 ? 190 : 104), 120, 10);

    ctx.save();
    ctx.globalAlpha = out;
    // decorative trees, seeded, beside the route
    for (var tr = 0; tr < 9; tr++) {
      var gx = (K.hash(tr * 13 + 1) - 0.5) * 9, gy = (K.hash(tr * 7 + 3) - 0.5) * 9;
      var tp = iso(L.origin, gx, gy, 0);
      var near = L.screen.some(function (q) { return Math.abs(q[0] - tp[0]) < 170 && Math.abs(q[1] - tp[1]) < 140; });
      if (near || tp[1] < 520 || tp[1] > 1420 || tp[0] < 80 || tp[0] > W - 80) continue;
      var grow = K.settle(t, 0.4 + tr * 0.08, 0.6, 0.2);
      if (grow > 0) tree(ctx, tp, 0.9 * grow);
    }

    // the cable: each segment draws while the packet travels it
    for (var i = 1; i < n; i++) {
      var beat = tl.beats[i];
      var seg = K.move(t, beat.start, beat.end - beat.start - 0.35, "wind");
      if (seg <= 0) continue;
      var A = L.screen[i - 1], B = L.screen[i];
      ctx.save();
      ctx.lineCap = "round";
      ctx.strokeStyle = C.ink; ctx.lineWidth = 12;
      ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(K.lerp(A[0], B[0], seg), K.lerp(A[1], B[1], seg)); ctx.stroke();
      ctx.strokeStyle = "#3A4A70"; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.moveTo(A[0], A[1] - 2); ctx.lineTo(K.lerp(A[0], B[0], seg), K.lerp(A[1], B[1], seg) - 2); ctx.stroke();
      ctx.restore();
    }

    // the stages, back to front
    for (var s = 0; s < n; s++) {
      var st = spec.stages[s];
      var born = s === 0 ? tl.introEnd - 0.6 : tl.beats[s].start;
      var rise = K.settle(t, born, 0.75, 0.16);
      if (rise <= 0) continue;
      var arrive = s === 0 ? tl.beats[0].start + 0.2 : tl.beats[s].end - 0.35;
      var lit = K.move(t, arrive, 0.4, "reveal");
      var p = L.screen[s];
      shadow(ctx, p, 160, 160, rise);
      ctx.save();
      ctx.translate(0, (1 - rise) * 60);
      ctx.globalAlpha *= K.clamp(rise * 1.5, 0, 1);
      box(ctx, p, 170, 170, 16, C.slab, C.slabSide, C.slabSide2);
      var model = MODELS[st.icon] || MODELS.server;
      model(ctx, up(p, 16), lit, t);
      ctx.restore();
      var side = L.grid[s][0] > L.grid[s][1] ? 1 : -1;
      if (n === 2) side = s === 0 ? -1 : 1;
      pill(ctx, p, side, st.label, K.clamp((t - arrive) / 0.45, 0, 1), s + 1);
    }

    // the packet: travels each segment in its beat, with a short trail
    for (var j = 1; j < n; j++) {
      var bt = tl.beats[j];
      var u = K.move(t, bt.start, bt.end - bt.start - 0.35, "wind");
      if (t < bt.start || t > bt.end) continue;
      var P = L.screen[j - 1], Q = L.screen[j];
      for (var trail = 5; trail >= 0; trail--) {
        var uu = K.clamp(u - trail * 0.035, 0, 1);
        var px = K.lerp(P[0], Q[0], uu), py = K.lerp(P[1], Q[1], uu) - 24;
        ctx.fillStyle = "rgba(242,179,61," + (0.12 + 0.14 * (5 - trail)).toFixed(3) + ")";
        ctx.beginPath(); ctx.arc(px, py, 18 - trail * 2, 0, Math.PI * 2); ctx.fill();
      }
      var hx = K.lerp(P[0], Q[0], u), hy = K.lerp(P[1], Q[1], u) - 24;
      var glow = ctx.createRadialGradient(hx, hy, 4, hx, hy, 70);
      glow.addColorStop(0, "rgba(255,215,122,0.9)"); glow.addColorStop(1, "rgba(255,215,122,0)");
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(hx, hy, 70, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = C.yellow;
      K.roundRect(ctx, hx - 26, hy - 18, 52, 36, 10); ctx.fill();
      if (spec.packet) K.text(ctx, spec.packet.toUpperCase(), { x: hx, y: hy - 62, size: 26, weight: 800, colour: C.ink });
    }

    // the caption for the current stage
    var at = K.beatAt(tl, t);
    if (at >= 0 && at < n) {
      var beatNow = tl.beats[at];
      ctx.fillStyle = "rgba(242,234,219,0.9)";
      K.caption(ctx, spec.stages[at].caption, { y: 1520, colour: C.ink, size: 56, appear: K.clamp((t - beatNow.start) / 0.25, 0, 1), rise: 14 });
    }
    ctx.restore();
  }

  function cues(spec) {
    var tl = times(spec);
    var list = [{ at: tl.introEnd - 0.6, kind: "pop" }, { at: tl.beats[0].start + 0.2, kind: "tick" }];
    for (var i = 1; i < spec.stages.length; i++) {
      list.push({ at: tl.beats[i].start, kind: "whoosh" });
      list.push({ at: tl.beats[i].start + 0.05, kind: "pop" });
      list.push({ at: tl.beats[i].end - 0.35, kind: "tick" });
    }
    list.push({ at: tl.outroStart + 0.2, kind: "chime" });
    return list;
  }

  root.MeridianStyles.isometric = { draw: draw, cues: cues, bed: "pulse" };
})(typeof window !== "undefined" ? window : globalThis);
