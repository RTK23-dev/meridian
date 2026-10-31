// The preset preview show: an original explainer ("scientists count animals from space") laid out on the preset's beat structure,
// drawn in the preset's style kit. Every frame is a pure function of the time t (seconds): renderAt(t) sets the shader uniforms and the
// overlay DOM. render.ts injects window.PRESET before this file runs.
(function () {
  "use strict";
  var PRESET = window.PRESET;
  var kit = PRESET.styleKit;
  var root = document.documentElement.style;
  root.setProperty("--kit-primary", kit.palette.primary);
  root.setProperty("--kit-secondary", kit.palette.secondary);
  root.setProperty("--kit-accent", kit.palette.accent);
  root.setProperty("--kit-text", kit.palette.text);
  root.setProperty("--kit-background", kit.palette.background);
  root.setProperty("--kit-font-display", '"' + kit.fonts.display + '"');
  root.setProperty("--kit-font-body", '"' + kit.fonts.body + '"');
  root.setProperty("--kit-font-captions", '"' + kit.fonts.captions + '"');
  root.setProperty("--kit-caption-highlight", kit.captionStyle.highlight);
  root.setProperty("--kit-caption-weight", String(kit.captionStyle.weight));

  function hex(h) { return [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255]; }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function lerp(a, b, k) { return a + (b - a) * k; }
  function smooth(k) { k = clamp(k, 0, 1); return k * k * (3 - 2 * k); }
  function seg(t, a, b) { return clamp((t - a) / (b - a), 0, 1); }
  // The layout block of the preset (version 2). Without one, the values the first render chose by hand.
  var L = PRESET.layout || null;
  var W = 720, H = 1280;
  var RING = hex(kit.palette[L ? L.rings.colourRole : "secondary"]);
  (function applyLayout() {
    if (!L) return;
    var css = document.createElement("style");
    css.textContent =
      "#title{top:" + Math.round(L.title.topFrac * H) + "px;font-size:" + Math.round(L.title.sizeFracOfWidth * W) + "px}" +
      "#counter .num{font-size:" + Math.round(L.counter.sizeFracOfWidth * W) + "px}" +
      ".pill{background:" + L.pill.background + ";font-size:" + Math.round(L.pill.sizeFracOfWidth * W) + "px;letter-spacing:" + L.pill.letterSpacingEm + "em}" +
      "#captions{top:" + Math.round(L.captions.topFrac * H) + "px;font-size:" + Math.round(L.captions.sizeFracOfWidth * W) + "px}" +
      "#captions span.next{opacity:" + L.captions.upcomingOpacity + "}" +
      (L.captions.highlight === "colour" ? "#captions span.now{background:none;color:var(--kit-caption-highlight)}" : "") +
      (L.follow.colour ? "#follow span{background:" + L.follow.colour + "}" : "");
    document.head.appendChild(css);
  })();

  // ---------- WebGL ----------
  var canvas = document.getElementById("gl");
  var gl = canvas.getContext("webgl", { preserveDrawingBuffer: true, antialias: false });
  function shader(type, id) {
    var s = gl.createShader(type); gl.shaderSource(s, document.getElementById(id).textContent); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  var prog = gl.createProgram();
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, "vs")); gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, "fs"));
  gl.linkProgram(prog); gl.useProgram(prog);
  var buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  var loc = gl.getAttribLocation(prog, "p"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  var U = {};
  ["uRes", "uTime", "uSceneA", "uSceneB", "uMix", "uCamA", "uCamB", "uRotA", "uRotB", "uObj", "uSat", "uSatYaw", "uRing", "uFog"].forEach(
    function (n) { U[n] = gl.getUniformLocation(prog, n); });

  var ICE = 0, SAVANNA = 1, OCEAN = 2, GLOBE = 3, ROOM = 4;
  var FOG = { 0: [0.86, 0.9, 0.94], 1: [0.78, 0.74, 0.6], 2: [0.4, 0.55, 0.65], 3: [0, 0, 0], 4: [0, 0, 0] };

  var STAINS = [[-120, 160, 45], [90, 230, 38], [150, -60, 52], [-60, -140, 35], [20, 40, 30], [-170, -10, 40], [200, 120, 33],
    [-30, 300, 42], [260, -220, 36], [-230, 240, 30], [60, -300, 44], [330, 60, 28]];
  var ELEPHANTS = [];
  (function () {
    var seed = 7;
    function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
    for (var i = 0; i < 12; i++) {
      var a = rnd() * Math.PI * 2, r = 85 + rnd() * 70;
      ELEPHANTS.push([40 + Math.cos(a) * r, 10 + Math.sin(a) * r, i % 4 === 3 ? 2.4 : 3.4]);
    }
  })();
  var WHALES = [[0, 0, 22], [95, 70, 16]];

  function objs(list, ringFn) {
    var out = new Float32Array(48);
    for (var i = 0; i < 12; i++) {
      var o = list[i];
      if (!o) continue;
      out[i * 4] = o[0]; out[i * 4 + 1] = o[1]; out[i * 4 + 2] = o[2]; out[i * 4 + 3] = ringFn ? ringFn(i) : 0;
    }
    return out;
  }

  function draw(state, t) {
    gl.viewport(0, 0, 720, 1280);
    gl.uniform2f(U.uRes, 720, 1280);
    gl.uniform1f(U.uTime, t);
    var A = state.A, B = state.B || state.A;
    gl.uniform1f(U.uSceneA, A.scene); gl.uniform1f(U.uSceneB, B.scene);
    gl.uniform1f(U.uMix, state.mix || 0);
    gl.uniform3fv(U.uCamA, A.cam); gl.uniform3fv(U.uCamB, B.cam);
    gl.uniform2fv(U.uRotA, A.rot || [0, 0]); gl.uniform2fv(U.uRotB, B.rot || [0, 0]);
    gl.uniform4fv(U.uObj, state.objs || new Float32Array(48));
    gl.uniform1f(U.uSat, state.sat || 0); gl.uniform1f(U.uSatYaw, state.satYaw || 0);
    gl.uniform3fv(U.uRing, RING);
    gl.uniform3fv(U.uFog, FOG[A.scene]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.finish();
  }

  // An oblique camera that looks at a ground point from a given height, pitch and yaw.
  function lookAt(cx, cy, h, pitch, yaw) {
    var dist = h * Math.tan(pitch);
    return { cam: [cx + Math.sin(yaw) * dist, cy - Math.cos(yaw) * dist, h], rot: [pitch, yaw] };
  }

  // ---------- the script (original; spoken by no one: no voice is generated in this preview) ----------
  var SCRIPT = [
    [0.2, 2.2, "Scientists count penguins"],
    [2.3, 4.3, "without setting foot on the ice."],
    [4.5, 6.6, "They count them from space."],
    [6.9, 9.6, "Emperor penguins crowd together on sea ice,"],
    [9.9, 12.6, "and their droppings stain the ice brown."],
    [12.8, 15.0, "Big enough to see from orbit."],
    [15.1, 17.4, "Find the stain, find the colony."],
    [17.7, 21.4, "In 2020, one satellite survey found eleven new colonies."],
    [21.7, 25.6, "Sixty-one known in all."],
    [26.0, 29.6, "No ship, no plane, no boots on the ice."],
    [30.1, 33.4, "It works on land, too."],
    [33.6, 37.4, "In a 2020 study, software counted elephants"],
    [37.7, 41.6, "in satellite photos about as well as people did."],
    [41.8, 42.8, "And at sea?"],
    [43.6, 47.6, "The sharpest satellites see about thirty centimetres per pixel."],
    [47.9, 51.2, "Enough to spot a whale at the surface."],
    [51.4, 54.2, "Ice, grass or water, the method is the same:"],
    [54.5, 56.3, "count it from above."],
    [56.6, 59.6, "Follow, so you see it first."],
  ];
  var maxWords = (PRESET.grammar.read.captions.wordsPerCaption || [1, 3])[1];
  var GROUPS = [];
  SCRIPT.forEach(function (line) {
    var words = line[2].split(" ");
    var weights = words.map(function (w) { return w.length + 2; });
    var total = weights.reduce(function (a, b) { return a + b; }, 0);
    var at = line[0], timed = [];
    words.forEach(function (w, i) {
      var d = (line[1] - line[0]) * weights[i] / total;
      timed.push({ text: w, start: at, end: at + d }); at += d;
    });
    var group = [];
    timed.forEach(function (w, i) {
      group.push(w);
      var brk = /[,.:?]$/.test(w.text) || group.length >= maxWords || i === timed.length - 1;
      if (brk) { GROUPS.push(group); group = []; }
    });
  });
  var capEl = document.getElementById("captions");
  function captions(t) {
    var g = null;
    for (var i = 0; i < GROUPS.length; i++) {
      var gr = GROUPS[i];
      if (t >= gr[0].start && t < gr[gr.length - 1].end + 0.08) { g = gr; break; }
    }
    if (!g) { capEl.innerHTML = ""; return; }
    capEl.innerHTML = g.map(function (w) {
      var cls = t >= w.start && t < w.end ? "now" : (t < w.start ? "next" : "");
      return '<span class="' + cls + '">' + w.text.replace(/</g, "&lt;") + "</span>";
    }).join(" ");
  }

  // ---------- overlays ----------
  var titleEl = document.getElementById("title"), counterEl = document.getElementById("counter");
  var placeEl = document.getElementById("place"), followEl = document.getElementById("follow");
  var roomEl = document.getElementById("room"), roomInner = document.getElementById("roomInner");
  function setHTML(el, html) { if (el.__html !== html) { el.innerHTML = html; el.__html = html; } }
  function show(el, k) { el.style.opacity = String(k); }

  function panel(top, title, label, w, h) {
    var p = document.createElement("div"); p.className = "panel"; p.style.top = top + "px";
    p.innerHTML = '<div class="head"><b>' + title + "</b><i>" + label + "</i></div>";
    var c = document.createElement("canvas"); c.width = w; c.height = h; p.appendChild(c);
    roomInner.appendChild(p); return { el: p, ctx: c.getContext("2d"), w: w, h: h };
  }
  var P1 = panel(250, "KNOWN EMPEROR COLONIES", "SATELLITE SURVEYS", 592, 230);
  var P2 = panel(600, "STAIN SIZE", "COLONY SIZE ESTIMATE", 592, 170);
  var BIG = document.createElement("div"); BIG.className = "big"; BIG.style.cssText = "position:absolute;left:0;width:720px;top:250px;font-size:150px";
  BIG.innerHTML = "+11<small>NEW COLONIES · 2020</small>"; roomInner.appendChild(BIG);
  var BIG2 = document.createElement("div"); BIG2.className = "big"; BIG2.style.cssText = "position:absolute;left:0;width:720px;top:560px;font-size:64px;color:var(--kit-text)";
  BIG2.innerHTML = "61<small>KNOWN IN ALL</small>"; roomInner.appendChild(BIG2);
  var TILES = document.createElement("div"); TILES.className = "panel"; TILES.style.top = "330px";
  TILES.innerHTML = '<div class="head"><b>COUNTED FROM SPACE</b><i>ONE METHOD</i></div><div id="tiles"></div>';
  roomInner.appendChild(TILES);

  function bars(p, k) {
    var c = p.ctx, w = p.w, h = p.h; c.clearRect(0, 0, w, h);
    var vals = [50, 61], labels = ["BEFORE 2020", "AFTER 2020"], max = 70;
    for (var i = 0; i < 2; i++) {
      var x = 70 + i * 260, bw = 180, v = vals[i] * smooth(seg(k, i * 0.35, i * 0.35 + 0.6));
      var bh = (h - 50) * v / max;
      c.fillStyle = i === 1 ? kit.palette.secondary : kit.palette.primary;
      c.fillRect(x, h - 30 - bh, bw, bh);
      c.fillStyle = kit.palette.text; c.font = "800 30px Inter"; c.textAlign = "center";
      if (v > 1) c.fillText(String(Math.round(v)), x + bw / 2, h - 40 - bh);
      c.font = "700 13px Inter"; c.fillStyle = "#9fb2bd"; c.fillText(labels[i], x + bw / 2, h - 8);
    }
  }
  function line(p, k) {
    var c = p.ctx, w = p.w, h = p.h; c.clearRect(0, 0, w, h);
    c.strokeStyle = "rgba(160,190,200,.25)"; c.lineWidth = 1;
    c.beginPath(); c.moveTo(20, h - 20); c.lineTo(w - 10, h - 20); c.moveTo(20, 10); c.lineTo(20, h - 20); c.stroke();
    c.strokeStyle = kit.palette.secondary; c.lineWidth = 4; c.beginPath();
    var n = Math.floor(60 * clamp(k, 0, 1));
    for (var i = 0; i <= n; i++) {
      var x = 20 + (w - 40) * i / 60, y = h - 26 - (h - 50) * Math.pow(i / 60, 1.2) - Math.sin(i * 0.9) * 3;
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.stroke();
    c.font = "700 13px Inter"; c.fillStyle = "#9fb2bd"; c.textAlign = "left"; c.fillText("BIGGER STAIN → MORE BIRDS", 30, 24);
  }

  // ---------- the shots ----------
  // Each shot returns the shader state for a local time u (seconds from its start). Times follow the preset's structure and cuts.
  var rings = function (start, step, count) { return function (i) { return i < count ? smooth(seg(u0, start + i * step, start + i * step + 0.25)) : 0; }; };
  var u0 = 0;
  var SHOTS = [
    { t0: 0, t1: 4.4, f: function (u) {
      u0 = u;
      return { A: { scene: ICE, cam: [-20 + u * 4, 40 + u * 6, 820 - u * 25], rot: [0, 0.15 + u * 0.01] }, objs: objs(STAINS, rings(0.6, 0.45, 7)) };
    } },
    { t0: 4.4, t1: 6.767, f: function (u) {
      var h = 720 * Math.exp(u * 2.6);
      var m = smooth(seg(u, 0.9, 1.5));
      return { A: { scene: ICE, cam: [-10, 60, h], rot: [0, 0.2] }, B: { scene: GLOBE, cam: [lerp(1.3, 3.1, smooth(seg(u, 0.9, 2.37))), -0.9, 0.4 + u * 0.06] },
        mix: m, objs: objs(STAINS, function (i) { return i < 7 ? 1 - seg(u, 0, 0.5) : 0; }) };
    } },
    { t0: 6.767, t1: 9.867, f: function (u) {
      var v = lookAt(-60 + u * 40, 40, 330, 0.9, 0.3 + u * 0.09);
      return { A: { scene: ICE, cam: v.cam, rot: v.rot }, objs: objs(STAINS, function () { return smooth(seg(u, 0.3, 0.8)); }) };
    } },
    { t0: 9.867, t1: 13.3, f: function (u) {
      return { A: { scene: ICE, cam: [20, 40, 95 - u * 9], rot: [0, 0.2 + u * 0.16] }, objs: objs(STAINS, function (i) { return i === 4 ? smooth(seg(u, 0.8, 1.3)) : 0; }) };
    } },
    { t0: 13.3, t1: 16.333, f: function (u) {
      var v = lookAt(0, 0, 1500 + u * 260, 0.45, -0.3 + u * 0.09);
      return { A: { scene: ICE, cam: v.cam, rot: v.rot }, objs: objs(STAINS, function () { return 1; }) };
    } },
    { t0: 16.333, t1: 21.967, room: "charts", f: function (u) { return { A: { scene: ROOM, cam: [u * 2.2, 0, 0] } }; } },
    { t0: 21.967, t1: 26.0, room: "figure", f: function (u) { return { A: { scene: ROOM, cam: [3 + u * 2.4, 0, 0.6] } }; } },
    { t0: 26.0, t1: 30.0, f: function (u) {
      var m = smooth(seg(u, 3.4, 4.0));
      var v = lookAt(40, 10, 260, 1.0, 0.3);
      return { A: { scene: ROOM, cam: [5 + u * 1.6, lerp(2.6, 0.4, smooth(seg(u, 0, 1.6))), 0] }, B: { scene: SAVANNA, cam: v.cam, rot: v.rot },
        mix: m, sat: smooth(seg(u, 0, 0.3)), satYaw: 0.6 + u * 1.1, objs: objs(ELEPHANTS, null) };
    } },
    { t0: 30.0, t1: 38.7, f: function (u) {
      u0 = u;
      var v = lookAt(40, 10, 260 - u * 12, 1.0, 0.3 + u * 0.2);
      return { A: { scene: SAVANNA, cam: v.cam, rot: v.rot }, objs: objs(ELEPHANTS, rings(2.0, 0.35, 12)) };
    } },
    { t0: 38.7, t1: 43.367, f: function (u) {
      return { A: { scene: SAVANNA, cam: [120 + u * 8, 10 + u * 6, 270 - u * 14], rot: [0, 0.9 + u * 0.09] }, objs: objs(ELEPHANTS, function () { return 1; }) };
    } },
    { t0: 43.367, t1: 54.4, f: function (u) {
      var h = 700 * Math.exp(-u * 0.11);
      return { A: { scene: OCEAN, cam: [10 + u * 4, 10 + u * 5, h], rot: [0, -0.4 + u * 0.05] },
        objs: objs(WHALES, function (i) { return smooth(seg(u, 4.7 + i * 0.5, 5.2 + i * 0.5)); }) };
    } },
    { t0: 54.4, t1: 56.467, room: "tiles", f: function (u) { return { A: { scene: ROOM, cam: [8 + u * 2.4, 0, 0] } }; } },
    { t0: 56.467, t1: 60.009, f: function (u) {
      return { A: { scene: ICE, cam: [-30 + u * 12, 30 + u * 16, 860 - u * 60], rot: [0, 0.12 + u * 0.05] }, objs: objs(STAINS, function (i) { return i < 7 ? 1 : 0; }) };
    } },
  ];

  // Punch-ins: the preset's measured zoom jumps, applied as quick scale steps that last until the next cut.
  var JUMPS = PRESET.grammar.measured.zoomJumps;
  var CUTS = [0].concat(PRESET.grammar.measured.cutsMs.map(function (ms) { return ms / 1000; }));
  function shotStart(t) { var s = 0; CUTS.forEach(function (c) { if (c <= t) s = c; }); return s; }
  // Jumps that fall where a shot makes its own camera move (the pull-up at 4.4 s, the push into the satellite at 26 s) are drawn by that
  // move, not as a scale step: the preset does not say what each jump belongs to.
  var OWN_MOVES = L ? L.zoomJumpKinds.filter(function (j) { return j.kind === "camera_move"; }).map(function (j) { return j.atMs / 1000; }) : [4.4, 26];
  function stageZoom(t) {
    var start = shotStart(t), z = 1;
    JUMPS.forEach(function (j) {
      var at = j.atMs / 1000;
      if (at >= start && at <= t && OWN_MOVES.indexOf(at) < 0) z *= Math.exp(Math.log(j.scale) * smooth((t - at) / 0.12));
    });
    return Math.min(z, 2.2);
  }

  function shotAt(t) { for (var i = 0; i < SHOTS.length; i++) if (t < SHOTS[i].t1) return SHOTS[i]; return SHOTS[SHOTS.length - 1]; }

  function overlay(t, shot) {
    // Hook title and counter.
    var titleEnd = L ? L.title.visibleUntilMs / 1000 : 4.35;
    var titleK = 1 - seg(t, titleEnd - 0.25, titleEnd);
    if (t < titleEnd) {
      setHTML(titleEl, 'They count penguins<br>from <span class="accent">outer space</span>');
      titleEl.style.transform = "scale(" + lerp(0.92, 1, smooth(seg(t, 0.05, 0.3))) + ")";
      show(titleEl, smooth(seg(t, 0.05, 0.25)) * titleK);
    } else show(titleEl, 0);
    var count = null, label = "";
    if (t < 4.4) { count = Math.round(7 * 0 + SHOTS[0].f(t).objs.filter(function (v, i) { return i % 4 === 3 && v > 0.5; }).length); label = "STAINS MARKED"; }
    else if (t >= 30 && t < 43.367) {
      var f = shotAt(t).f(t - shotAt(t).t0).objs; count = 0;
      for (var i = 0; i < 12; i++) if (f[i * 4 + 3] > 0.5) count++;
      label = "ELEPHANTS MARKED";
    } else if (t >= 44.2 && t < 49.5) { count = "30 cm"; label = "PER PIXEL"; }
    if (count !== null) {
      setHTML(counterEl, '<div class="num">' + count + '</div><div class="pill">' + label + "</div>");
      counterEl.style.top = t < 4.4 ? Math.round((L ? L.counter.topFrac : 0.2) * H) + "px" : "120px";
      show(counterEl, 1);
    } else show(counterEl, 0);
    var place = null;
    if (t >= 6.767 && t < 13.3) place = "ANTARCTICA · SEA ICE";
    else if (t >= 38.7 && t < 43.367) place = "AFRICA · 2020 STUDY";
    else if (t >= 43.367 && t < 44.2) place = "OPEN OCEAN";
    else if (t >= 49.5 && t < 54.4) place = "OPEN OCEAN";
    if (place) { setHTML(placeEl, '<span class="pill">' + place + "</span>"); placeEl.style.top = t >= 49.5 ? "120px" : "70px"; show(placeEl, 1); }
    else show(placeEl, 0);
    var followAt = L ? (PRESET.reference.durationMs - L.follow.fromEndMs) / 1000 : 57.2;
    if (t >= followAt) { setHTML(followEl, "<span>+ Follow</span>"); followEl.style.transform = "scale(" + lerp(0.6, 1, smooth(seg(t, followAt, followAt + 0.25))) + ")"; show(followEl, 1); }
    else show(followEl, 0);

    // The room overlays.
    var r = shot.room;
    show(roomEl, r ? 1 : 0);
    if (r) {
      var u = t - shot.t0;
      show(P1.el, r === "charts" ? 1 : 0); show(P2.el, r === "charts" ? 1 : 0);
      show(BIG, r === "figure" ? smooth(seg(u, 0.1, 0.4)) : 0); show(BIG2, r === "figure" ? smooth(seg(u, 0.9, 1.2)) : 0);
      show(TILES, r === "tiles" ? 1 : 0);
      if (r === "charts") { bars(P1, seg(u, 0.3, 2.2)); line(P2, seg(u, 1.6, 4.0)); }
      roomInner.style.transform = "translateZ(" + lerp(-220, 0, smooth(seg(u, 0, 5))) + "px) rotateY(" + lerp(-14, 6, seg(u, 0, 5)) + "deg) translateY(" + (Math.sin(u * 1.3) * 18) + "px)";
    }
  }

  window.__ready = (async function () {
    await document.fonts.load('800 50px "' + kit.fonts.display + '"');
    await document.fonts.load('italic 700 50px "FreeSerif"');
    // The three tiles of the payoff panel: stills of the three scenes, drawn by the same shader.
    var tiles = document.getElementById("tiles");
    [[ICE, [20, 40, 220], [0, 0.2], STAINS], [SAVANNA, [40, 10, 300], [0, 0.6], ELEPHANTS], [OCEAN, [0, 0, 160], [0, 0.3], WHALES]].forEach(function (s) {
      draw({ A: { scene: s[0], cam: s[1], rot: s[2] }, objs: objs(s[3], function () { return 1; }) }, 0);
      var c = document.createElement("canvas"); c.width = 380; c.height = 380;
      c.getContext("2d").drawImage(canvas, 0, 280, 720, 720, 0, 0, 380, 380);
      var img = document.createElement("img"); img.src = c.toDataURL("image/png"); tiles.appendChild(img);
    });
    return true;
  })();

  window.renderAt = function (t) {
    var shot = shotAt(t);
    var state = shot.f(t - shot.t0);
    draw(state, t);
    var z = stageZoom(t);
    canvas.style.transform = "scale(" + z + ")";
    roomEl.style.transform = "scale(" + z + ")";
    overlay(t, shot);
    captions(t);
  };
})();
