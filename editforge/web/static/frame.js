"use strict";
// Frame (Editor): the canvas shape, a background layer, the picture moved / scaled / turned, and a mask with soft edges.
// Like CapCut: below, the same video fills the canvas (blurred, black or white); above, the video itself, and a mask
// can cut it to a strip, a rectangle, a circle or one side, so the blurred layer shows around it.
// The export draws it with FFmpeg (render/filters.py ItemBuilder._frame); here a <canvas> draws the same thing live.
const Frame = (function () {
  const RATIOS = [["original", "Original", null], ["16:9", "16:9", 16 / 9], ["4:3", "4:3", 4 / 3], ["2.35:1", "2.35:1", 2.35], ["2:1", "2:1", 2],
    ["1.85:1", "1.85:1", 1.85], ["9:16", "9:16", 9 / 16], ["3:4", "3:4", 3 / 4], ["1:1", "1:1", 1], ["4:5", "4:5", 4 / 5], ["5.8in", "5.8-inch", 9 / 19.5]];
  const MASKS = [["none", "None"], ["strip", "Strip"], ["vstrip", "Side strip"], ["rect", "Rectangle"], ["circle", "Circle"], ["split", "Split"]];
  const DEF = () => ({ ratio: "original", bg: "blur", blur: 50, scale: 1, x: 0, y: 0, rotate: 0,
    mask: { shape: "none", x: 0.5, y: 0.5, w: 1, h: 0.35, feather: 20, invert: false, rot: 0 } });
  const F = { get: null, set: null, video: null, srcAspect: 16 / 9, cv: null, top: null, maskCv: null, maskKey: "", fadeCv: null, last: "", raf: 0, host: null,
    ov: null, editing: false, target: "video", grid: false, drag: null, guides: [] };
  try { F.grid = localStorage.getItem("ef.grid") === "1"; } catch (e) { /* storage not available */ }

  function full(fr) {
    const d = DEF();
    if (!fr) return d;
    return Object.assign(d, fr, { mask: Object.assign(d.mask, fr.mask || {}) });
  }
  function active(fr) {
    if (!fr) return false;
    const f = full(fr);
    return f.ratio !== "original" || Math.abs(f.scale - 1) > 1e-3 || Math.abs(f.x) > 1e-4 || Math.abs(f.y) > 1e-4 || Math.abs(f.rotate) > 1e-3 || f.mask.shape !== "none";
  }
  function aspect(fr) {
    const r = RATIOS.find((x) => x[0] === full(fr).ratio);
    return r && r[2] ? r[2] : F.srcAspect;
  }

  // ---------------------------------------------------------------- live drawing
  /** Where the sharp picture sits on a canvas of W x H (the canvas has the picture's aspect = srcAspect). */
  function pictureBox(f, W, H) {
    const vw = F.srcAspect, vh = 1, k = Math.min(W / vw, H / vh) * f.scale;
    const cx = W / 2 + f.x * W / 2, cy = H / 2 + f.y * H / 2, hw = vw * k / 2, hh = vh * k / 2;
    return { cx, cy, hw, hh, rot: f.rotate, l: cx - hw, r: cx + hw, t: cy - hh, b: cy + hh };
  }
  /** White inside the picture, fading to nothing at its own border (sides that reach the canvas edge stay solid). */
  function fadeCanvas(g, W, H, r) {
    const c = F.fadeCv || document.createElement("canvas");
    c.width = W; c.height = H;
    const x = c.getContext("2d");
    x.clearRect(0, 0, W, H);
    x.filter = "blur(" + (r / 4).toFixed(1) + "px)";
    x.fillStyle = "#fff";
    if (Math.abs(g.rot) > 0.01) {
      x.translate(g.cx, g.cy); x.rotate(g.rot * Math.PI / 180);
      x.fillRect(-g.hw + r / 2, -g.hh + r / 2, g.hw * 2 - r, g.hh * 2 - r);
    } else {
      const l = g.l <= 1 ? -W : g.l + r / 2, rr = g.r >= W - 1 ? W * 2 : g.r - r / 2;
      const t = g.t <= 1 ? -H : g.t + r / 2, bb = g.b >= H - 1 ? H * 2 : g.b - r / 2;
      x.fillRect(l, t, rr - l, bb - t);
    }
    x.filter = "none";
    F.fadeCv = c;
    return c;
  }
  function maskCanvas(f, W, H) {
    const m = f.mask;
    const key = JSON.stringify([m, f.scale, f.x, f.y, f.rotate]) + W + "x" + H;
    if (key === F.maskKey && F.maskCv) return F.maskCv;
    const c = F.maskCv || document.createElement("canvas");
    c.width = W; c.height = H;
    const x = c.getContext("2d");
    x.clearRect(0, 0, W, H);
    const soft = m.feather / 100 * Math.min(W, H) * 0.08;
    x.save();
    x.filter = soft > 0.3 ? "blur(" + soft.toFixed(1) + "px)" : "none";
    x.fillStyle = "#fff";
    const cx = m.x * W, cy = m.y * H, hw = m.w * W / 2, hh = m.h * H / 2, big = Math.max(W, H) * 3;
    x.translate(cx, cy); x.rotate((m.rot || 0) * Math.PI / 180);
    const shape = () => {
      x.beginPath();
      if (m.shape === "rect") x.rect(-hw, -hh, hw * 2, hh * 2);
      else if (m.shape === "circle") x.ellipse(0, 0, hw, hh, 0, 0, Math.PI * 2);
      else if (m.shape === "split") x.rect(-big, 0, big * 2, big);
      else if (m.shape === "vstrip") x.rect(-hw, -big, hw * 2, big * 2);
      else x.rect(-big, -hh, big * 2, hh * 2);
      x.fill();
    };
    if (m.invert) { x.fillRect(-big, -big, big * 2, big * 2); x.globalCompositeOperation = "destination-out"; shape(); x.globalCompositeOperation = "source-over"; }
    else shape();
    x.restore();
    x.filter = "none";
    if (soft > 0.3) { x.save(); x.globalCompositeOperation = "destination-in"; x.drawImage(fadeCanvas(pictureBox(f, W, H), W, H, 2 * soft), 0, 0); x.restore(); }
    F.maskCv = c; F.maskKey = key;
    return c;
  }
  function draw(force) {
    const fr = F.get(), v = F.video();
    if (!F.cv || !active(fr) || !v || !v.videoWidth) return;
    const f = full(fr);
    const box = F.cv.parentElement.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(2, Math.round(box.width * dpr)), H = Math.max(2, Math.round(box.height * dpr));
    const sig = [v.currentTime.toFixed(3), W, H, JSON.stringify(f), v.style.filter].join("|");
    if (!force && sig === F.last && v.paused) return;
    F.last = sig;
    if (F.cv.width !== W || F.cv.height !== H) { F.cv.width = W; F.cv.height = H; }
    if (!F.top) F.top = document.createElement("canvas");
    if (F.top.width !== W || F.top.height !== H) { F.top.width = W; F.top.height = H; }
    const ctx = F.cv.getContext("2d"), vw = v.videoWidth, vh = v.videoHeight;
    // the background layer: the video filling the canvas
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    if (f.bg === "blur") {
      const kc = Math.max(W / vw, H / vh), dw = vw * kc, dh = vh * kc;
      const sigma = (1 + f.blur / 100 * Math.min(W, H) * 0.06);
      ctx.filter = "blur(" + sigma.toFixed(1) + "px)";
      ctx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
      ctx.filter = "none";
    } else { ctx.fillStyle = f.bg === "white" ? "#fff" : "#000"; ctx.fillRect(0, 0, W, H); }
    ctx.restore();
    // the picture: fitted, then scaled, moved and turned
    const t = F.top.getContext("2d");
    t.save(); t.clearRect(0, 0, W, H);
    const k = Math.min(W / vw, H / vh) * f.scale;
    t.translate(W / 2 + f.x * W / 2, H / 2 + f.y * H / 2);
    t.rotate(f.rotate * Math.PI / 180);
    t.drawImage(v, -vw * k / 2, -vh * k / 2, vw * k, vh * k);
    t.restore();
    if (f.mask.shape !== "none") {
      t.save(); t.globalCompositeOperation = "destination-in"; t.drawImage(maskCanvas(f, W, H), 0, 0); t.restore();
    }
    ctx.drawImage(F.top, 0, 0);
    F.cv.style.filter = v.style.filter;          // the piece's own look (colour, black and white ...)
  }
  function loop() { try { draw(false); } catch (e) { /* a frame that is not ready yet */ } F.raf = requestAnimationFrame(loop); }
  function show() {
    const on = active(F.get());
    F.host.classList.toggle("framed", on);
    F.cv.hidden = !on;
    if (on) draw(true);
    paintOverlay();
  }


  // ---------------------------------------------------------------- the handles on the viewer (like CapCut)
  const SNAP = 6, HIT = 12;
  const rad = (d) => d * Math.PI / 180;
  function localOf(g, p) {
    const c = Math.cos(rad(g.rot)), s = Math.sin(rad(g.rot)), dx = p.x - g.cx, dy = p.y - g.cy;
    return { u: dx * c + dy * s, v: -dx * s + dy * c };
  }
  function worldOf(g, u, v) {
    const c = Math.cos(rad(g.rot)), s = Math.sin(rad(g.rot));
    return { x: g.cx + u * c - v * s, y: g.cy + u * s + v * c };
  }
  /** The box the handles sit on: the picture, or the mask (target). `sides` says which handles that shape has. */
  function handleBox(f, W, H) {
    if (F.target === "mask" && f.mask.shape !== "none") {
      const m = f.mask, sh = m.shape, big = Math.max(W, H) * 1.5;
      const g = { kind: "mask", cx: m.x * W, cy: m.y * H, hw: m.w * W / 2, hh: m.h * H / 2, rot: m.rot || 0, sides: "uv", corners: true };
      if (sh === "strip") { g.hw = big; g.sides = "v"; g.corners = false; }
      if (sh === "vstrip") { g.hh = big; g.sides = "u"; g.corners = false; }
      if (sh === "split") { g.hw = big; g.hh = 0; g.sides = ""; g.corners = false; }
      return g;
    }
    const g = pictureBox(f, W, H);
    return Object.assign(g, { kind: "video", sides: "", corners: true });
  }
  function pointsOf(g) {
    const pts = [];
    if (g.kind === "video" || g.corners) for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) pts.push(Object.assign(worldOf(g, a * g.hw, b * g.hh), { id: "c", a, b }));
    if (g.sides.includes("u")) for (const a of [-1, 1]) pts.push(Object.assign(worldOf(g, a * g.hw, 0), { id: "su", a, b: 0 }));
    if (g.sides.includes("v")) for (const b of [-1, 1]) pts.push(Object.assign(worldOf(g, 0, b * g.hh), { id: "sv", a: 0, b }));
    return pts;
  }
  function knobOf(g) { return worldOf(g, 0, -Math.min(g.hh, 4000) - 26); }
  function hitTest(g, p) {
    const kn = knobOf(g);
    if (Math.hypot(p.x - kn.x, p.y - kn.y) <= HIT) return { id: "rot" };
    for (const q of pointsOf(g)) if (Math.hypot(p.x - q.x, p.y - q.y) <= HIT) return q;
    const l = localOf(g, p);
    if (g.kind === "mask") {
      const sh = F.get() ? full(F.get()).mask.shape : "";
      if (sh === "split") return Math.abs(l.v) <= HIT ? { id: "body" } : null;
      if (sh === "strip") return Math.abs(l.v) <= g.hh + 4 ? { id: "body" } : null;
      if (sh === "vstrip") return Math.abs(l.u) <= g.hw + 4 ? { id: "body" } : null;
      if (sh === "circle") return (l.u * l.u) / (g.hw * g.hw) + (l.v * l.v) / (g.hh * g.hh) <= 1 ? { id: "body" } : null;
    }
    return Math.abs(l.u) <= g.hw && Math.abs(l.v) <= g.hh ? { id: "body" } : null;
  }
  function outSize(f) {
    const v = F.video && F.video(), long = v && v.videoWidth ? Math.max(v.videoWidth, v.videoHeight) : 1920, a = aspect(f);
    return a >= 1 ? { w: long, h: long / a } : { w: long * a, h: long };
  }
  function pos(e) { const b = F.ov.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; }
  function norm180(d) { d = ((d + 180) % 360 + 360) % 360 - 180; return d; }

  function move(e) {
    const d = F.drag;
    if (!d) {
      if (!F.editing) return;
      const b = F.ov.getBoundingClientRect(), f = full(F.get()), g = handleBox(f, b.width, b.height), h = hitTest(g, pos(e));
      F.ov.style.cursor = !h ? "default" : h.id === "rot" ? "grab" : h.id === "body" ? "move" : h.id === "c" ? "nwse-resize" : h.id === "su" ? "ew-resize" : "ns-resize";
      return;
    }
    const b = F.ov.getBoundingClientRect(), W = b.width, H = b.height, p = pos(e), fr = full(d.fr0), g0 = d.g0;
    F.guides = [];
    if (d.id === "body") {
      let cx = g0.cx + (p.x - d.p0.x), cy = g0.cy + (p.y - d.p0.y);
      const cand = (c, size, total, axis) => {      // snap the middle and the two edges to the canvas
        let best = null;
        for (const [pt, to] of [[c, total / 2], [c - size, 0], [c + size, total]]) {
          const dist = Math.abs(pt - to);
          if (dist <= SNAP && (!best || dist < best.dist)) best = { dist, shift: to - pt, line: to, axis };
        }
        return best;
      };
      const cs = Math.cos(rad(g0.rot)), sn = Math.sin(rad(g0.rot));
      const bw = Math.abs(g0.hw * cs) + Math.abs(g0.hh * sn), bh = Math.abs(g0.hw * sn) + Math.abs(g0.hh * cs);
      const small = g0.kind === "mask";
      const sx = small ? cand(cx, 0, W, "x") : cand(cx, bw, W, "x"), sy = small ? cand(cy, 0, H, "y") : cand(cy, bh, H, "y");
      const sh = fr.mask.shape;
      const lockX = small && (sh === "strip" || sh === "split"), lockY = small && sh === "vstrip";
      if (sx && !lockX) { cx += sx.shift; F.guides.push(sx); }
      if (sy && !lockY) { cy += sy.shift; F.guides.push(sy); }
      if (small) {
        if (!lockX) fr.mask.x = +Math.min(1, Math.max(0, cx / W)).toFixed(4);
        if (!lockY) fr.mask.y = +Math.min(1, Math.max(0, cy / H)).toFixed(4);
      } else { fr.x = +Math.max(-2, Math.min(2, (cx - W / 2) / (W / 2))).toFixed(4); fr.y = +Math.max(-2, Math.min(2, (cy - H / 2) / (H / 2))).toFixed(4); }
    } else if (d.id === "rot") {
      let ang = Math.atan2(p.y - g0.cy, p.x - g0.cx) * 180 / Math.PI + 90;
      ang = norm180(ang);
      const near = Math.round(ang / 45) * 45;
      if (Math.abs(ang - near) <= 3) { ang = norm180(near); F.guides.push({ axis: "angle", line: ang }); }
      ang = +ang.toFixed(1);
      if (g0.kind === "mask") fr.mask.rot = ang; else fr.rotate = ang;
      d.label = Math.round(ang) + "°";
    } else if (d.id === "c" && g0.kind === "video") {
      const r0 = Math.hypot(d.p0.x - g0.cx, d.p0.y - g0.cy) || 1;
      let sc = d.fr0.scale * Math.hypot(p.x - g0.cx, p.y - g0.cy) / r0;
      sc = Math.min(4, Math.max(0.1, sc));
      if (Math.abs(sc - 1) < 0.03) sc = 1;
      fr.scale = +sc.toFixed(3);
      d.label = Math.round(sc * 100) + "%";
    } else if (g0.kind === "mask") {
      const l = localOf(g0, p), m = fr.mask;
      if (d.id === "su" || d.id === "c") m.w = +Math.min(2, Math.max(0.02, 2 * Math.abs(l.u) / W)).toFixed(4);
      if (d.id === "sv" || d.id === "c") m.h = +Math.min(2, Math.max(0.02, 2 * Math.abs(l.v) / H)).toFixed(4);
    }
    F.set(fr, true);
  }
  function down(e) {
    if (!F.editing || e.button) return;
    const b = F.ov.getBoundingClientRect(), f = full(F.get()), g = handleBox(f, b.width, b.height), p = pos(e), h = hitTest(g, p);
    if (!h) return;
    e.preventDefault();
    F.drag = { id: h.id, a: h.a, b: h.b, p0: p, g0: g, fr0: JSON.parse(JSON.stringify(f)), label: "" };
    try { F.ov.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
    paintOverlay();
  }
  function up() {
    if (!F.drag) return;
    F.drag = null; F.guides = [];
    F.set(full(F.get()));                       // keep it (this is also what saves it)
    renderPanel();
    paintOverlay();
  }

  function paintOverlay() {
    const cv = F.ov;
    if (!cv) return;
    const on = F.editing || F.grid;
    cv.hidden = !on;
    cv.classList.toggle("editing", F.editing);
    if (!on) return;
    const box = F.host.getBoundingClientRect(), W = Math.round(box.width), H = Math.round(box.height), dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const x = cv.getContext("2d");
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, W, H);
    const accent = (getComputedStyle(document.documentElement).getPropertyValue("--accent") || "").trim() || "#ff4d8d";
    const f = full(F.get());
    if (F.grid) {                               // a grid of sixths; the middle lines are stronger
      x.lineWidth = 1;
      for (let i = 1; i < 6; i++) {
        x.strokeStyle = i === 3 ? "rgba(255,255,255,.55)" : "rgba(255,255,255,.2)";
        x.beginPath(); x.moveTo(Math.round(W * i / 6) + .5, 0); x.lineTo(Math.round(W * i / 6) + .5, H); x.stroke();
        x.beginPath(); x.moveTo(0, Math.round(H * i / 6) + .5); x.lineTo(W, Math.round(H * i / 6) + .5); x.stroke();
      }
    }
    const label = (txt, px, py) => {
      x.font = "600 11px system-ui, sans-serif";
      const w = x.measureText(txt).width + 10;
      const lx = Math.min(W - w - 2, Math.max(2, px - w / 2)), ly = Math.min(H - 18, Math.max(2, py - 8));
      x.fillStyle = "rgba(0,0,0,.72)"; x.beginPath(); x.roundRect(lx, ly, w, 16, 4); x.fill();
      x.fillStyle = "#fff"; x.textBaseline = "middle"; x.fillText(txt, lx + 5, ly + 8.5);
    };
    if (F.editing) {
      const g = handleBox(f, W, H), pic = pictureBox(f, W, H), out = outSize(f), kx = out.w / W;
      // guide lines (when a snap happens)
      x.strokeStyle = accent; x.lineWidth = 1; x.setLineDash([5, 4]);
      for (const q of F.guides) {
        x.beginPath();
        if (q.axis === "x") { x.moveTo(Math.round(q.line) + .5, 0); x.lineTo(Math.round(q.line) + .5, H); }
        else if (q.axis === "y") { x.moveTo(0, Math.round(q.line) + .5); x.lineTo(W, Math.round(q.line) + .5); }
        else { const a = rad(q.line - 90), L = Math.max(W, H); x.moveTo(g.cx - Math.cos(a) * L, g.cy - Math.sin(a) * L); x.lineTo(g.cx + Math.cos(a) * L, g.cy + Math.sin(a) * L); }
        x.stroke();
      }
      x.setLineDash([]);
      // the outline
      x.save(); x.translate(g.cx, g.cy); x.rotate(rad(g.rot)); x.lineWidth = 1.5; x.strokeStyle = accent;
      if (g.kind === "mask") x.setLineDash([6, 4]);
      const sh = f.mask.shape;
      x.beginPath();
      if (g.kind === "mask" && sh === "circle") x.ellipse(0, 0, g.hw, g.hh, 0, 0, Math.PI * 2);
      else if (g.kind === "mask" && sh === "split") { x.moveTo(-g.hw, 0); x.lineTo(g.hw, 0); }
      else if (g.kind === "mask" && sh === "vstrip") { x.moveTo(-g.hw, -g.hh); x.lineTo(-g.hw, g.hh); x.moveTo(g.hw, -g.hh); x.lineTo(g.hw, g.hh); }
      else if (g.kind === "mask" && sh === "strip") { x.moveTo(-g.hw, -g.hh); x.lineTo(g.hw, -g.hh); x.moveTo(-g.hw, g.hh); x.lineTo(g.hw, g.hh); }
      else x.rect(-g.hw, -g.hh, g.hw * 2, g.hh * 2);
      x.stroke();
      x.setLineDash([]); x.restore();
      // handles
      x.fillStyle = "#fff"; x.strokeStyle = accent; x.lineWidth = 1.5;
      for (const q of pointsOf(g)) { x.beginPath(); x.rect(q.x - 4.5, q.y - 4.5, 9, 9); x.fill(); x.stroke(); }
      const kn = knobOf(g), top = worldOf(g, 0, -g.hh);
      x.beginPath(); x.moveTo(top.x, top.y); x.lineTo(kn.x, kn.y); x.stroke();
      x.beginPath(); x.arc(kn.x, kn.y, 6, 0, Math.PI * 2); x.fill(); x.stroke();
      // measurements: how far the picture is from each edge of the frame, in pixels of the finished video
      if (g.kind === "video" || F.drag || F.grid) {
        const cs = Math.cos(rad(pic.rot)), sn = Math.sin(rad(pic.rot));
        const bw = Math.abs(pic.hw * cs) + Math.abs(pic.hh * sn), bh = Math.abs(pic.hw * sn) + Math.abs(pic.hh * cs);
        const L = pic.cx - bw, R = pic.cx + bw, T = pic.cy - bh, B = pic.cy + bh;
        x.strokeStyle = accent; x.lineWidth = 1;
        const edge = (x1, y1, x2, y2, v, lx, ly) => {
          if (Math.abs(x2 - x1) + Math.abs(y2 - y1) < 3) return;
          x.beginPath(); x.moveTo(x1, y1); x.lineTo(x2, y2); x.stroke();
          label(Math.round(v * kx) + " px", lx, ly);
        };
        edge(0, pic.cy, L, pic.cy, L, L / 2, pic.cy);
        edge(R, pic.cy, W, pic.cy, W - R, (R + W) / 2, pic.cy);
        edge(pic.cx, 0, pic.cx, T, T, pic.cx, T / 2);
        edge(pic.cx, B, pic.cx, H, H - B, pic.cx, (B + H) / 2);
      }
      if (F.drag && F.drag.label) label(F.drag.label, kn.x, kn.y - 16);
    }
  }

  // ---------------------------------------------------------------- the panel
  function change(fn) { const fr = full(F.get()); fn(fr); F.set(fr); renderPanel(); show(); }
  function slider(label, min, max, step, val, fmt, onv) {
    const r = el("input", { type: "range", class: "rng", min: String(min), max: String(max), step: String(step), value: String(val), "aria-label": label });
    const b = el("b", { class: "num", text: fmt(val) });
    r.addEventListener("input", () => { b.textContent = fmt(+r.value); const fr = full(F.get()); onv(fr, +r.value); F.set(fr, true); show(); });
    r.addEventListener("change", () => { const fr = full(F.get()); onv(fr, +r.value); F.set(fr); });
    const box = el("div", { class: "field" }, el("span", {}, label + " ", b), r);
    paintRange(r);
    return box;
  }
  function renderPanel() {
    const host = $("framePanel");
    if (!host || host.closest("section").hidden) return;
    const f = full(F.get());
    host.replaceChildren();
    // shape of the canvas
    const shapes = el("div", { class: "ratios" });
    for (const [k, name, a] of RATIOS) {
      const ar = a || F.srcAspect;
      const pic = el("i", { class: "ratio-pic" });
      if (ar >= 1) { pic.style.width = "26px"; pic.style.height = Math.max(8, Math.round(26 / ar)) + "px"; } else { pic.style.height = "26px"; pic.style.width = Math.max(8, Math.round(26 * ar)) + "px"; }
      shapes.append(el("button", { type: "button", class: "ratio" + (f.ratio === k ? " on" : ""), onclick: () => change((fr) => { fr.ratio = k; }) }, el("span", { class: "pic-box" }, pic), el("small", { text: name })));
    }
    host.append(el("div", { class: "field" }, el("span", { text: "Shape of the video" }), shapes));
    // background layer
    host.append(el("div", { class: "layer-h" }, icon("layers", "s"), el("b", { text: "Background layer" }), el("small", { text: "fills the frame" })));
    host.append(el("div", { class: "field" }, segmented([["blur", "Blur"], ["black", "Black"], ["white", "White"]], f.bg, (v) => change((fr) => { fr.bg = v; }))));
    if (f.bg === "blur") host.append(slider("Blur strength", 0, 100, 1, f.blur, (v) => Math.round(v) + "%", (fr, v) => { fr.blur = v; }));
    // the picture
    host.append(el("div", { class: "layer-h" }, icon("film", "s"), el("b", { text: "Video layer" }), el("small", { text: "on top" })));
    if (F.target === "mask" && f.mask.shape === "none") F.target = "video";
    host.append(el("div", { class: "field" }, el("span", { text: "Drag on the viewer" }),
      segmented(f.mask.shape === "none" ? [["video", "Video layer"]] : [["video", "Video layer"], ["mask", "Mask"]], F.target, (v) => { F.target = v; paintOverlay(); renderPanel(); })));
    const gr = el("input", { type: "checkbox", class: "sw" }); gr.checked = F.grid;
    gr.addEventListener("change", () => { F.grid = gr.checked; try { localStorage.setItem("ef.grid", F.grid ? "1" : "0"); } catch (e) { /* ignore */ } paintOverlay(); });
    host.append(el("label", { class: "swl" }, el("span", { text: "Show the grid and edge distances" }), gr));
    host.append(el("p", { class: "hint", text: "Drag the picture to move it. Drag a square corner to resize. Drag the round knob to turn. Lines show when it snaps to the middle or the edges." }));
    host.append(slider("Size", 10, 400, 1, Math.round(f.scale * 100), (v) => Math.round(v) + "%", (fr, v) => { fr.scale = v / 100; }));
    host.append(el("div", { class: "grid2" },
      slider("Left / right", -100, 100, 1, Math.round(f.x * 100), (v) => String(Math.round(v)), (fr, v) => { fr.x = v / 100; }),
      slider("Up / down", -100, 100, 1, Math.round(f.y * 100), (v) => String(Math.round(v)), (fr, v) => { fr.y = v / 100; })));
    host.append(slider("Turn", -180, 180, 1, f.rotate, (v) => Math.round(v) + "°", (fr, v) => { fr.rotate = v; }));
    const fill = () => { const a = aspect(F.get()), s = F.srcAspect; return Math.max(a / s, s / a); };
    host.append(el("div", { class: "btns wrap" },
      btn("Fit", { cls: "sm-txt", title: "The whole picture inside the frame", onclick: () => change((fr) => { fr.scale = 1; fr.x = 0; fr.y = 0; }) }),
      btn("Fill", { cls: "sm-txt", title: "Fill the frame (the edges are cut)", onclick: () => change((fr) => { fr.scale = +fill().toFixed(3); fr.x = 0; fr.y = 0; }) }),
      btn("Center", { cls: "sm-txt", onclick: () => change((fr) => { fr.x = 0; fr.y = 0; }) }),
      btn("Straight", { cls: "sm-txt", title: "Turn back to 0°", onclick: () => change((fr) => { fr.rotate = 0; }) })));
    // mask
    host.append(el("div", { class: "layer-h" }, icon("crop", "s"), el("b", { text: "Mask" }), el("small", { text: "shows the video layer only inside" })));
    const chips = el("div", { class: "chips mask-chips" });
    for (const [k, name] of MASKS) chips.append(el("button", { type: "button", class: "chip" + (f.mask.shape === k ? " on" : ""), text: name,
      onclick: () => change((fr) => { fr.mask.shape = k; if (k === "circle" && fr.mask.w > 0.9) { fr.mask.w = 0.5; fr.mask.h = 0.5 * aspect(fr); } }) }));
    host.append(chips);
    if (f.mask.shape !== "none") {
      const sh = f.mask.shape;
      if (sh !== "split") {
        host.append(el("div", { class: "grid2" },
          sh === "strip" ? null : slider("Width", 2, 150, 1, Math.round(f.mask.w * 100), (v) => Math.round(v) + "%", (fr, v) => { fr.mask.w = v / 100; }),
          sh === "vstrip" ? null : slider("Height", 2, 150, 1, Math.round(f.mask.h * 100), (v) => Math.round(v) + "%", (fr, v) => { fr.mask.h = v / 100; })));
      }
      host.append(el("div", { class: "grid2" },
        sh === "strip" || sh === "split" ? null : slider("Mask left / right", 0, 100, 1, Math.round(f.mask.x * 100), (v) => Math.round(v) + "%", (fr, v) => { fr.mask.x = v / 100; }),
        sh === "vstrip" ? null : slider("Mask up / down", 0, 100, 1, Math.round(f.mask.y * 100), (v) => Math.round(v) + "%", (fr, v) => { fr.mask.y = v / 100; })));
      host.append(slider("Turn the mask", -180, 180, 1, f.mask.rot || 0, (v) => Math.round(v) + "°", (fr, v) => { fr.mask.rot = v; }));
      host.append(slider("Soft edges", 0, 100, 1, f.mask.feather, (v) => Math.round(v) + "%", (fr, v) => { fr.mask.feather = v; }));
      const inv = el("input", { type: "checkbox", class: "sw" }); inv.checked = !!f.mask.invert;
      inv.addEventListener("change", () => change((fr) => { fr.mask.invert = inv.checked; }));
      host.append(el("label", { class: "swl" }, el("span", { text: "Turn the mask inside out" }), inv));
    }
    host.append(btn("Reset the frame", { icon: "restore", cls: "ghost", onclick: () => change((fr) => { Object.assign(fr, DEF()); }) }));
    host.append(el("p", { class: "hint", text: "The viewer shows the frame live. The export draws it in full quality." }));
  }

  /** get(): the project's frame; set(frame, live): store it (live = while dragging); video(): the playing video element. */
  function init(opts) {
    F.get = opts.get; F.set = opts.set; F.video = opts.video; F.host = opts.host; F.srcAspect = opts.srcAspect || 16 / 9;
    F.cv = el("canvas", { class: "frame-cv", hidden: true });
    F.host.prepend(F.cv);
    F.ov = el("canvas", { class: "frame-ov", hidden: true });
    F.host.append(F.ov);
    F.ov.addEventListener("pointerdown", down); F.ov.addEventListener("pointermove", move);
    F.ov.addEventListener("pointerup", up); F.ov.addEventListener("pointercancel", up);
    show();
    cancelAnimationFrame(F.raf); F.raf = requestAnimationFrame(loop);
  }
  /** The handles on the viewer work while the Frame panel is open. */
  function setEditing(on) { F.editing = !!on; if (!on) { F.drag = null; F.guides = []; } paintOverlay(); }
  return { init, active, aspect, renderPanel, show, full, draw, setEditing };
})();
