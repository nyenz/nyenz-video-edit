"use strict";
// The Editor: a video cut into pieces on a timeline, played live as you edit.
// Model: S.proj.pieces is the list the server renders. Pieces with off=true are not in the timeline
// (they are "removed" and can be put back). The timeline shows the other pieces, in order.
// Steps: S.proj.steps are pinned (locked) earlier steps; S.proj.pieces is the newest step, the one you edit.
// Every piece is a range of the PARENT video, so nothing is rendered between steps (see steps.js).

const S = {
  id: new URLSearchParams(location.search).get("p") || "",
  mode: location.pathname.startsWith("/final") ? "final" : "edit",      // /edit: the Edit stage (sections), /final: the Final stage (sound, picture)
  proj: null, info: null, files: [], recipes: [],
  sel: new Set(), anchor: null,             // selected piece objects
  undo: [], redo: [], saveTimer: null, saving: Promise.resolve(),
  pps: 40,                                   // timeline pixels per second of the finished video
  t: 0,                                      // playhead, seconds of the finished video
  playing: false, useLight: false, mutedAll: false,
  panel: "media",
  viewStep: null,                            // null: the newest step (editable); a number: an older, locked step shown
};
const MIN_PIECE = 0.1;
const LOOKS = [["hflip", "Flip", "fliph"], ["mirror", "Mirror", "mirror"], ["vflip", "Upside down", "flipv"], ["grayscale", "Black & white", "drop"],
  ["invert", "Invert", "palette"], ["sepia", "Sepia", "palette"], ["blur", "Blur", "drop"], ["sharpen", "Sharpen", "sparkles"], ["vignette", "Dark corners", "eye"]];
const LOOK_NAME = Object.fromEntries(LOOKS.map(([k, n]) => [k, n]));
const SHAPES = { original: null, vertical: 9 / 16, square: 1 };
const TEXT_SIZES = { small: 40, medium: 64, large: 96, huge: 140 };
const TEXT_COLORS = { white: "#ffffff", black: "#000000", yellow: "#ffe600", red: "#ff3030", blue: "#3090ff", green: "#30d060" };

// ================================================================== small model helpers
function blankPiece(start, end) {
  return { start: +start.toFixed(4), end: +end.toFixed(4), off: false, speed: 1, reverse: false, mute: false, volume: 1, fx: [],
    zoom: { mode: "none", amount: 1.3 }, color: { brightness: 0, contrast: 1, saturation: 1 }, follow: { mode: "none", zoom: 1.6, path: [] } };
}
function fixPiece(p) {
  if (!p.follow) p.follow = { mode: "none", zoom: 1.6, path: [] };
  if (!p.zoom) p.zoom = { mode: "none", amount: 1.3 };
  if (!p.color) p.color = { brightness: 0, contrast: 1, saturation: 1 };
  if (!p.fx) p.fx = [];
  return p;
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const outLen = (p) => (p.end - p.start) / p.speed;
/** The pieces on screen: the newest step, or an older step being looked at. */
function cur() { return S.viewStep === null ? S.proj.pieces : S.proj.steps[S.viewStep].pieces; }
function kept() { return cur().filter((p) => !p.off); }
function locked() { return S.viewStep !== null || !!S.waiting || trackLocked("video"); }
/** A locked track (like CapCut): its sections cannot be trimmed, moved, split, sped up or removed (video), or made louder,
 *  quieter or muted (sound). Positions on the picture can still be changed. */
const STEM_LOCKS = ["voices", "music", "effects", "found"];
function trackLocked(k) {
  const l = S.proj && S.proj.settings && S.proj.settings.locks;
  if (!l) return false;
  return !!l[k] || (STEM_LOCKS.includes(k) && !!l.sound);   // the sound lock covers the split tracks too
}
function toggleLock(k) {
  const l = Object.assign({ video: false, sound: false, voices: false, music: false, effects: false, found: false }, S.proj.settings.locks || {});
  if (STEM_LOCKS.includes(k) && l.sound) { toast("The whole sound is locked. Unlock it at the Sound track first.", true); return; }
  l[k] = !l[k]; S.proj.settings.locks = l; scheduleSave();
  const what = { video: "Video track ", sound: "Sound track ", voices: "Voices track ", music: "Music track ", effects: "Effects track ", found: "Found again track " }[k];
  toast(what + (l[k] ? "locked: it cannot be changed by mistake." : "unlocked."));
  refreshAll({ keepVideo: true });
}
function lockBtn(k) {
  const on = trackLocked(k);
  return el("button", { type: "button", class: "lock-btn" + (on ? " on" : ""), title: (on ? "Unlock the " : "Lock the ") + ({ video: "video", sound: "sound", voices: "voices", music: "music", effects: "effects", found: "found again" }[k]) + " track",
    "aria-pressed": String(on), onclick: (e) => { e.stopPropagation(); toggleLock(k); } }, icon(on ? "lock" : "unlock", "s"));
}
function markHand() { S.proj.rule = Object.assign({ interval: 0, group: 1, picks: [], action: "" }, S.proj.rule || {}, { hand: true }); }
/** The timeline: kept pieces with their place in the finished video. */
function layout() {
  let t = 0;
  return kept().map((p) => { const d = outLen(p); const r = { p, out0: t, out1: t + d }; t += d; return r; });
}
function rawTotal() { return kept().reduce((a, p) => a + outLen(p), 0); }
/** Length of the finished video, as the export will make it (transitions overlap neighbours a little). */
function finalTotal() {
  const L = layout(), st = S.proj.settings;
  let t = L.length ? L[L.length - 1].out1 : 0;
  if (st.transition !== "none") for (let i = 0; i + 1 < L.length; i++) {
    const d = Math.min(st.transition_s, (L[i].out1 - L[i].out0) / 2, (L[i + 1].out1 - L[i + 1].out0) / 2);
    if (d >= 0.08) t -= d;
  }
  return Math.max(0, t);
}
function segAt(t) {
  const L = layout();
  for (let i = 0; i < L.length; i++) if (t < L[i].out1 - 1e-6) return { i, s: L[i], L };
  return L.length ? { i: L.length - 1, s: L[L.length - 1], L, end: true } : null;
}
function selList() { return kept().filter((p) => S.sel.has(p)); }
// ---- scenes on the timeline: after Separate scenes, a click chooses a whole scene (all its sections)
function scenesOn() { return S.mode === "edit" && S.choose !== "sections" && sceneCount() > 0; }
function sceneOf(p) { return p.unit === undefined || p.unit === null ? [p] : kept().filter((q) => q.unit === p.unit); }
/** The scenes in the order they play: [{unit, pieces, out0, out1}]. */
function sceneList() {
  const out = [];
  for (const r of layout()) {
    const last = out[out.length - 1];
    if (last && last.unit === r.p.unit && r.p.unit !== undefined) { last.pieces.push(r.p); last.out1 = r.out1; }
    else out.push({ unit: r.p.unit, pieces: [r.p], out0: r.out0, out1: r.out1 });
  }
  return out;
}
/** Number the scenes 0, 1, 2 ... in the order they play. */
function renumberScenes() {
  const map = new Map(); let n = 0;
  for (const p of kept()) { if (p.unit === undefined || p.unit === null) continue; if (!map.has(p.unit)) map.set(p.unit, n++); p.unit = map.get(p.unit); }
}
function chosenScenes() { return new Set(selList().map((p) => p.unit).filter((u) => u !== undefined && u !== null)); }
/** Put the chosen scenes together into one scene, where the first of them is. */
function combineScenes() {
  if (locked()) { lockedNote(); return; }
  const units = chosenScenes();
  if (units.size < 2) { toast("Hold Ctrl and click two or more scenes first. Then Combine (Ctrl + J).", true); return; }
  let target = null;
  change(() => {
    const K = kept(), inIt = (p) => units.has(p.unit);
    target = K.find(inIt).unit;
    const moving = K.filter(inIt), rest = K.filter((p) => !inIt(p));
    const pos = K.slice(0, K.findIndex(inIt)).filter((p) => !inIt(p)).length;
    for (const p of moving) p.unit = target;
    S.proj.pieces = rest.slice(0, pos).concat(moving, rest.slice(pos)).concat(S.proj.pieces.filter((p) => p.off));
    renumberScenes(); S.sel = new Set(moving); S.anchor = moving[0]; markHand();
  });
  toast("Combined " + units.size + " scenes into one · " + sceneList().length + " scenes now. Ctrl + Z undoes it.");
}
function selectScene(p, e) {
  const runs = sceneList(), grp = sceneOf(p);
  if (e.shiftKey && S.anchor && kept().includes(S.anchor)) {
    const a = runs.findIndex((r) => r.pieces.includes(S.anchor)), b = runs.findIndex((r) => r.pieces.includes(p));
    if (!(e.ctrlKey || e.metaKey)) S.sel.clear();
    for (let k = Math.min(a, b); k <= Math.max(a, b); k++) for (const q of runs[k].pieces) S.sel.add(q);
  } else if (e.ctrlKey || e.metaKey) {
    const on = grp.every((q) => S.sel.has(q));
    for (const q of grp) { if (on) S.sel.delete(q); else S.sel.add(q); }
    S.anchor = p;
  } else if (!S.sel.has(p)) { S.sel = new Set(grp); S.anchor = p; }
}
function renderChoose() {
  const box = $("chooseSeg"), has = S.mode === "edit" && sceneCount() > 0;
  box.hidden = !has; $("bCombine").hidden = !has;
  if (!has) return;
  $("bCombine").disabled = chosenScenes().size < 2 || locked();
  const want = S.choose === "sections" ? "sections" : "scenes";
  if (box.dataset.v !== want) {
    box.dataset.v = want;
    box.replaceChildren(segmented([["scenes", "Scenes"], ["sections", "Sections"]], want, (v) => {
      S.choose = v; try { localStorage.setItem("ef.choose", v); } catch (er) { /* off */ }
      if (v === "scenes") for (const q of [...S.sel]) for (const x of sceneOf(q)) S.sel.add(x);
      refreshAll({ keepVideo: true });
    }));
  }
}

// ================================================================== saving and undo
function snapshot() { return JSON.stringify({ pieces: S.proj.pieces, settings: S.proj.settings, name: S.proj.name, texts: S.proj.texts, steps: S.proj.steps, rule: S.proj.rule }); }
function remember() { S.undo.push(snapshot()); if (S.undo.length > 80) S.undo.shift(); S.redo = []; }
function restore(json) {
  const d = JSON.parse(json);
  const keepSel = selList().map((p) => S.proj.pieces.indexOf(p));
  Object.assign(S.proj, d); S.proj.pieces.forEach(fixPiece);
  if (S.viewStep !== null && S.viewStep >= S.proj.steps.length) S.viewStep = null;
  S.sel = new Set(keepSel.map((i) => S.proj.pieces[i]).filter((p) => p && !p.off));
  refreshAll(); scheduleSave();
}
function undo() { if (S.waiting) { lockedNote(); return; } if (!S.undo.length) return; S.redo.push(snapshot()); restore(S.undo.pop()); }
function redo() { if (S.waiting) { lockedNote(); return; } if (!S.redo.length) return; S.undo.push(snapshot()); restore(S.redo.pop()); }
function scheduleSave() { $("saveState").textContent = "Saving…"; clearTimeout(S.saveTimer); S.saveTimer = setTimeout(saveNow, 500); }
function saveNow() {
  clearTimeout(S.saveTimer); S.saveTimer = null;
  const body = { name: S.proj.name, pieces: S.proj.pieces, settings: S.proj.settings, texts: S.proj.texts, steps: S.proj.steps, rule: S.proj.rule };
  S.saving = S.saving.then(() => api("/api/projects/" + S.id, { method: "PUT", json: body }))
    .then(() => { if (!S.saveTimer) $("saveState").textContent = "Saved"; })
    .catch((e) => { $("saveState").textContent = "Not saved"; toast("Not saved: " + errText(e), true); });
  return S.saving;
}
/** Change the project: remember for Undo, apply, redraw, save. */
function change(fn, opts) {
  if (opts && opts.sound && trackLocked("sound")) { lockedNote("sound"); return false; }
  if (locked() && !(opts && (opts.any || opts.keepVideo || (opts.sound && S.viewStep === null && !S.waiting)))) { lockedNote(); return false; }      // settings, words and music stay editable
  remember(); fn(); refreshAll(opts); scheduleSave();
  return true;
}
function lockedNote(kind) {
  if (kind === "sound") { toast("The sound track is locked. Click its lock to change loudness or mute.", true); return; }
  if (S.viewStep === null && !S.waiting && trackLocked("video")) { toast("The video track is locked. Click its lock (next to Video) to change sections.", true); return; }
  if (S.waiting) { toast("The scenes are being separated, so the timeline waits until they are in. You can open other projects meanwhile.", true); return; }
  toast("This is an older step, so it is locked. Click the newest step (in Steps) to change things.", true);
}
function refreshAll(opts) {
  S.sel = new Set([...S.sel].filter((p) => !p.off && cur().includes(p)));
  renderTimeline(); renderInspector(); renderLengths(); renderSteps(); renderStepbar(); if (S.mode === "edit") renderChoose();
  if (S.check) renderCheck();
  if (S.mode === "final" && Frame.editing) { const sig = selList().length + ":" + placeScopeKey(); if (sig !== S.panelSig) { S.panelSig = sig; Frame.renderPanel(); } }
  if (!(opts && opts.keepVideo)) showFrame();
}

// ================================================================== lengths shown everywhere
function renderLengths() {
  const total = finalTotal(), sel = selList();
  $("iLen").textContent = fmtTime(total);
  $("tTotal").textContent = fmtTime(total);
  $("topLen").textContent = fmtTime(total);
  const scn = scenesOn();
  $("iCount").textContent = String(scn ? sceneList().length : kept().length);
  $("iCount").nextSibling.textContent = scn ? " scenes" : " pieces";
  const sl = sel.reduce((a, p) => a + outLen(p), 0), ns = scn ? chosenScenes().size : 0;
  $("iSel").textContent = sel.length ? (scn ? ns + " scene" + (ns > 1 ? "s" : "") : sel.length) + " selected · " + fmtTime(sl) : "";
  if (S.mode === "edit") $("bCombine").disabled = ns < 2 || locked();
  $("bUndo").disabled = !S.undo.length; $("bRedo").disabled = !S.redo.length;
  $("bDel").disabled = $("bDup").disabled = !sel.length;
}

// ================================================================== live viewer (plays the edit without making a video)
const V = { a: $("vA"), b: $("vB"), seg: null, raf: 0, src: "" };
function active() { return V.a.classList.contains("back") ? V.b : V.a; }
function other() { return active() === V.a ? V.b : V.a; }
function setSource(url) {
  if (V.src === url) return;
  V.src = url;
  for (const v of [V.a, V.b]) { v.src = url; v.load(); }
}
// If this browser cannot play the light copy, fall back to the original file when that plays here.
function onVideoError() {
  if (!S.proj || !V.src.includes("preview=1")) return;
  if (S.info.plays_in_browser) { V.src = ""; setSource(mediaUrl(S.proj.source, false)); V.a.addEventListener("loadeddata", () => showFrame(), { once: true }); }
  else banner("This browser cannot play this video here. The export still works. Try Microsoft Edge or Chrome for the live view.", 0);
}
V.a.addEventListener("error", onVideoError); V.b.addEventListener("error", onVideoError);
function frameAspect() {
  if (Frame.active(S.proj.settings.frame)) return Frame.aspect(S.proj.settings.frame);
  const sh = S.proj.settings.shape || "original";
  const base = sh.split("_")[0];
  return SHAPES[base] || (S.info.width && S.info.height ? S.info.width / S.info.height : 16 / 9);
}
function sizeFrame() {
  const st = $("stage"), f = $("frame");
  const W = st.clientWidth - 36, H = st.clientHeight - 20, a = frameAspect();
  let w = W, h = W / a;
  if (h > H) { h = H; w = H * a; }
  f.style.width = Math.max(40, Math.floor(w)) + "px"; f.style.height = Math.max(40, Math.floor(h)) + "px";
  const sh = S.proj.settings.shape || "original";
  const fit = sh === "original" || sh.endsWith("_blur") ? "contain" : "cover";
  for (const v of [V.a, V.b]) v.style.objectFit = fit;
  const fr = Frame.active(S.proj.settings.frame) ? Frame.full(S.proj.settings.frame) : null;
  if (fr) { $("shapeTag").textContent = "Frame " + (fr.ratio === "original" ? "original shape" : fr.ratio) + (fr.mask.shape !== "none" ? " · mask" : ""); renderOverlay(); Frame.show(); return; }
  Frame.show();
  $("shapeTag").textContent = { original: "Original shape", vertical: "Tall 9:16", vertical_follow: "Tall 9:16 · follows faces", vertical_blur: "Tall 9:16 · blurred edges", square: "Square", square_follow: "Square · follows faces", square_blur: "Square · blurred edges" }[sh] || "";
  renderOverlay();
}
/** Show a piece's look on a video element with CSS (the export draws it properly). */
function dress(v, p) {
  if (!p) { v.style.transform = ""; v.style.filter = ""; return; }
  const sx = p.fx.includes("hflip") ? -1 : 1, sy = p.fx.includes("vflip") ? -1 : 1;
  let z = 1;
  if (p.follow.mode !== "none") z = p.follow.zoom; else if (p.zoom.mode === "hold") z = p.zoom.amount; else if (p.zoom.mode !== "none") z = 1 + (p.zoom.amount - 1) / 2;
  v.style.transform = "scale(" + sx * z + "," + sy * z + ")";
  const f = [];
  if (p.fx.includes("grayscale")) f.push("grayscale(1)");
  if (p.fx.includes("invert")) f.push("invert(1)");
  if (p.fx.includes("sepia")) f.push("sepia(.9)");
  if (p.fx.includes("blur")) f.push("blur(4px)");
  if (p.fx.includes("sharpen")) f.push("contrast(1.08)");
  if (p.color.brightness) f.push("brightness(" + (1 + p.color.brightness) + ")");
  if (p.color.contrast !== 1) f.push("contrast(" + p.color.contrast + ")");
  if (p.color.saturation !== 1) f.push("saturate(" + p.color.saturation + ")");
  v.style.filter = f.join(" ");
  v.muted = S.mutedAll || p.mute || !ownSoundOn() || Layers.on();     // with the three layers on, they carry the sound
  v.volume = clamp(p.volume, 0, 1);
  v.playbackRate = clamp(p.speed, 0.0625, 16);
}
function badge(p) {
  const b = $("badge"), bits = [];
  if (p && p.reverse) bits.push("Plays backwards in the export");
  if (p && p.fx.includes("mirror")) bits.push("Mirror shows in the export");
  if (p && p.follow.mode === "face") bits.push("Follows the face in the export");
  b.hidden = !bits.length; b.replaceChildren(icon("info", "s"), el("span", { text: bits.join(" · ") }));
}
/** Put the paused picture at the playhead. */
function showFrame() {
  if (!S.proj) return;
  const at = segAt(S.t);
  if (!at) { V.a.removeAttribute("src"); return; }
  const { s } = at, v = active();
  V.seg = s;
  dress(v, s.p); badge(s.p);
  const want = s.p.start + Math.max(0, S.t - s.out0) * s.p.speed;
  if (Math.abs(v.currentTime - want) > 0.03) v.currentTime = clamp(want, 0, S.info.duration - 0.01);
  renderPlayhead(); renderOverlay();
}
function prepNext(after) {
  const L = layout(), i = L.indexOf(after);
  const nx = L[i + 1], o = other();
  if (!nx) return;
  dress(o, nx.p);
  o.dataset.forStart = String(nx.p.start);
  if (Math.abs(o.currentTime - nx.p.start) > 0.05) o.currentTime = nx.p.start;
}
function play() {
  if (!S.proj || !kept().length) return;
  if (S.t >= rawTotal() - 0.02) S.t = 0;
  S.playing = true; setPlayIcon();
  const at = segAt(S.t); V.seg = at.s;
  const v = active(); dress(v, at.s.p); badge(at.s.p);
  v.currentTime = at.s.p.start + (S.t - at.s.out0) * at.s.p.speed;
  const pr = v.play(); if (pr && pr.catch) pr.catch(() => {});
  prepNext(at.s); musicPlay(); Layers.play();
  cancelAnimationFrame(V.raf); V.raf = requestAnimationFrame(tick);
}
function pause() {
  S.playing = false; setPlayIcon();
  V.a.pause(); V.b.pause(); musicPause(); Layers.pause();
  cancelAnimationFrame(V.raf);
}
function togglePlay() { if (S.playing) pause(); else play(); }
function setPlayIcon() { $("tPlay").replaceChildren(icon(S.playing ? "pause" : "play")); }
function tick() {
  if (!S.playing) return;
  const v = active(), s = V.seg;
  if (!s || !S.proj.pieces.includes(s.p) || s.p.off) { const at = segAt(S.t); if (!at) { pause(); return; } V.seg = at.s; }
  const cur = V.seg;
  S.t = cur.out0 + Math.max(0, v.currentTime - cur.p.start) / cur.p.speed;
  if (v.currentTime >= cur.p.end - 0.02 || v.ended) {
    const L = layout(), i = L.findIndex((r) => r.p === cur.p), nx = L[i + 1];
    if (!nx) { S.t = L.length ? L[L.length - 1].out1 : 0; pause(); renderPlayhead(); return; }
    V.seg = nx; S.t = nx.out0;
    const o = other();
    if (Math.abs(nx.p.start - cur.p.end) < 0.06 && nx.p.speed === cur.p.speed) { dress(v, nx.p); }              // continuous footage: keep playing
    else if (Math.abs(o.currentTime - nx.p.start) < 0.08 && o.readyState >= 2) {                                // the other player is waiting at the right spot
      v.pause(); o.classList.remove("back"); v.classList.add("back"); dress(o, nx.p);
      const pr = o.play(); if (pr && pr.catch) pr.catch(() => {});
    } else { dress(v, nx.p); v.currentTime = nx.p.start; }
    badge(nx.p); prepNext(nx);
  }
  Layers.follow(active(), V.seg.p); musicGains(); paintMeter();
  if (!Layers.on() && V.seg.p) { const vv = active(), pp = V.seg.p; vv.volume = clamp(pp.volume * partShapeGain(pp, "original", vv.currentTime), 0, 1); }
  renderPlayhead(); renderOverlay();
  if (S.followPlay) scrollToPlayhead();
  V.raf = requestAnimationFrame(tick);
}
function seek(t) {
  S.t = clamp(t, 0, Math.max(0, rawTotal() - 0.001));
  if (S.playing) { pause(); play(); } else showFrame();
  musicSync();
}
// music in the viewer: one player for every music layer that is heard (muted layers, and everything but soloed ones, are not)
const MUSIC = new Map();
function layers() { return S.proj.settings.layers || []; }
function soloOn() { return layers().some((x) => x.solo); }
function heard(x) { return !x.mute && (!soloOn() || x.solo); }
function ownSoundOn() { return S.proj.settings.original_sound && !soloOn(); }
let MCTX = null;
function musicPlayer(file) {
  let a = MUSIC.get(file);
  if (!a) {
    a = new Audio(mediaUrl(file, false)); a.preload = "auto"; MUSIC.set(file, a);
    try {                                          // through Web Audio, so the viewer can play it louder than 100 %
      const C = window.AudioContext || window.webkitAudioContext;
      if (C) { MCTX = MCTX || new C(); const g = MCTX.createGain(); MCTX.createMediaElementSource(a).connect(g); g.connect(MCTX.destination); a._gain = g; }
    } catch (e) { a._gain = null; }
  }
  return a;
}
function setMusicGain(m, v) { if (m._gain) { if (m.volume !== 1) m.volume = 1; m._gain.gain.value = Math.max(0, v); } else m.volume = clamp(v, 0, 1); }
/** How loud a music track is right now: the track, the part under the playhead, and going down under voices. */
function musicLevel(x, t) { return Math.max(0, x.volume) * partGain(x, t) * duckGain(x, t) * musicShapeGain(x, t); }
function musicGains() { for (const x of layers()) if (heard(x)) setMusicGain(musicPlayer(x.file), musicLevel(x, S.t)); }
function musicPlay() {
  const on = new Set();
  if (MCTX && MCTX.state === "suspended") MCTX.resume();
  for (const x of layers()) {
    if (!heard(x)) continue;
    const m = musicPlayer(x.file); on.add(x.file);
    setMusicGain(m, musicLevel(x, S.t)); m.muted = S.mutedAll;
    if (m.duration) m.currentTime = (S.t + (+x.start || 0)) % m.duration;
    const pr = m.play(); if (pr && pr.catch) pr.catch(() => {});
  }
  for (const [f, m] of MUSIC) if (!on.has(f)) m.pause();
}
function musicPause() { for (const m of MUSIC.values()) m.pause(); }
function musicMute() { for (const m of MUSIC.values()) m.muted = S.mutedAll; }
function musicSync() { for (const m of MUSIC.values()) if (m.duration) m.currentTime = S.t % m.duration; }
// words on the picture, drawn over the viewer
function renderOverlay() {
  const box = $("over"); box.replaceChildren();
  const H = $("frame").clientHeight;
  for (const t of S.proj.texts || []) {
    const end = t.end > 0 ? t.end : 1e9;
    if (S.t < t.start || S.t >= end) continue;
    const d = el("div", { class: "wtext", text: t.text });
    d.style.fontSize = Math.max(8, TEXT_SIZES[t.size] * H / 1080) + "px";
    d.style.color = TEXT_COLORS[t.color] || "#fff";
    if (t.box) d.style.background = "rgba(0,0,0,.5)"; else d.style.textShadow = "0 0 3px #000, 0 0 2px #000";
    const pos = t.position || "bottom";
    if (pos.startsWith("top")) d.style.top = "5%"; else if (pos === "center") { d.style.top = "50%"; d.style.transform = "translate(-50%,-50%)"; } else d.style.bottom = "6%";
    if (pos.endsWith("left")) { d.style.left = "4%"; d.style.transform = "none"; }
    if (pos.endsWith("right")) { d.style.left = "auto"; d.style.right = "4%"; d.style.transform = "none"; }
    box.append(d);
  }
}

// ================================================================== timeline
const T = { thumbW: 100, h: 64, drag: null };
const X0 = () => (S.mode === "final" ? 152 : 16);           // Final shows track names at the left of the timeline
function px(t) { return Math.round(t * S.pps) + X0(); }
function timeAt(x) { return (x - X0()) / S.pps; }
/** Follow: while playing, keep the red line in view. When it reaches the right edge the timeline turns a page
 *  (like CapCut), so the line starts again near the left. Off: the timeline stays where you put it. */
S.follow = (() => { try { return localStorage.getItem("ef.follow") !== "0"; } catch (e) { return true; } })();
function paintFollow() { const b = $("bFollow"); if (!b) return; b.classList.toggle("on", S.follow); b.setAttribute("aria-pressed", String(S.follow)); }
function followPlayhead() {
  if (!S.follow || !S.playing || S.dragging) return;
  const sc = $("tlScroll"), x = px(S.t), w = sc.clientWidth;
  const head = (document.querySelector("#tlScroll .lane-head") || { offsetWidth: 0 }).offsetWidth;
  if (x > sc.scrollLeft + w - 40 || x < sc.scrollLeft + head) sc.scrollLeft = Math.max(0, x - head - w * 0.12);
}
function renderPlayhead() {
  if (!S.playing) paintMeter();
  $("playhead").style.left = px(S.t) + "px";
  followPlayhead();
  $("tNow").textContent = fmtTime(S.t);
  if (S.mode === "final") {                           // a section with its own position: draw it as it will be
    const at = segAt(S.t), p = at ? at.s.p : null;
    if (p !== S.placeP) { S.placeP = p; try { Frame.refresh(); if (Frame.editing) Frame.renderPanel(); } catch (e) { /* not ready */ } }
  }
}
// ---- the position of the video layer: for the whole video, or a section's own (Final, Picture)
const PLACE_KEYS = ["x", "y", "scale", "rotate"];
/** What moving the picture changes (like CapCut): the chosen sections; with none chosen, the section showing. */
function placeTargets() {
  const sel = selList();
  if (sel.length) return sel;
  const at = segAt(S.t);
  return at ? [at.s.p] : [];
}
/** The frame the viewer draws: the shape and background of the whole video, with the position of the section showing. */
function effectiveFrame() {
  const base = S.proj.settings.frame, at = segAt(S.t), p = at ? at.s.p : null;
  if (p && p.place) return Object.assign(Frame.full(base), p.place);
  return base;
}
function storeFrame(fr, live, force) {
  const t = placeTargets(), base = Frame.full(S.proj.settings.frame);
  const prev = S.dragFrom || Frame.full(effectiveFrame());
  if (live && !S.dragFrom) S.dragFrom = prev;                  // a drag: compare with where it started
  if (!live) S.dragFrom = null;
  const shape = fr.ratio !== base.ratio;                       // a new shape: it sets the starting size for every section
  const changed = PLACE_KEYS.filter((k) => (force && force.includes(k)) || Math.abs((fr[k] || 0) - (prev[k] || 0)) > 1e-6);
  const apply = () => {
    const nb = Object.assign({}, fr);
    if (shape) { S.proj.settings.frame = nb; return; }
    // only what was changed is written: sections chosen together keep their own other values
    for (const p of t) {
      const own = Object.assign({}, PLACE_KEYS.reduce((o, k) => (o[k] = base[k], o), {}), p.place || {});
      for (const k of changed) own[k] = fr[k];
      if (changed.length || p.place) p.place = own;
    }
    for (const k of PLACE_KEYS) nb[k] = base[k];
    S.proj.settings.frame = nb;
  };
  if (live) { apply(); sizeFrame(); return; }
  change(apply, { keepVideo: true }); sizeFrame();
}
function placeScopeKey() { const m = placeScopeInfo().mixed; return PLACE_KEYS.map((k) => (m[k] ? 1 : 0)).join(""); }
function placeScopeInfo() {
  const t = placeTargets(), base = Frame.full(S.proj.settings.frame);
  const val = (p, k) => (p.place ? p.place[k] : base[k]);
  const mixed = {};
  for (const k of PLACE_KEYS) mixed[k] = t.length > 1 && t.some((p) => Math.abs(val(p, k) - val(t[0], k)) > 1e-6);   // different: the box stays empty
  return { n: t.length, chosen: selList().length, mixed };
}
/** Reset position: back to the middle, not turned (the size stays). */
function resetPlace() {
  const t = placeTargets(); if (!t.length) return;
  const base = Frame.full(S.proj.settings.frame);
  change(() => { for (const p of t) p.place = { x: 0, y: 0, scale: (p.place || base).scale, rotate: 0 }; }, { keepVideo: true });
  Frame.refresh(); Frame.renderPanel();
  toast("Position reset for " + (t.length === 1 ? "this section" : t.length + " sections") + ": in the middle, not turned.");
}
function scrollToPlayhead() {
  const sc = $("tlScroll"), x = px(S.t);
  if (x < sc.scrollLeft + 40 || x > sc.scrollLeft + sc.clientWidth - 40) sc.scrollLeft = x - sc.clientWidth * 0.3;
}
function setZoomFromSlider() {
  // slider 0..100 maps to 2 .. 400 pixels per second on a log scale
  const v = parseFloat($("zoom").value);
  S.pps = 2 * Math.pow(200, v / 100);
}
function sliderFromZoom() { $("zoom").value = String(clamp(Math.log(S.pps / 2) / Math.log(200) * 100, 0, 100)); paintRange($("zoom")); }
function zoomTo(pps, anchorT) {
  const sc = $("tlScroll"), t = anchorT === undefined ? S.t : anchorT, before = px(t) - sc.scrollLeft;
  S.pps = clamp(pps, 2, 400); sliderFromZoom(); renderTimeline();
  sc.scrollLeft = px(t) - before;
}
function fitZoom() { const w = $("tlScroll").clientWidth - X0() - 32; S.pps = clamp(w / Math.max(1, rawTotal()), 2, 400); sliderFromZoom(); renderTimeline(); $("tlScroll").scrollLeft = 0; }
function renderRuler(total) {
  const r = $("ruler"); r.replaceChildren();
  if (S.mode === "final") r.append(el("div", { class: "ruler-corner" }));
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const major = steps.find((s) => s * S.pps >= 90) || 3600;
  const minor = steps.slice().reverse().find((s) => s < major && s * S.pps >= 12 && (major / s) % 1 === 0) || major;
  const sc = $("tlScroll"), a = Math.max(0, timeAt(sc.scrollLeft) - major), b = Math.min(total + major * 2, timeAt(sc.scrollLeft + sc.clientWidth) + major);
  for (let t = Math.floor(a / minor) * minor; t <= b; t += minor) {
    const isMaj = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    const tick = el("i", { class: isMaj ? "maj" : "" }); tick.style.left = px(t) + "px"; r.append(tick);
    if (isMaj) { const lab = el("span", { text: fmtTime(t, major < 1 ? 1 : 0) }); lab.style.left = px(t) + "px"; r.append(lab); }
  }
}
function tagsOf(p) {
  const t = [];
  if (p.speed !== 1) t.push(p.speed + "×");
  if (p.reverse) t.push("backwards");
  for (const f of p.fx) t.push(LOOK_NAME[f] || f);
  if (p.follow.mode !== "none") t.push("follow");
  else if (p.zoom.mode !== "none") t.push("zoom");
  if (p.mute) t.push("muted");
  return t.join(" · ");
}
function renderTimeline() {
  const L = layout(), total = L.length ? L[L.length - 1].out1 : 0;
  const inner = $("tlInner"), sc = $("tlScroll");
  inner.style.width = Math.max(sc.clientWidth, px(total) + 400) + "px";
  renderRuler(total);
  const lane = $("laneV"); lane.replaceChildren();
  const left = sc.scrollLeft - 300, right = sc.scrollLeft + sc.clientWidth + 300;
  const ar = S.info.width && S.info.height ? S.info.width / S.info.height : 16 / 9;
  T.thumbW = Math.round(T.h * ar);
  const scn = S.mode === "edit" && sceneCount() > 0, sceneAt = new Map(), firstOf = new Set();
  if (scn) sceneList().forEach((sc, k) => { firstOf.add(sc.pieces[0]); for (const q of sc.pieces) sceneAt.set(q, k); });
  for (const r of L) {
    const x0 = px(r.out0), x1 = px(r.out1);
    if (x1 < left || x0 > right) continue;                    // only what is on screen is drawn, so 5,000 pieces stay quick
    const w = Math.max(4, x1 - x0 - 2);
    const p = r.p;
    const k = sceneAt.get(p);
    const b = el("div", { class: "clipb" + (S.sel.has(p) ? " sel" : "") + (w < 70 ? " narrow" : "") + (locked() ? " locked" : "") +
      (scn ? " sc" + (k % 2) + (firstOf.has(p) ? " sc-first" : "") : ""), "data-k": String(cur().indexOf(p)) });
    if (scn && firstOf.has(p)) b.append(el("span", { class: "scene-tag", text: "Scene " + (k + 1) }));
    b.style.left = x0 + "px"; b.style.width = w + "px";
    if (S.info.has_video) {
      const strip = el("div", { class: "strip" });
      const n = Math.max(1, Math.min(12, Math.ceil(w / T.thumbW)));
      for (let k = 0; k < n; k++) {
        const ot = (k * T.thumbW + T.thumbW / 2) / S.pps;
        const st = clamp(p.reverse ? p.end - ot * p.speed : p.start + ot * p.speed, p.start, p.end - 0.04);
        const img = lazyThumb(thumbUrl(S.proj.source, Math.min(Math.round(st), Math.floor(S.info.duration - 0.05))));
        img.style.width = T.thumbW + "px";
        if (p.fx.includes("hflip")) img.style.transform = "scaleX(-1)";
        if (p.fx.includes("grayscale")) img.style.filter = "grayscale(1)";
        strip.append(img);
      }
      b.append(strip);
    }
    b.append(el("div", { class: "meta" }, el("span", { class: "num", text: fmtTime(r.out1 - r.out0) }), el("span", { class: "tags", text: tagsOf(p) })));
    b.append(el("div", { class: "h l", "data-edge": "l", title: "Drag to change where this piece starts" }), el("div", { class: "h r", "data-edge": "r", title: "Drag to make this piece longer or shorter" }));
    lane.append(b);
  }
  const head = (ic, name, ...extra) => el("div", { class: "lane-head" }, icon(ic, "s"), el("span", { class: "ellip", text: name }), ...extra);
  if (S.mode === "final") lane.prepend(head("film", "Video", lockBtn("video")));
  lane.classList.toggle("track-locked", trackLocked("video"));
  for (const k of ["video", "sound"]) { const b = $(k === "video" ? "lockV" : "lockA"); if (b) { b.classList.toggle("on", trackLocked(k)); b.replaceChildren(icon(trackLocked(k) ? "lock" : "unlock", "s"), el("span", { text: k === "video" ? "Video" : "Sound" })); } }
  // words lane
  const lt = $("laneT"); lt.replaceChildren(); lt.hidden = !(S.proj.texts || []).length;
  if (S.mode === "final" && !lt.hidden) lt.append(head("type", "Words"));
  (S.proj.texts || []).forEach((t, i) => {
    const end = t.end > 0 ? t.end : total;
    const d = el("div", { class: "lane-item text", "data-i": String(i), title: t.text + " · right-click for more", onclick: () => { openPanel("text"); } }, icon("type", "s"), el("span", { text: t.text }));
    d.style.left = px(t.start) + "px"; d.style.width = Math.max(20, px(end) - px(t.start) - 2) + "px"; lt.append(d);
  });
  // music: one row per layer, with its own mute, solo and lock at the left; its parts (cut like the video) on the right
  const lm = $("laneM"); lm.replaceChildren(); lm.hidden = !layers().length;
  S.duckBy = {};
  for (const of of duckNeeds()) { if ((S.acts || {})[of] && S.acts[of].key === (S.proj.settings.mix_split || "-")) S.duckBy[of] = voiceOut(of); else loadVoices(false, of); }
  S.duckSpans = S.duckBy.voices || [];
  if (S.msel && !layers()[S.msel.i]) S.msel = null;
  layers().forEach((x, i) => {
    const name = (S.files.find((f) => f.id === x.file) || { name: x.file.split("/").pop() }).name;
    const flip = (k) => (e) => { e.stopPropagation(); change(() => { S.proj.settings.layers = layers().map((y, j) => (j === i ? Object.assign({}, y, { [k]: !y[k] }) : y)); }, { keepVideo: true }); renderMusicLayers(); if (S.playing) musicPlay(); };
    const row = el("div", { class: "mrow" + (x.locked || trackLocked("sound") ? " track-locked" : ""), "data-i": String(i), title: "Right-click for more" });
    if (S.mode === "final") row.append(head("music", name,
      el("button", { type: "button", class: "lh-btn" + (x.mute ? " on" : ""), title: "Mute", "aria-label": "Mute " + name, onclick: flip("mute") }, icon(x.mute ? "mute" : "vol", "s")),
      el("button", { type: "button", class: "lh-btn solo" + (x.solo ? " on" : ""), title: "Solo", "aria-label": "Solo " + name, onclick: flip("solo"), text: "S" }),
      el("button", { type: "button", class: "lock-btn" + (x.locked ? " on" : ""), title: x.locked ? "Unlock this music" : "Lock this music", "aria-pressed": String(!!x.locked), onclick: flip("locked") }, icon(x.locked ? "lock" : "unlock", "s"))));
    for (const r of mspans(x)) {
      const chosen = S.msel && S.msel.i === i && S.msel.ks.has(r.k);
      const g = r.q.mute ? 0 : x.volume * r.q.volume;
      const d = el("div", { class: "lane-item music mpart" + (heard(x) ? "" : " off") + (r.q.mute ? " muted" : "") + (chosen ? " sel" : ""), "data-k": String(r.k), ondblclick: () => openPanel("sound") },
        icon(r.q.mute ? "mute" : "music", "s"), el("span", { text: (r.k === 0 || chosen ? name + " · " : "") + (r.q.mute ? "muted" : Math.round(g * 100) + "%") +
          ((r.q.even === undefined ? x.auto : r.q.even) ? " · " + ((r.q.even === undefined ? x.auto : r.q.even) === 2 ? "evened strong" : "evened") : "") + (r.q.fin || r.q.fout ? " · fades" : "") }));
      d.style.left = px(r.a) + "px"; d.style.width = Math.max(6, px(r.b) - px(r.a) - 2) + "px"; row.append(d);
    }
    if (x.duck && x.duck.on) for (const [a, b] of S.duckBy[x.duck.under || "voices"] || []) {
      const z = el("i", { class: "duckz" }); z.style.left = px(a) + "px"; z.style.width = Math.max(2, px(b) - px(a)) + "px"; row.append(z);
    }
    lm.append(row);
  });
  renderAudioLane();
  renderStemLanes();
  renderLoudLane();
  if (S.mode === "final") prefetchEnvs();
  if (S.mode === "final" && !S.playing) paintMeter();
  renderPlayhead();
}

// ---- the sound of the video, drawn under each section (moves, speeds, mutes and turns around with it)
async function loadPeaks() {
  if (!S.info.has_audio) return;
  for (let tries = 0; tries < 200; tries++) {
    const r = await fetch("/api/peaks?id=" + encodeURIComponent(S.proj.source), { headers: { "X-EditForge-Token": TOKEN } }).catch(() => null);
    if (!r) return;
    if (r.status === 200) {
      S.peaks = new Uint8Array(await r.arrayBuffer());
      S.peakRate = +(r.headers.get("X-Peak-Rate") || 50);
      renderAudioLane();
      return;
    }
    if (r.status !== 202) return;
    await new Promise((ok) => setTimeout(ok, 1500));
  }
}
function renderAudioLane() {
  const la = $("laneA");
  if (!S.info.has_audio || stemsOn()) { la.hidden = true; return; }       // with a split, the three tracks show instead
  la.hidden = false;
  let cv = la.querySelector("canvas");
  if (!cv) {
    cv = el("canvas", { class: "wave" });
    la.replaceChildren(cv);
  }
  la.classList.toggle("track-locked", trackLocked("sound"));
  if (S.mode === "final") { const old = la.querySelector(".lane-head"); if (old) old.remove(); la.prepend(el("div", { class: "lane-head" }, icon("vol", "s"), el("span", { class: "ellip", text: "Sound" }), lockBtn("sound"))); }
  const sc = $("tlScroll"), left = sc.scrollLeft, w = sc.clientWidth, H = 40, dpr = Math.min(2, window.devicePixelRatio || 1);
  if (cv.width !== Math.round(w * dpr) || cv.height !== H * dpr) { cv.width = Math.round(w * dpr); cv.height = H * dpr; }
  cv.style.left = left + "px"; cv.style.width = w + "px"; cv.style.height = H + "px";
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, H);
  const P = S.peaks, R = S.peakRate || 50, mid = H / 2;
  const accent = "#3ec7a0";
  for (const r of layout()) {
    const x0 = px(r.out0), x1 = px(r.out1);
    if (x1 < left || x0 > left + w) continue;
    const p = r.p, a = Math.max(x0, left), b = Math.min(x1, left + w);
    g.fillStyle = "rgba(62, 199, 160, .08)"; g.fillRect(x0 - left + 1, 2, Math.max(1, x1 - x0 - 2), H - 4);
    if (!P) continue;
    const quiet = p.mute ? 0 : Math.min(2, p.volume === undefined ? 1 : p.volume);
    g.fillStyle = p.mute ? "rgba(160,160,170,.45)" : accent;
    for (let x = Math.floor(a); x < b; x++) {
      const t0 = timeAt(x) - r.out0, t1 = timeAt(x + 1) - r.out0;           // time in this section's output
      let s0 = p.start + t0 * p.speed, s1 = p.start + t1 * p.speed;
      if (p.reverse) { s0 = p.end - t1 * p.speed; s1 = p.end - t0 * p.speed; }
      let i0 = Math.max(0, Math.floor(s0 * R)), i1 = Math.min(P.length, Math.max(i0 + 1, Math.ceil(s1 * R)));
      let m = 0; for (let i = i0; i < i1; i++) if (P[i] > m) m = P[i];
      const hgt = p.mute ? 1 : Math.max(1, (m / 255) * quiet * (H / 2 - 3));
      g.fillRect(x - left, mid - hgt, 1, hgt * 2);
    }
  }
  if (!P) { g.fillStyle = "rgba(255,255,255,.4)"; g.font = "500 11px system-ui, sans-serif"; g.fillText("Reading the sound…", Math.max(8, X0() - left + 8), mid + 4); }
}

// ---- Even out and gentle fades, for every kind of sound part (the video's own sound, the split tracks, music).
// Even out: loud moments a little down, quiet moments a little up, slowly, so nothing distorts; parts that are fine stay
// as they are. The app listens to the sound once (on the PC) and keeps the result; the viewer and the export use the same.
S.envs = new Map();
function envPoints(q, s) {
  const key = (q.file || q.split + "|" + q.layer) + "|" + s, v = S.envs.get(key);
  if (v && v !== "loading") return v;
  if (!v) {
    S.envs.set(key, "loading");
    const qs = q.file ? "file=" + encodeURIComponent(q.file) : "split=" + encodeURIComponent(q.split) + "&layer=" + q.layer;
    api("/api/envelope?" + qs + "&s=" + s).then((r) => { S.envs.set(key, r.points || []); renderTimeline(); }).catch(() => S.envs.delete(key));
  }
  return null;
}
function envDb(pts, t) {
  if (!pts || pts.length < 2 || t <= pts[0][0] || t >= pts[pts.length - 1][0]) return 0;
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m][0] <= t) lo = m; else hi = m; }
  const [t0, g0] = pts[lo], [t1, g1] = pts[hi];
  return g0 + (g1 - g0) * (t - t0) / Math.max(1e-9, t1 - t0);
}
const dbGain = (db) => Math.pow(10, db / 20);
/** Ask for the curves that Even out needs now, so the viewer has them before you press play. */
function prefetchEnvs() {
  const sp = typeof Layers !== "undefined" && Layers.split();
  for (const p of kept()) {
    if (p.even && !stemsOn()) envPoints({ file: S.proj.source }, p.even);
    if (sp && p.mix) for (const [n, v] of Object.entries(p.mix)) if (v && v.even) envPoints({ split: sp.id, layer: n }, v.even);
  }
  for (const x of layers()) for (const r of mspans(x)) { const e = r.q.even === undefined ? x.auto || 0 : r.q.even; if (e) envPoints({ file: x.file }, e); }
}
/** Fade in / out of a part at time t (a..b is the part; for sections played backwards the start is b). */
function fadeGain(sh, a, b, t, rev) {
  let g = 1;
  const fin = +sh.fin || 0, fout = +sh.fout || 0;
  const s0 = rev ? b - t : t - a, s1 = rev ? t - a : b - t;
  if (fin > 0) g *= clamp(s0 / fin, 0, 1);
  if (fout > 0) g *= clamp(s1 / fout, 0, 1);
  return g;
}
/** The live gain of a section's own sound ("original") or of one split layer, at source time t. */
function partShapeGain(p, n, t) {
  const sh = n === "original" ? p : p.mix && p.mix[n];
  if (!sh || !(sh.even || sh.fin || sh.fout)) return 1;
  let g = fadeGain(sh, p.start, p.end, t, p.reverse);
  if (sh.even) {
    const sp = n === "original" ? null : Layers.split();
    const pts = n === "original" ? envPoints({ file: S.proj.source }, sh.even) : sp && envPoints({ split: sp.id, layer: n }, sh.even);
    if (pts) g *= dbGain(envDb(pts, t));
  }
  return g;
}
/** The live gain of a music track's Auto level / Even out and fades at timeline time t. */
function musicShapeGain(x, t) {
  let g = 1;
  const T = rawTotal(), fi = x.fade_in === undefined ? 0.5 : +x.fade_in, fo = x.fade_out === undefined ? 1.5 : +x.fade_out;
  if (fi > 0) g *= clamp(t / fi, 0, 1);
  if (fo > 0) g *= clamp((T - t) / fo, 0, 1);
  const r = mspans(x).find((q) => t >= q.a && t < q.b);
  if (!r) return g;
  g *= fadeGain(r.q, r.a, r.b, t, false);
  const s = r.q.even === undefined ? (x.auto || 0) : r.q.even;
  if (s) {
    const pts = envPoints({ file: x.file }, s), m = MUSIC.get(x.file), D = m && m.duration;
    if (pts && D) g *= dbGain(envDb(pts, (t + (+x.start || 0)) % D));
  }
  return g;
}
/** Even out (Off / Gentle / Strong) for the chosen parts. cur: 0, 1, 2, or null when they differ. */
function evenField(cur, onpick, off, note) {
  const seg = segmented([[0, "Off"], [1, "Gentle"], [2, "Strong"]], cur === null ? "" : cur, (v) => onpick(+v));
  if (off) for (const b of seg.children) b.disabled = true;
  return el("div", { class: "field even-field" },
    el("span", {}, el("b", { text: "Even out" }), el("small", { class: "note", text: " loud moments down, quiet moments up" })), seg,
    note ? el("p", { class: "hint", text: note }) : null);
}
/** Fade in / fade out sliders (seconds, 0 to 10). Values null when the chosen parts differ. */
function fadeFields(fin, fout, onset, off, labels) {
  const one = (label, v, key) => {
    const val = el("b", { class: "num", text: v === null ? "—" : (+v).toFixed(1) + " s" });
    const r = el("input", { type: "range", class: "rng", min: "0", max: "10", step: "0.1", value: String(v === null ? 0 : v), "aria-label": label });
    r.addEventListener("input", () => { val.textContent = (+r.value).toFixed(1) + " s"; paintRange(r); });
    r.addEventListener("change", () => onset(key, +r.value));
    r.disabled = !!off; setTimeout(() => paintRange(r), 0);
    return el("div", { class: "field" }, el("span", {}, label + " ", val), r);
  };
  const L = labels || ["Fade in", "Fade out"];
  return el("div", { class: "fade-fields" }, one(L[0], fin, "fin"), one(L[1], fout, "fout"));
}
const same = (arr) => { const u = [...new Set(arr)]; return u.length === 1 ? u[0] : null; };

// ---- Sound check: the whole mix, measured the way YouTube does, moment by moment. The strip under the tracks shows it
// (green = right, yellow / red = too quiet / too loud next to YouTube's level), with one button to even out the problem spots.
S.check = null;
async function soundCheck() {
  if (!kept().length) { toast("The timeline is empty: put a piece back first.", true); return; }
  const box = $("mixCheck"), b = $("checkMix");
  box.hidden = false; b.disabled = true;
  const bar = el("div", { class: "prog" }, el("i")), note = el("p", { class: "hint", text: "Making a quick version of the mix and listening to it…" });
  box.replaceChildren(note, bar);
  try {
    await saveNow();
    const job = await api("/api/projects/" + S.id + "/render", { method: "POST", json: { preview: true, replace: true } });
    let j;
    for (;;) {
      j = await api("/api/jobs/" + job.id);
      if (["done", "failed", "cancelled", "interrupted"].includes(j.status)) break;
      bar.firstChild.style.width = Math.round((j.progress || 0) * 100) + "%";
      await new Promise((ok) => setTimeout(ok, 900));
    }
    if (j.status !== "done") throw new Error(j.message || "The sound check could not be made.");
    note.textContent = "Measuring…";
    const c = await api("/api/jobs/" + job.id + "/curve");
    S.check = Object.assign(c, { sig: JSON.stringify([S.proj.pieces, S.proj.settings]) });
    api("/api/jobs/" + job.id, { method: "DELETE" }).catch(() => {});      // the quick version was only for measuring: no leftover file
  } catch (e) { box.replaceChildren(el("p", { class: "hint warn", text: errText(e) })); return; } finally { b.disabled = false; }
  renderCheck(); renderTimeline();
}
function renderCheck() {
  const box = $("mixCheck"), c = S.check; if (!box || !c) return;
  const m = c.loudness, loud = c.problems.filter((x) => x.kind === "loud"), quiet = c.problems.filter((x) => x.kind === "quiet");
  const old = c.sig !== JSON.stringify([S.proj.pieces, S.proj.settings]);
  const verdict = !c.problems.length ? ["good", "Ready for YouTube: even and at the right level all the way."]
    : ["warn", (loud.length ? loud.length + " too loud" : "") + (loud.length && quiet.length ? " and " : "") + (quiet.length ? quiet.length + " too quiet" : "") + " stretch" + (c.problems.length > 1 ? "es" : "") + ". They show on the Loudness strip under the tracks."];
  box.replaceChildren(
    el("div", { class: "check-nums" },
      el("span", {}, el("small", { text: "Whole video" }), el("b", { class: "num", text: m ? m.lufs.toFixed(1) + " LUFS" : "—" })),
      el("span", {}, el("small", { text: "Highest peak" }), el("b", { class: "num", text: m ? m.true_peak.toFixed(1) + " dB" : "—" })),
      el("span", {}, el("small", { text: "YouTube" }), el("b", { class: "num", text: "-14 LUFS" }))),
    el("p", { class: "hint " + verdict[0], text: verdict[1] }),
    old ? el("p", { class: "hint", text: "You changed things since this check. Press Sound check again to see the new result." }) : null,
    c.problems.length ? btn("Even out the problem spots", { icon: "pulse", cls: "wide", title: "Switches on Even out (gentle) for the parts under those stretches", onclick: fixProblems }) : null);
}
/** Even out (gentle) for everything that plays in the problem stretches: video sections (or their split tracks) and music parts. */
function fixProblems() {
  const c = S.check; if (!c || !c.problems.length) return;
  const hit = (a, b) => c.problems.some((x) => a < x.end && b > x.start);
  let n = 0;
  if (!change(() => {
    for (const r of layout()) {
      if (!hit(r.out0, r.out1)) continue;
      const p = r.p;
      if (stemsOn()) {
        for (const k of Layers.NAMES) { if (partLocked(p, k)) continue; const m = Object.assign({}, p.mix || {}); m[k] = Object.assign({ volume: 1, mute: false }, m[k] || {}); if (!m[k].even) { m[k].even = 1; n++; } p.mix = m; }
      } else if (!p.even) { p.even = 1; n++; }
    }
    layers().forEach((x, i) => {
      if (musicLocked(i)) return;
      const ps = mparts(x).map((q) => Object.assign({ volume: 1, mute: false }, q));
      mspans(x).forEach((r) => { if (hit(r.a, r.b) && !(r.q.even === undefined ? x.auto : r.q.even)) { ps[r.k].even = 1; n++; } });
      setLayer(i, { parts: ps });
    });
  }, { sound: true, keepVideo: true })) return;
  toast(n ? "Even out is on for " + n + " part" + (n === 1 ? "" : "s") + ". Press Sound check again to see the result." : "Those parts are already evened out (or locked).");
  renderCheck();
}
/** The Loudness strip under the tracks: short-term loudness against YouTube's level. */
function renderLoudLane() {
  const lane = $("laneL"); if (!lane) return;
  const c = S.check; lane.hidden = !(c && S.mode === "final");
  if (lane.hidden) return;
  if (!lane.querySelector(".lane-head")) lane.prepend(el("div", { class: "lane-head" }, icon("pulse", "s"), el("span", { class: "ellip", text: "Loudness" })));
  const cv = lane.querySelector("canvas"), sc = $("tlScroll"), left = sc.scrollLeft, w = sc.clientWidth, H = 28, dpr = Math.min(2, window.devicePixelRatio || 1);
  if (cv.width !== Math.round(w * dpr) || cv.height !== H * dpr) { cv.width = Math.round(w * dpr); cv.height = H * dpr; }
  cv.style.left = left + "px"; cv.style.width = w + "px"; cv.style.height = H + "px";
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, H);
  const y = (v) => H - 2 - clamp((v + 40) / 34, 0, 1) * (H - 4);            // -40 .. -6 LUFS
  for (const x of c.problems) { g.fillStyle = x.kind === "loud" ? "rgba(255, 107, 138, .22)" : "rgba(255, 209, 102, .18)"; g.fillRect(px(x.start) - left, 0, Math.max(2, px(x.end) - px(x.start)), H); }
  g.strokeStyle = "rgba(255,255,255,.35)"; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(0, y(-14)); g.lineTo(w, y(-14)); g.stroke(); g.setLineDash([]);
  let prev = null;
  for (const [t, v] of c.points) {
    const X = px(t) - left;
    if (prev && X >= -4 && prev[0] <= w + 4) {
      g.strokeStyle = v > -8 ? "#ff6b8a" : v < -26 && v > -45 ? "#ffd166" : "#7ee081"; g.lineWidth = 1.6;
      g.beginPath(); g.moveTo(prev[0], prev[1]); g.lineTo(X, y(v)); g.stroke();
    }
    prev = [X, y(v)];
  }
}

// ---- The level meter (Final, next to the play buttons): how loud this moment will be on YouTube, as an estimate.
// Every export is set to -14 LUFS as a whole, so a moment lands at -14 plus how far it is above or below your mix's
// usual level. The meter works that out from the tracks and your settings (no rendering), also while paused.
// Green = right, yellow = quiet, red = too loud. Sound check measures the real thing.
S.songPeaks = new Map();
function songPeaks(file) {
  const v = S.songPeaks.get(file);
  if (v && v !== "loading") return v;
  if (!v) {
    S.songPeaks.set(file, "loading");
    (async () => {
      for (let tries = 0; tries < 60; tries++) {
        const r = await fetch("/api/peaks?id=" + encodeURIComponent(file), { headers: { "X-EditForge-Token": TOKEN } }).catch(() => null);
        if (!r || (r.status !== 200 && r.status !== 202)) break;
        if (r.status === 200) { S.songPeaks.set(file, new Uint8Array(await r.arrayBuffer())); S.meterAvg = null; paintMeter(); return; }
        await new Promise((ok) => setTimeout(ok, 1500));
      }
      S.songPeaks.set(file, new Uint8Array(0));
    })();
  }
  return null;
}
const pk = (P, sec) => { if (!P || !P.length) return 0; const i = Math.floor(sec * 50); return i >= 0 && i < P.length ? P[i] / 255 : 0; };
/** The power of the whole mix at timeline time t (0 = silence), from the tracks' wave pictures and every setting. */
function mixPower(t, L) {
  let pw = 0;
  const r = (L || layout()).find((q) => t >= q.out0 && t < q.out1);
  if (r && S.info.has_audio && !r.p.mute && S.proj.settings.original_sound) {
    const p = r.p, ts = p.reverse ? p.end - (t - r.out0) * p.speed : p.start + (t - r.out0) * p.speed;
    if (stemsOn()) {
      const sp = Layers.split();
      for (const n of Layers.NAMES) {
        const g = Layers.gainOf(n) * Layers.ownGain(p, n) * p.volume * partShapeGain(p, n, ts) * stemDuckGain(n, ts);
        const a = pk((S.stemPeaks || {})[n], ts - sp.start) * g; pw += a * a;
      }
    } else { const a = pk(S.peaks, ts) * p.volume * partShapeGain(p, "original", ts); pw += a * a; }
  }
  for (const x of layers()) {
    if (!heard(x)) continue;
    const P = songPeaks(x.file); if (!P || !P.length) continue;
    const D = P.length / 50, a = pk(P, (t + (+x.start || 0)) % D) * musicLevel(x, t); pw += a * a;
  }
  return pw;
}
/** The usual level of the mix: the average power where there is sound (worked out again after changes, a little later). */
function mixAverage() {
  const sig = S.undo.length + "|" + S.redo.length + "|" + rawTotal().toFixed(1) + "|" + (S.stemFor || "") + "|" + S.songPeaks.size + "|" + Object.keys(S.stemPeaks || {}).length + "|" + (S.peaks ? S.peaks.length : 0);
  if (S.meterAvg && S.meterAvg.sig === sig) return S.meterAvg.v;
  const L = layout(), T = L.length ? L[L.length - 1].out1 : 0, step = Math.max(0.25, T / 800);
  let sum = 0, n = 0;
  for (let t = step / 2; t < T; t += step) { const p = mixPower(t, L); if (p > 1e-5) { sum += p; n++; } }
  S.meterAvg = { sig, v: n ? sum / n : 0 };
  return S.meterAvg.v;
}
function paintMeter() {
  const box = $("levelMeter"); if (!box || S.mode !== "final") return;
  const avg = mixAverage();
  // a short window around the playhead, like the ear hears it
  const L = layout(), T = L.length ? L[L.length - 1].out1 : 0;
  let pw = 0; for (let k = -3; k <= 3; k++) pw += mixPower(clamp(S.t + k * 0.06, 0, Math.max(0, T - 0.01)), L);
  pw /= 7;
  const lufs = avg > 0 && pw > 1e-6 ? -14 + 10 * Math.log10(pw / avg) : -60;
  const pos = clamp((lufs + 40) / 34, 0, 1);                       // -40 .. -6
  const state = lufs <= -45 ? "silent" : lufs > -8 ? "loud" : lufs < -26 ? "quiet" : "good";
  box.dataset.state = state;
  box.querySelector(".lm-fill").style.width = (pos * 100).toFixed(1) + "%";
  box.querySelector(".lm-word").textContent = { silent: "Silent", loud: "Too loud", quiet: "Quiet", good: "Good" }[state];
  box.title = "Level now: about " + (lufs <= -45 ? "silence" : lufs.toFixed(0) + " LUFS") + " on YouTube (estimate). The green zone is the right level; the line is -14. Sound check measures the real thing.";
}

// ---- the music tracks you added (Final): cut them into parts like the video, change each part on its own, normalise,
// and let the music go down gradually while people talk (and back up after). The export does exactly the same.
S.msel = null;                                       // { i: music track, ks: Set of part numbers }
const DUCK_DOWN = 0.35, DUCK_UP = 0.8, DUCK_LEVEL = 0.3;
function mparts(x) { return x.parts && x.parts.length ? x.parts : [{ end: null, volume: 1, mute: false }]; }
/** The parts of a music track as they lie on the timeline: { k, a, b, q }. */
function mspans(x) {
  const T = rawTotal(), out = []; let a = 0;
  mparts(x).forEach((q, k) => { const b = q.end === null || q.end === undefined ? T : Math.min(T, q.end); if (b > a + 1e-6) out.push({ k, a, b, q }); a = Math.max(a, b); });
  return out;
}
function partGain(x, t) { for (const r of mspans(x)) if (t >= r.a && t < r.b) return r.q.mute ? 0 : +r.q.volume; return 1; }
function duckGain(x, t) {
  if (!x.duck || !x.duck.on) return 1;
  const low = x.duck.level === undefined ? DUCK_LEVEL : +x.duck.level;
  for (const [a, b] of (S.duckBy || {})[x.duck.under || "voices"] || []) {
    if (t < a) break;
    if (t <= b) return 1 - (1 - low) * clamp(Math.min((t - a) / DUCK_DOWN, (b - t) / DUCK_UP), 0, 1);
  }
  return 1;
}
const UNDER = { voices: "Voices", music: "Music", effects: "Effects" };
/** A split track that goes down while another one is heard: its live gain at source time t. */
function stemDuckGain(n, t) {
  const dk = (S.proj.settings.ducks || {})[n]; if (!dk || !dk.on) return 1;
  const act = (S.acts || {})[dk.under]; if (!act) return 1;
  if (!act.spans) act.spans = joinSpans(act.ranges.map(([a, b]) => [a, b]), 1e9);
  for (const [a, b] of act.spans) {
    if (t < a) break;
    if (t <= b) return 1 - (1 - dk.level) * clamp(Math.min((t - a) / DUCK_DOWN, (b - t) / DUCK_UP), 0, 1);
  }
  return 1;
}
/** A little before each stretch to a little after it; close ones joined (the same rule as the export). */
function joinSpans(list, T) {
  const sp = [];
  for (const [a0, b0] of list.sort((u, v) => u[0] - v[0])) {
    const a = Math.max(0, a0 - DUCK_DOWN), b = Math.min(T, b0 + DUCK_UP);
    if (sp.length && a <= sp[sp.length - 1][1] + 0.3) sp[sp.length - 1][1] = Math.max(sp[sp.length - 1][1], b); else sp.push([a, b]);
  }
  return sp;
}
/** Set (or switch off) the going down of a whole split track. */
async function setStemDuck(n, patch) {
  if (trackLocked(n)) { lockedNote(n); renderInspector(); return; }
  const cur = Object.assign({ on: false, level: DUCK_LEVEL, under: n === "voices" ? "music" : "voices" }, (S.proj.settings.ducks || {})[n] || {}, patch);
  change(() => { const d = Object.assign({}, S.proj.settings.ducks || {}); if (cur.on) d[n] = cur; else delete d[n]; S.proj.settings.ducks = d; }, { keepVideo: true });
  if (cur.on) { const v = await loadVoices(false, cur.under); if (v && !v.ranges.length) toast("Nothing was found on the " + UNDER[cur.under] + " track, so " + Layers.TITLE[n] + " stays as it is.", true); }
  Layers.apply(); renderInspector();
}
/** The 'Go down while ... is heard' box of a split track. */
function stemDuckBox(n, lk) {
  const dk = Object.assign({ on: false, level: DUCK_LEVEL, under: n === "voices" ? "music" : "voices" }, (S.proj.settings.ducks || {})[n] || {});
  const sw = el("input", { type: "checkbox", class: "sw", "aria-label": "Go down while another track is heard" }); sw.checked = !!dk.on; sw.disabled = lk;
  sw.addEventListener("change", () => setStemDuck(n, { on: sw.checked }));
  const seg = segmented(Object.keys(UNDER).filter((k) => k !== n).map((k) => [k, UNDER[k]]), dk.under, (v) => setStemDuck(n, { on: true, under: v }));
  if (lk) for (const b of seg.children) b.disabled = true;
  const val = el("b", { class: "num", text: Math.round(dk.level * 100) + "%" });
  const r = el("input", { type: "range", class: "rng", min: "0", max: "80", step: "1", value: String(Math.round(dk.level * 100)), "aria-label": "Loudness while the other track is heard" });
  r.disabled = lk || !dk.on;
  r.addEventListener("input", () => { val.textContent = r.value + "%"; paintRange(r); });
  r.addEventListener("change", () => setStemDuck(n, { on: true, level: r.value / 100 }));
  setTimeout(() => paintRange(r), 0);
  return el("div", { class: "pad duck-box" },
    el("label", { class: "swl" }, el("span", {}, el("b", { text: "Whole " + Layers.TITLE[n].split(" (")[0] + " track: go down while" })), sw),
    el("div", { class: "field" }, el("span", { text: "…this is heard" }), seg),
    el("div", { class: "field" }, el("span", {}, "Loudness then ", val), r));
}
/** When someone talks (finished-video time), from the voices the app found in the source. */
function voiceOut(of) {
  const act = (S.acts || {})[of || "voices"];
  if (!act) return [];
  const out = [];
  for (const r of layout()) {
    const p = r.p; if (p.mute) continue;
    for (const [a, b] of act.ranges) {
      const x0 = Math.max(a, p.start), x1 = Math.min(b, p.end); if (x1 - x0 < 0.02) continue;
      out.push(p.reverse ? [r.out0 + (p.end - x1) / p.speed, r.out0 + (p.end - x0) / p.speed] : [r.out0 + (x0 - p.start) / p.speed, r.out0 + (x1 - p.start) / p.speed]);
    }
  }
  out.sort((u, v) => u[0] - v[0]);
  const T = rawTotal(), sp = [];
  for (const [a0, b0] of out) {
    const a = Math.max(0, a0 - DUCK_DOWN), b = Math.min(T, b0 + DUCK_UP);
    if (sp.length && a <= sp[sp.length - 1][1] + 0.3) sp[sp.length - 1][1] = Math.max(sp[sp.length - 1][1], b); else sp.push([a, b]);
  }
  return sp;
}
function ducking() { return layers().some((x) => x.duck && x.duck.on); }
/** When a track is heard in the source (voices by default; music / effects need the split). */
async function loadVoices(force, of) {
  of = of || "voices";
  S.acts = S.acts || {}; S.actBusy = S.actBusy || {};
  const key = S.proj.settings.mix_split || "-";
  if (!force && S.acts[of] && S.acts[of].key === key) return S.acts[of];
  if (S.actBusy[of]) return null;
  S.actBusy[of] = true;
  try {
    await saved();
    const r = await api("/api/projects/" + S.id + "/voices?of=" + of);
    S.acts[of] = { key, ranges: r.ranges || [], from: r.from };
    if (of === "voices") S.voice = S.acts[of];
  } catch (e) { toast(errText(e), true); S.acts[of] = { key, ranges: [], from: "sound", failed: true }; return null; } finally { S.actBusy[of] = false; }
  renderTimeline(); renderInspector();
  return S.acts[of];
}
/** Which tracks something goes down under right now (songs and split tracks). */
function duckNeeds() {
  const need = new Set();
  for (const x of layers()) if (x.duck && x.duck.on) need.add(x.duck.under || "voices");
  for (const dk of Object.values(S.proj.settings.ducks || {})) if (dk && dk.on) need.add(dk.under);
  return need;
}
/** A song you add starts as a soft bed under the video: about 20 %, set from how loud the song itself really is
 *  (a loud song a little lower, a quiet one a little higher). You can change it after. */
async function autoSongLevel(file) {
  try {
    const r = await api("/api/split/levels", { method: "POST", json: { file, ranges: [[0, 180]] } });
    const v = r.levels[0]; if (!v || v.rms < -70) return;
    const vol = +clamp(0.2 * Math.pow(10, (-18 - v.rms) / 20), 0.05, 1).toFixed(2);
    const i = layers().findIndex((x) => x.file === file && Math.abs(x.volume - 0.2) < 0.001);
    if (i < 0) return;
    setLayer(i, { volume: vol }); scheduleSave();
    renderMusicLayers(); renderTimeline(); renderInspector(); if (S.playing) musicPlay();
    toast("Song set to " + Math.round(vol * 100) + "% by itself (from how loud it is). It goes down while people talk.");
  } catch (e) { /* the 20 % start stays */ }
}
function setLayer(i, patch) { S.proj.settings.layers = layers().map((y, j) => (j === i ? Object.assign({}, y, patch) : y)); }
function musicLocked(i) {
  if (trackLocked("sound")) return "The sound track is locked. Click its lock to change the music.";
  const x = layers()[i]; return x && x.locked ? "This music track is locked. Click its lock to change it." : "";
}
function mselList() { const x = S.msel && layers()[S.msel.i]; return x ? mspans(x).filter((r) => S.msel.ks.has(r.k)) : []; }
function musicChange(fn) {
  const i = S.msel && S.msel.i, x = layers()[i]; if (!x) return;
  const why = musicLocked(i); if (why) { toast(why, true); return; }
  const ks = S.msel.ks;
  change(() => {
    const ps = mparts(x).map((q, k) => { const c = Object.assign({ volume: 1, mute: false }, q); if (ks.has(k)) fn(c, k); return c; });
    setLayer(i, { parts: ps });
  }, { keepVideo: true });
  if (S.playing) musicPlay();
}
/** Cut a music track at a time (only the music: the video is not cut). */
function cutMusic(i, t) {
  const x = layers()[i]; if (!x) return;
  const why = musicLocked(i); if (why) { toast(why, true); return; }
  const r = mspans(x).find((q) => t > q.a + 0.05 && t < q.b - 0.05);
  if (!r) { toast("Too close to the edge of a part to cut here."); return; }
  change(() => { const ps = clone(mparts(x)); ps.splice(r.k, 0, Object.assign({}, ps[r.k], { end: +t.toFixed(3) })); setLayer(i, { parts: ps }); }, { keepVideo: true });
  S.msel = { i, ks: new Set([r.k + 1]) };
  refreshAll({ keepVideo: true });
}
/** Join the chosen parts (and those in between) back into one; it keeps the first one's loudness. */
function joinMusicParts() {
  const i = S.msel && S.msel.i, x = layers()[i]; if (!x || S.msel.ks.size < 2) return;
  const why = musicLocked(i); if (why) { toast(why, true); return; }
  const ks = [...S.msel.ks].sort((a, b) => a - b), a = ks[0], b = ks[ks.length - 1];
  change(() => { const ps = clone(mparts(x)); const keep = Object.assign({}, ps[a], { end: ps[b].end }); ps.splice(a, b - a + 1, keep); setLayer(i, { parts: ps.length === 1 && Math.abs(ps[0].volume - 1) < 0.001 && !ps[0].mute ? undefined : ps }); }, { keepVideo: true });
  S.msel = { i, ks: new Set([a]) }; refreshAll({ keepVideo: true });
}
async function normaliseMusic(together) {
  const i = S.msel && S.msel.i, x = layers()[i], list = mselList(); if (!x || !list.length) return;
  const why = musicLocked(i); if (why) { toast(why, true); return; }
  toast("Measuring " + list.length + " part" + (list.length > 1 ? "s" : "") + "…");
  let r;
  const sk = +x.start || 0;
  try { r = await api("/api/split/levels", { method: "POST", json: { file: x.file, ranges: list.map((q) => [q.a + sk, q.b + sk]) } }); } catch (e) { toast(errText(e), true); return; }
  const TARGET = -18, gains = new Map();
  if (together) {
    const live = r.levels.filter((v) => v.rms > -70);
    if (live.length) {
      const pw = live.reduce((a, v) => a + Math.pow(10, v.rms / 10), 0) / live.length, peak = Math.max(...live.map((v) => v.peak));
      const g = Math.min(Math.pow(10, (TARGET - 10 * Math.log10(pw)) / 20), 0.97 / Math.max(peak, 1e-4), 2);
      list.forEach((q) => gains.set(q.k, g));
    }
  } else list.forEach((q, j) => { const v = r.levels[j]; if (v.rms > -70) gains.set(q.k, Math.min(Math.pow(10, (TARGET - v.rms) / 20), 0.97 / Math.max(v.peak, 1e-4), 2)); });
  if (!gains.size) { toast("These parts are silent: nothing to change.", true); return; }
  musicChange((c, k) => { if (gains.has(k)) { c.volume = +gains.get(k).toFixed(3); c.mute = false; } });
  toast("Same loudness for " + gains.size + " music part" + (gains.size > 1 ? "s" : "") + (together ? ", balance kept." : "."));
}
async function setDuck(i, on, level, under) {
  const x = layers()[i]; if (!x) return;
  const why = musicLocked(i); if (why) { toast(why, true); renderInspector(); return; }
  const cur = Object.assign({ on: false, level: DUCK_LEVEL }, x.duck || {});
  const next = { on: on === undefined ? cur.on : on, level: level === undefined ? cur.level : level };
  const u = under || cur.under; if (u && u !== "voices") next.under = u;
  change(() => { setLayer(i, { duck: next }); }, { keepVideo: true });
  if (next.on) { const v = await loadVoices(false, next.under || "voices"); if (v && !v.ranges.length) toast("Nothing was found on the " + UNDER[next.under || "voices"] + " track, so the music stays as it is.", true); }
  if (S.playing) musicPlay();
}
function onMusicDown(e) {
  const row = e.target.closest(".mrow"), part = e.target.closest(".mpart"); if (!row || !part) return false;
  const i = +row.dataset.i, k = +part.dataset.k, add = e.ctrlKey || e.metaKey;
  S.sel.clear(); S.asel = new Map();
  if (!S.msel || S.msel.i !== i) S.msel = { i, ks: new Set() };
  if (e.shiftKey && S.mAnchor !== undefined) { if (!add) S.msel.ks.clear(); for (let j = Math.min(S.mAnchor, k); j <= Math.max(S.mAnchor, k); j++) S.msel.ks.add(j); }
  else if (add) { if (S.msel.ks.has(k)) S.msel.ks.delete(k); else S.msel.ks.add(k); }
  else S.msel.ks = new Set([k]);
  S.mAnchor = k;
  const sc = $("tlScroll"), rect = sc.getBoundingClientRect();
  seek(clamp(timeAt(e.clientX - rect.left + sc.scrollLeft), 0, Math.max(0, rawTotal() - 0.01)));
  refreshAll({ keepVideo: true });
  return true;
}
function musicMenuItems(i, t) {
  const x = layers()[i], lk = !!musicLocked(i), list = mselList(), n = list.length, allMuted = n && list.every((q) => q.q.mute);
  const set = (patch) => { change(() => setLayer(i, patch), { keepVideo: true }); renderMusicLayers(); if (S.playing) musicPlay(); };
  return [
    ["Cut the music here", "split", () => cutMusic(i, t), { key: "S", off: lk }],
    n ? [allMuted ? "Turn these parts on" : "Mute these parts", allMuted ? "vol" : "mute", () => musicChange((c) => { c.mute = !allMuted; }), { key: "Del", off: lk }] : null,
    n ? ["Same loudness", "sliders", () => normaliseMusic(false), { off: lk }] : null,
    n > 1 ? ["Same loudness, keep balance", "sliders", () => normaliseMusic(true), { off: lk }] : null,
    n > 1 ? ["Join these parts", "combine", () => joinMusicParts(), { off: lk }] : null,
    n ? ["Even out these parts (gentle)", "pulse", () => musicChange((c) => { c.even = 1; }), { off: lk }] : null,
    n ? ["Even out these parts (strong)", "pulse", () => musicChange((c) => { c.even = 2; }), { off: lk }] : null,
    n ? ["Gentle fade in and out (1 s)", "sliders", () => musicChange((c) => { c.fin = 1; c.fout = 1; }), { off: lk }] : null,
    n ? ["Full loudness again", "restore", () => musicChange((c) => { c.volume = 1; c.mute = false; }), { off: lk }] : null,
    "-",
    [x.duck && x.duck.on ? "Stop going down under voices" : "Go down under voices", "vol", () => setDuck(i, !(x.duck && x.duck.on)), { off: lk }],
    [x.mute ? "Turn this music on" : "Mute this music", x.mute ? "vol" : "mute", () => set({ mute: !x.mute })],
    [x.solo ? "Stop solo" : "Hear only this (solo)", "target", () => set({ solo: !x.solo })],
    [x.locked ? "Unlock this music" : "Lock this music", x.locked ? "unlock" : "lock", () => set({ locked: !x.locked })],
    "-", ["Remove this music", "trash", () => { change(() => { S.proj.settings.layers = layers().filter((_, k) => k !== i); }, { keepVideo: true }); S.msel = null; renderMusicLayers(); musicPlay(); if (!S.playing) musicPause(); }, { danger: true, off: lk }],
  ].filter(Boolean);
}
/** Where in the song it starts: type a time (1:23), or take it from where the song is playing now. */
function songStartField(x, setTrack, lk) {
  const cur = +x.start || 0, m = MUSIC.get(x.file), D = m && m.duration;
  const inp = el("input", { class: "input short", value: fmtTime(cur, 1), "aria-label": "Where the song starts", inputmode: "decimal", title: "Minutes:seconds into the song, for example 1:05" });
  const parse = (v) => { const p = String(v).trim().split(":").map(Number); if (p.some((n) => !isFinite(n))) return null; return p.length === 2 ? p[0] * 60 + p[1] : p.length === 1 ? p[0] : null; };
  const set = (v) => { if (v === null || v < 0) { toast("Type a time like 1:05 (minutes:seconds).", true); inp.value = fmtTime(cur, 1); return; } if (D) v = Math.min(v, Math.max(0, D - 1)); if (Math.abs(v - (+(layers().find((y) => y.file === x.file) || {}).start || 0)) < 0.005) return; setTrack({ start: +v.toFixed(2) }); renderInspector(); };
  inp.addEventListener("change", () => { const v = parse(inp.value); setTimeout(() => set(v), 0); });
  inp.disabled = !!lk;
  const here = btn("From here", { cls: "sm ghost", title: "Start the song with the bit that is playing at the playhead now", onclick: () => { if (lk) return; set(D ? ((S.t + cur) % D) : S.t + cur); } });
  const zero = btn("Start", { cls: "sm ghost", title: "Start the song from its beginning", onclick: () => { if (!lk) set(0); } });
  return el("div", { class: "field song-start" }, el("span", {}, "Song starts at ", el("small", { class: "note", text: D ? "of " + fmtTime(D, 0) : "" })), el("div", { class: "row" }, inp, here, zero));
}
function renderMusicInspector(R) {
  const i = S.msel.i, x = layers()[i], list = mselList(), lk = !!musicLocked(i);
  const name = (S.files.find((f) => f.id === x.file) || { name: x.file.split("/").pop() }).name;
  R.append(el("div", { class: "side-h" }, el("h2", { class: "ellip", text: name }), el("span", { class: "note num", text: list.length + (list.length === 1 ? " part" : " parts") + " chosen" })));
  const rng = (label, v, onset, aria) => {
    const val = el("b", { class: "num", text: v === null ? "—" : Math.round(v * 100) + "%" });
    const r = el("input", { type: "range", class: "rng", min: "0", max: "200", step: "1", value: String(Math.round((v === null ? 1 : v) * 100)), "aria-label": aria });
    r.addEventListener("input", () => { val.textContent = r.value + "%"; paintRange(r); });
    r.addEventListener("change", () => onset(r.value / 100));
    r.disabled = lk; setTimeout(() => paintRange(r), 0);
    return el("div", { class: "field" }, el("span", {}, label + " ", val, el("small", { class: "note", text: " (up to 200%)" })), r);
  };
  const vols = [...new Set(list.map((q) => +q.q.volume))], mutes = [...new Set(list.map((q) => !!q.q.mute))];
  const mute = el("input", { type: "checkbox", class: "sw", "aria-label": "Mute the chosen parts" });
  mute.checked = mutes.length === 1 && mutes[0]; mute.indeterminate = mutes.length > 1; mute.disabled = lk;
  mute.addEventListener("change", () => musicChange((c) => { c.mute = mute.checked; }));
  const duck = Object.assign({ on: false, level: DUCK_LEVEL }, x.duck || {});
  const dsw = el("input", { type: "checkbox", class: "sw", "aria-label": "Go down while people talk" }); dsw.checked = !!duck.on; dsw.disabled = lk;
  dsw.addEventListener("change", () => setDuck(i, dsw.checked));
  const dval = el("b", { class: "num", text: Math.round(duck.level * 100) + "%" });
  const dr = el("input", { type: "range", class: "rng", min: "0", max: "80", step: "1", value: String(Math.round(duck.level * 100)), "aria-label": "Music loudness while people talk" });
  dr.disabled = lk || !duck.on;
  dr.addEventListener("input", () => { dval.textContent = dr.value + "%"; paintRange(dr); });
  dr.addEventListener("change", () => setDuck(i, true, dr.value / 100));
  setTimeout(() => paintRange(dr), 0);
  const under = duck.under || "voices", act = (S.acts || {})[under];
  const useg = segmented(Object.keys(UNDER).map((k) => [k, UNDER[k]]), under, (v) => {
    if (v !== "voices" && !stemsOn()) { toast("Split the sound first (Sound panel): then the music can go down under " + UNDER[v] + ".", true); renderInspector(); return; }
    setDuck(i, true, undefined, v);
  });
  if (lk) for (const b of useg.children) b.disabled = true;
  const vNote = !duck.on ? "The music goes down gradually while that track is heard, and comes back up after." : !act ? "Listening…"
    : act.from === "voices" || under !== "voices" ? act.ranges.length + " stretches found on the split " + UNDER[under] + " track. They show as dips on the music."
      : act.ranges.length + " stretches of talking, guessed from the plain sound. Split the sound for a much better result.";
  R.append(el("div", { class: "pad" },
    list.length ? rng("Chosen parts", vols.length === 1 ? vols[0] : null, (v) => musicChange((c) => { c.volume = v; c.mute = false; }), "Loudness of the chosen music parts") : null,
    list.length ? el("label", { class: "swl" }, el("span", { text: "Mute the chosen parts" }), mute) : null,
    list.length ? el("div", { class: "btns" },
      btn("Same loudness", { icon: "sliders", title: "Each chosen part as a whole goes up or down, so they all sound equally loud (up to 200%). Inside a part nothing changes: for that use Even out.", onclick: () => normaliseMusic(false) }),
      btn("Keep balance", { icon: "sliders", cls: "ghost", title: "The chosen parts go up or down together by the same amount, so their balance stays", onclick: () => normaliseMusic(true) })) : null,
    el("div", { class: "btns" },
      btn("Cut here", { icon: "split", title: "Cut the music at the playhead (S). The video is not cut.", onclick: () => cutMusic(i, S.t) }),
      list.length > 1 ? btn("Join", { icon: "combine", cls: "ghost", title: "Make the chosen parts one part again", onclick: joinMusicParts }) : btn("Full loudness", { icon: "restore", cls: "ghost", onclick: () => musicChange((c) => { c.volume = 1; c.mute = false; }) })),
    list.length ? evenField(same(list.map((q) => (q.q.even === undefined ? x.auto || 0 : q.q.even))), (v) => musicChange((c) => { c.even = v; }), lk,
      "Only the chosen parts. Parts that are fine are not changed.") : null,
    list.length ? fadeFields(same(list.map((q) => q.q.fin || 0)), same(list.map((q) => q.q.fout || 0)), (k, v) => musicChange((c) => { if (v > 0) c[k] = v; else delete c[k]; }), lk) : null));
  const setTrack = (patch) => { if (musicLocked(i)) { toast(musicLocked(i), true); renderInspector(); return; } change(() => setLayer(i, patch), { keepVideo: true }); renderMusicLayers(); if (S.playing) musicPlay(); };
  const autoSeg = segmented([[0, "Off"], [1, "Gentle"], [2, "Strong"]], x.auto || 0, (v) => setTrack({ auto: +v }));
  if (lk) for (const b of autoSeg.children) b.disabled = true;
  R.append(el("div", { class: "pad track-box" },
    el("div", { class: "field" }, el("span", {}, el("b", { text: "Whole song" })) ),
    el("div", { class: "field even-field" }, el("span", {}, "Auto level ", el("small", { class: "note", text: "the song's own loud bits down, quiet bits up" })), autoSeg),
    rng("Loudness", x.volume, (v) => setTrack({ volume: v }), "Loudness of the whole music track"),
    songStartField(x, setTrack, lk),
    fadeFields(x.fade_in === undefined ? 0.5 : x.fade_in, x.fade_out === undefined ? 1.5 : x.fade_out, (k, v) => setTrack(k === "fin" ? { fade_in: v } : { fade_out: v }), lk,
      ["Song fades in", "Song fades out"])));
  R.append(el("div", { class: "pad duck-box" },
    el("label", { class: "swl" }, el("span", {}, el("b", { text: "Go down while people talk" })), dsw),
    el("div", { class: "field" }, el("span", { text: "Go down under" }), useg),
    el("div", { class: "field" }, el("span", {}, "Music loudness then ", dval), dr),
    el("p", { class: "hint", text: vNote })));
  R.append(el("div", { class: "pad" },
    btn(x.locked ? "Unlock this music" : "Lock this music", { icon: x.locked ? "unlock" : "lock", cls: "ghost wide", onclick: () => { change(() => setLayer(i, { locked: !x.locked }), { any: true }); } }),
    el("p", { class: "hint", text: "Click a part on the music track (Ctrl + click for more, Shift + click for all in between). S cuts the music at the playhead, Delete mutes the chosen parts. " +
      "The export is made ready for YouTube by itself: the whole mix is set to -14 LUFS with peaks under -1 dB." })));
  if (duck.on && !act) loadVoices(false, under);
}

// ---- the split sound on the timeline (Final): one track each for voices, music and effects (like CapCut). Every part of a
// track lines up with a video section; click parts (Ctrl / Shift for more), or a track's name for the whole track.
S.asel = new Map();                          // piece -> Set of layers chosen on the sound tracks
S.stemPeaks = {};
function stemsOn() { return S.mode === "final" && typeof Layers !== "undefined" && !!Layers.split(); }
function aselList() { const out = []; for (const p of kept()) { const set = S.asel.get(p); if (set) for (const n of Layers.NAMES) if (set.has(n)) out.push({ p, n }); } return out; }
function aselHas(p, n) { const set = S.asel.get(p); return !!(set && set.has(n)); }
function aselSet(p, n, on) { let set = S.asel.get(p); if (!set) { set = new Set(); S.asel.set(p, set); } if (on) set.add(n); else set.delete(n); if (!set.size) S.asel.delete(p); }
function aselLayers() { const out = new Set(); for (const set of S.asel.values()) for (const n of set) out.add(n); return Layers.NAMES.filter((n) => out.has(n)); }
async function loadStemPeaks() {
  const sp = stemsOn() ? Layers.split() : null;
  if (!sp || S.stemFor === sp.id) return;
  S.stemFor = sp.id; S.stemPeaks = {};
  await Promise.all(Layers.NAMES.map(async (n) => {
    for (let tries = 0; tries < 200 && S.stemFor === sp.id; tries++) {
      const r = await fetch("/api/peaks?split=" + encodeURIComponent(sp.id) + "&layer=" + n, { headers: { "X-EditForge-Token": TOKEN } }).catch(() => null);
      if (!r) return;
      if (r.status === 200) { S.stemPeaks[n] = new Uint8Array(await r.arrayBuffer()); renderStemLanes(); paintMeter(); return; }
      if (r.status !== 202) return;
      await new Promise((ok) => setTimeout(ok, 1500));
    }
  }));
}
document.addEventListener("layers-info", () => setTimeout(() => { loadStemPeaks(); if (S.proj) renderTimeline(); }, 0));
function renderStemLanes() {
  const box = $("laneStems"), on = stemsOn();
  box.hidden = !on;
  if (S.mode === "final" && S.info.has_audio) $("laneA").hidden = on;           // the split tracks take the place of the one sound track
  if (!on) return;
  const sp = Layers.split();
  if (box.dataset.for !== sp.id + "|" + Layers.NAMES.join()) {
    box.dataset.for = sp.id + "|" + Layers.NAMES.join(); box.replaceChildren();
    for (const n of Layers.NAMES) {
      box.append(el("div", { class: "lane audio stem", "data-layer": n },
        el("div", { class: "lane-head stem-head", "data-layer": n, title: "Click: the whole " + Layers.TITLE[n] + " track · Ctrl + click: add it" },
          icon(Layers.ICON[n], "s"), el("span", { class: "ellip", text: Layers.TITLE[n] })),
        el("canvas", { class: "wave" })));
    }
  }
  const sc = $("tlScroll"), left = sc.scrollLeft, w = sc.clientWidth, H = 32, dpr = Math.min(2, window.devicePixelRatio || 1), R = S.peakRate || 50;
  const colour = { voices: "#5ab8ff", music: "#c08cff", effects: "#ffb35a", found: "#7ee081" };
  for (const lane of box.querySelectorAll(".lane.stem")) {
    const n = lane.dataset.layer, cv = lane.querySelector("canvas"), P = S.stemPeaks[n];
    const whole = kept().length && kept().every((p) => aselHas(p, n));
    const head = lane.querySelector(".stem-head");
    head.classList.toggle("on", whole);
    const lb = head.querySelector(".lock-btn"); if (lb) lb.remove();
    head.append(lockBtn(n));
    lane.classList.toggle("track-locked", trackLocked(n) || trackLocked("sound"));
    const g0 = Layers.gainOf(n);
    lane.classList.toggle("muted", g0 < 0.001);
    if (cv.width !== Math.round(w * dpr) || cv.height !== H * dpr) { cv.width = Math.round(w * dpr); cv.height = H * dpr; }
    cv.style.left = left + "px"; cv.style.width = w + "px"; cv.style.height = H + "px";
    const g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, H);
    for (const r of layout()) {
      const x0 = px(r.out0), x1 = px(r.out1);
      if (x1 < left || x0 > left + w) continue;
      const p = r.p, own = Layers.ownGain(p, n), sel = aselHas(p, n), quiet = p.mute || own < 0.001 || g0 < 0.001;
      g.fillStyle = sel ? "rgba(62, 199, 217, .22)" : "rgba(255, 255, 255, .04)";
      g.fillRect(x0 - left + 1, 2, Math.max(1, x1 - x0 - 2), H - 4);
      if (sel) { g.strokeStyle = "#3ec7d9"; g.lineWidth = 1.5; g.strokeRect(x0 - left + 1.5, 2.5, Math.max(1, x1 - x0 - 3), H - 5); }
      const gid = p.mix && p.mix[n] && p.mix[n].group;
      if (gid) { g.fillStyle = groupColour(gid); g.fillRect(x0 - left + 1, H - 5, Math.max(1, x1 - x0 - 2), 3); }
      const shp = p.mix && p.mix[n];
      if (shp && (shp.even || shp.fin || shp.fout)) { g.fillStyle = "rgba(126, 224, 129, .85)"; g.fillRect(x0 - left + 2, 3, Math.max(1, x1 - x0 - 4), 2); }   // evened out / fades
      if (partLocked(p, n) && !trackLocked(n)) { g.fillStyle = "rgba(255, 196, 107, .10)"; g.fillRect(x0 - left + 1, 2, Math.max(1, x1 - x0 - 2), H - 4); }
      if (!P) continue;
      const amp = quiet ? 0 : Math.min(2, (p.volume === undefined ? 1 : p.volume) * own * g0);
      g.fillStyle = quiet ? "rgba(160,160,170,.45)" : colour[n];
      for (let x = Math.floor(Math.max(x0, left)); x < Math.min(x1, left + w); x++) {
        const t0 = timeAt(x) - r.out0, t1 = timeAt(x + 1) - r.out0;
        let s0 = p.start + t0 * p.speed, s1 = p.start + t1 * p.speed;
        if (p.reverse) { s0 = p.end - t1 * p.speed; s1 = p.end - t0 * p.speed; }
        const i0 = Math.max(0, Math.floor((s0 - sp.start) * R)), i1 = Math.min(P.length, Math.max(i0 + 1, Math.ceil((s1 - sp.start) * R)));
        let m = 0; for (let i = i0; i < i1; i++) if (P[i] > m) m = P[i];
        const hgt = quiet ? 1 : Math.max(1, (m / 255) * amp * (H / 2 - 3));
        g.fillRect(x - left, H / 2 - hgt, 1, hgt * 2);
      }
    }
    if (!P) { g.fillStyle = "rgba(255,255,255,.4)"; g.font = "500 11px system-ui, sans-serif"; g.fillText("Reading the sound…", Math.max(8, X0() - left + 8), H / 2 + 4); }
  }
}
/** A click on a sound track: a part (Ctrl adds, Shift chooses all in between), or the track's name for the whole track. */
function onStemDown(e) {
  const lane = e.target.closest(".lane.stem"); if (!lane) return false;
  if (e.target.closest(".lock-btn")) return true;
  const n = lane.dataset.layer, add = e.ctrlKey || e.metaKey;
  S.sel.clear();
  if (e.target.closest(".stem-head")) {
    const whole = kept().every((p) => aselHas(p, n));
    if (!add) S.asel = new Map();
    for (const p of kept()) aselSet(p, n, !(add && whole));
  } else {
    const sc = $("tlScroll"), rect = sc.getBoundingClientRect(), t = clamp(timeAt(e.clientX - rect.left + sc.scrollLeft), 0, Math.max(0, rawTotal() - 0.01));
    const at = segAt(t); if (!at) return true;
    const p = at.s.p;
    if (e.shiftKey && S.aAnchor && kept().includes(S.aAnchor.p)) {
      const K = kept(), a = K.indexOf(S.aAnchor.p), b = K.indexOf(p);
      if (!add) S.asel = new Map();
      for (let k = Math.min(a, b); k <= Math.max(a, b); k++) { aselSet(K[k], S.aAnchor.n, true); aselSet(K[k], n, true); }
    } else if (add) aselSet(p, n, !aselHas(p, n));
    else { S.asel = new Map(); aselSet(p, n, true); }
    S.aAnchor = { p, n };
    seek(t);
  }
  refreshAll({ keepVideo: true });
  return true;
}
function partLocked(p, n) {
  if (trackLocked(n)) return "The " + Layers.TITLE[n] + " track is locked.";
  const g = p.mix && p.mix[n] && p.mix[n].group, grp = g && soundGroups().find((x) => x.id === g);
  if (grp && grp.locked) return "The group '" + grp.name + "' is locked.";
  return "";
}
function stemChange(fn) {
  const all = aselList(); if (!all.length) return;
  const list = all.filter(({ p, n }) => !partLocked(p, n));
  if (!list.length) { toast(partLocked(all[0].p, all[0].n) + " Unlock it to change these parts.", true); return; }
  if (list.length < all.length) toast((all.length - list.length) + " locked part" + (all.length - list.length > 1 ? "s were" : " was") + " left as it was.");
  change(() => {
    for (const { p, n } of list) {
      const m = Object.assign({}, p.mix || {}), cur = Object.assign({ volume: 1, mute: false }, m[n] || {});
      fn(cur, p, n);
      if (!cur.even) delete cur.even; if (!cur.fin) delete cur.fin; if (!cur.fout) delete cur.fout;
      if (!cur.mute && Math.abs(cur.volume - 1) < 0.001 && !cur.group && !cur.even && !cur.fin && !cur.fout) delete m[n]; else m[n] = cur;
      if (!cur.group) delete cur.group;
      if (Object.keys(m).length) p.mix = m; else delete p.mix;
    }
  }, { sound: true });
  Layers.apply();
}
function stemMenu(e) {
  const lane = e.target.closest(".lane.stem"); if (!lane) return false;
  e.preventDefault();
  const n = lane.dataset.layer;
  if (!aselList().length || e.target.closest(".stem-head")) { S.sel.clear(); S.asel = new Map(); for (const p of kept()) aselSet(p, n, true); refreshAll({ keepVideo: true }); }
  const list = aselList(), allMuted = list.every(({ p, n: k }) => Layers.ownGain(p, k) < 0.001), lk = list.every(({ p, n: k }) => partLocked(p, k));
  const names = aselLayers().map((k) => Layers.TITLE[k]).join(" + ");
  ctxMenu([
    [allMuted ? "Turn these parts on" : "Mute these parts", allMuted ? "vol" : "mute", () => stemChange((c) => { c.mute = !allMuted; }), { key: "Del", off: lk }],
    ["Full loudness again", "restore", () => stemChange((c) => { c.mute = false; c.volume = 1; }), { off: lk }],
    "-",
    ["Same loudness", "sliders", () => normaliseParts(false), { off: lk }],
    ["Same loudness, keep balance", "sliders", () => normaliseParts(true), { off: lk }],
    aselLayers().length === 1 && aselLayers()[0] !== "found" ? ["Separate these parts again", "layers", () => separateAgain(), { off: lk }] : null,
    ["Even out (gentle)", "pulse", () => stemChange((c) => { c.even = 1; }), { off: lk }],
    ["Even out (strong)", "pulse", () => stemChange((c) => { c.even = 2; }), { off: lk }],
    list.some(({ p, n: k }) => p.mix && p.mix[k] && p.mix[k].even) ? ["Stop evening out", "x", () => stemChange((c) => { c.even = 0; }), { off: lk }] : null,
    ["Gentle fade in and out (1 s)", "sliders", () => stemChange((c) => { c.fin = 1; c.fout = 1; }), { off: lk }],
    ["Group these parts", "combine", () => makeGroup()],
    ...[...new Set(aselList().map(({ p, n: k }) => p.mix && p.mix[k] && p.mix[k].group).filter(Boolean))].slice(0, 3).map((gid) => {
      const gr = soundGroups().find((x) => x.id === gid); return gr ? ["Choose the group '" + gr.name + "'", "check", () => chooseGroup(gid)] : null;
    }),
    "-",
    ["Choose the whole " + Layers.TITLE[n] + " track", "list", () => { S.asel = new Map(); for (const p of kept()) aselSet(p, n, true); refreshAll({ keepVideo: true }); }],
    ["Also choose the other tracks here", "layers", () => { for (const { p } of aselList()) for (const k of Layers.NAMES) aselSet(p, k, true); refreshAll({ keepVideo: true }); }],
    "-",
    ["Split here (cuts the video section too)", "split", () => splitAtPlayhead(), { key: "S", off: locked() }],
  ].filter(Boolean), e.clientX, e.clientY);
  void names;
  return true;
}
// ---- groups of sound parts: name them, choose them in one click, lock them
function soundGroups() { return (S.proj.settings.sound_groups = S.proj.settings.sound_groups || []); }
const GROUP_COLOURS = ["#ff6b8a", "#7ee081", "#ffd166", "#5ab8ff", "#c08cff", "#ff9f5a"];
function dotFor(id) { const d = el("i", { class: "grp-dot" }); d.style.background = groupColour(id); return d; }
function groupColour(id) { const i = soundGroups().findIndex((g) => g.id === id); return GROUP_COLOURS[(i < 0 ? 0 : i) % GROUP_COLOURS.length]; }
function groupParts(id) { const out = []; for (const p of kept()) for (const n of Layers.NAMES) if (p.mix && p.mix[n] && p.mix[n].group === id) out.push({ p, n }); return out; }
function chooseGroup(id) { S.sel.clear(); S.asel = new Map(); for (const { p, n } of groupParts(id)) aselSet(p, n, true); refreshAll({ keepVideo: true }); }
async function makeGroup() {
  const list = aselList(); if (!list.length) return;
  const name = await askText("Name of the group", "Group " + (soundGroups().length + 1), "Make group");
  if (!name) return;
  const id = "g" + Date.now().toString(36).slice(-8);
  change(() => {
    soundGroups().push({ id, name: name.slice(0, 40), locked: false });
    for (const { p, n } of list) { const m = Object.assign({}, p.mix || {}); m[n] = Object.assign({ volume: 1, mute: false }, m[n] || {}, { group: id }); p.mix = m; }
  }, { sound: true });
  toast("Made the group '" + name + "' (" + list.length + " parts). Click it in the list to choose it again.");
}
function groupEdit(id, what) {
  const g = soundGroups().find((x) => x.id === id); if (!g) return;
  change(() => {
    if (what === "lock") g.locked = !g.locked;
    else if (what === "ungroup") {
      for (const { p, n } of groupParts(id)) { const m = Object.assign({}, p.mix); const c = Object.assign({}, m[n]); delete c.group; if (!c.mute && Math.abs(c.volume - 1) < 0.001) delete m[n]; else m[n] = c; if (Object.keys(m).length) p.mix = m; else delete p.mix; }
      S.proj.settings.sound_groups = soundGroups().filter((x) => x.id !== id);
    }
  }, { any: true });
  refreshAll({ keepVideo: true });
}
async function renameGroup(id) {
  const g = soundGroups().find((x) => x.id === id); if (!g) return;
  const name = await askText("New name of the group", g.name, "Rename"); if (!name) return;
  change(() => { g.name = name.slice(0, 40); }, { any: true }); refreshAll({ keepVideo: true });
}
function groupsBox() {
  const gs = soundGroups(); if (!gs.length) return null;
  const box = el("div", { class: "pad groups-box" }, el("div", { class: "field" }, el("span", { text: "Sound groups" })));
  for (const g of gs) {
    const n = groupParts(g.id).length;
    box.append(el("div", { class: "grp-row" + (g.locked ? " locked" : "") },
      dotFor(g.id),
      el("button", { type: "button", class: "grp-name", title: "Choose its parts", onclick: () => chooseGroup(g.id) }, el("b", { text: g.name }), el("small", { class: "num", text: n + " part" + (n === 1 ? "" : "s") })),
      el("button", { type: "button", class: "lock-btn" + (g.locked ? " on" : ""), title: g.locked ? "Unlock the group" : "Lock the group", onclick: () => groupEdit(g.id, "lock") }, icon(g.locked ? "lock" : "unlock", "s")),
      el("button", { type: "button", class: "lock-btn", title: "More", onclick: (e) => menuAt(e.currentTarget, [["Choose its parts", "check", () => chooseGroup(g.id)], ["Rename", "edit", () => renameGroup(g.id)], ["Ungroup (the parts stay as they are)", "x", () => groupEdit(g.id, "ungroup")]]) }, icon("more", "s"))));
  }
  return box;
}
/** Normalise: every chosen part gets the same loudness (each), or the chosen parts together reach it (together).
 *  The aim is a clear, full level (about -18 dB average) without going over the top. Up to 200 %. */
async function normaliseParts(together) {
  const all = aselList(); if (!all.length) return;
  const list = all.filter(({ p, n }) => !partLocked(p, n));
  if (!list.length) { toast(partLocked(all[0].p, all[0].n), true); return; }
  const sp = Layers.split(); if (!sp) return;
  const byLayer = new Map();
  for (const it of list) (byLayer.get(it.n) || byLayer.set(it.n, []).get(it.n)).push(it);
  toast("Measuring " + list.length + " part" + (list.length > 1 ? "s" : "") + "…");
  const gains = new Map();
  try {
    for (const [n, its] of byLayer) {
      const r = await api("/api/split/levels", { method: "POST", json: { split: sp.id, layer: n, ranges: its.map(({ p }) => [p.start, p.end]) } });
      const TARGET = -18;
      if (together) {
        const live = r.levels.filter((x) => x.rms > -70);
        if (!live.length) continue;
        const pw = live.reduce((a, x) => a + Math.pow(10, x.rms / 10), 0) / live.length, rms = 10 * Math.log10(pw), peak = Math.max(...live.map((x) => x.peak));
        let g = Math.pow(10, (TARGET - rms) / 20); g = Math.min(g, 0.97 / Math.max(peak, 1e-4), 2);
        for (const it of its) gains.set(it, g);
      } else its.forEach((it, i) => { const x = r.levels[i]; if (x.rms <= -70) return; let g = Math.pow(10, (TARGET - x.rms) / 20); g = Math.min(g, 0.97 / Math.max(x.peak, 1e-4), 2); gains.set(it, g); });
    }
  } catch (e) { toast(errText(e), true); return; }
  if (!gains.size) { toast("These parts are silent: nothing to change.", true); return; }
  change(() => {
    for (const [{ p, n }, g] of gains) { const m = Object.assign({}, p.mix || {}); m[n] = Object.assign({ volume: 1, mute: false }, m[n] || {}, { volume: +Math.max(0, g).toFixed(3), mute: false }); p.mix = m; }
  }, { sound: true });
  Layers.apply(); refreshAll({ keepVideo: true });
  toast("Same loudness for " + gains.size + " part" + (gains.size > 1 ? "s" : "") + (together ? ", balance kept." : "."));
}
/** Separate the chosen parts of one track again (e.g. voices left in the music). The app splits just those parts once more. */
async function separateAgain() {
  const list = aselList(), layers = aselLayers();
  if (layers.length !== 1) { toast("Choose parts on one track only (for example the Music parts that still have voices).", true); return; }
  const n = layers[0], locked = list.find(({ p, n: k }) => partLocked(p, k));
  if (locked) { toast(partLocked(locked.p, locked.n), true); return; }
  const move = await askYes("Separate the " + list.length + " chosen " + Layers.TITLE[n] + " part" + (list.length > 1 ? "s" : "") + " again? " +
    "The app splits just these parts once more. What does not belong on " + Layers.TITLE[n] + " (for example singing left in the music) is taken out of them and put on a new track, 'Found again', under the others. " +
    "There you can hear it, turn it up or down, mute it or lock it. Ctrl + Z goes back to the sound before.", "Separate again");
  if (!move) return;
  try {
    await saved();
    const before = snapshot();
    S.resplitUndo = before;
    const r = await api("/api/projects/" + S.id + "/resplit", { method: "POST", json: { layer: n, ranges: list.map(({ p }) => [p.start, p.end]), move_found: true } });
    followResplit(r);
    if (typeof Activity !== "undefined") Activity.refresh();
  } catch (e) { toast(errText(e), true); }
}
function followResplit(r) {
  clearTimeout(S.resplitTimer);
  const n = $("resplitNote");
  if (r.state === "running") {
    if (n) n.textContent = "Separating again… " + Math.round((r.progress || 0) * 100) + "%";
    S.resplitTimer = setTimeout(async () => { try { followResplit(await api("/api/projects/" + S.id + "/resplit")); } catch (e) { /* try later */ } }, 1200);
    return;
  }
  if (r.state === "done" && r.id && S.proj.settings.mix_split !== r.id) {
    const before = S.resplitUndo || snapshot();
    S.proj.settings.mix_split = r.id; S.undo.push(before); S.redo = [];
    S.stemFor = null; Layers.refresh();
    toast("Done. What was taken out is on the new 'Found again' track (under Effects). Ctrl + Z goes back to the sound before.");
  } else if (r.state === "failed") toast(r.error || "Separating again failed.", true);
  if (n) n.textContent = "";
}
function renderStemInspector(R) {
  const list = aselList(), layersIn = aselLayers();
  const nParts = new Set(list.map((x) => x.p)).size;
  R.append(el("div", { class: "side-h" }, el("h2", { text: layersIn.map((k) => Layers.TITLE[k]).join(" + ") }),
    el("span", { class: "note num", text: nParts + (nParts === 1 ? " part" : " parts") })));
  const vols = [...new Set(list.map(({ p, n }) => (p.mix && p.mix[n] ? +p.mix[n].volume : 1)))];
  const mutes = [...new Set(list.map(({ p, n }) => !!(p.mix && p.mix[n] && p.mix[n].mute)))];
  const lk = list.every(({ p, n }) => partLocked(p, n));
  const val = el("b", { class: "num", text: vols.length === 1 ? Math.round(vols[0] * 100) + "%" : "—" });
  const vol = el("input", { type: "range", class: "rng", min: "0", max: "200", step: "1", value: String(Math.round((vols.length === 1 ? vols[0] : 1) * 100)), "aria-label": "Loudness of the chosen parts" });
  vol.addEventListener("input", () => { val.textContent = vol.value + "%"; paintRange(vol); });
  vol.addEventListener("change", () => stemChange((c) => { c.volume = vol.value / 100; c.mute = false; }));
  const mute = el("input", { type: "checkbox", class: "sw", "aria-label": "Mute the chosen parts" });
  mute.checked = mutes.length === 1 && mutes[0]; mute.indeterminate = mutes.length > 1;
  mute.addEventListener("change", () => stemChange((c) => { c.mute = mute.checked; }));
  vol.disabled = mute.disabled = lk;
  const groupsIn = [...new Set(list.map(({ p, n }) => (p.mix && p.mix[n] && p.mix[n].group) || ""))];
  const oneGroup = groupsIn.length === 1 && groupsIn[0] ? soundGroups().find((g) => g.id === groupsIn[0]) : null;
  const lockedN = list.filter(({ p, n }) => partLocked(p, n)).length;
  const pad = el("div", { class: "pad" },
    el("div", { class: "field" }, el("span", {}, "Loudness ", val, el("small", { class: "note", text: " (up to 200%)" })), vol),
    el("label", { class: "swl" }, el("span", { text: "Mute" }), mute),
    el("div", { class: "btns" },
      btn("Same loudness", { icon: "sliders", title: "Each chosen part as a whole goes up or down, so they all sound equally loud (up to 200%). Inside a part nothing changes: for that use Even out.", onclick: () => normaliseParts(false) }),
      btn("Keep balance", { icon: "sliders", cls: "ghost", title: "The chosen parts go up or down together by the same amount, so their balance stays", onclick: () => normaliseParts(true) })),
    el("div", { class: "btns" },
      btn("Full loudness", { icon: "restore", onclick: () => stemChange((c) => { c.mute = false; c.volume = 1; }) }),
      btn("Split", { icon: "split", title: "Split at the playhead (S). The video section is cut there too.", onclick: () => splitAtPlayhead() })),
    evenField(same(list.map(({ p, n }) => (p.mix && p.mix[n] && p.mix[n].even) || 0)), (v) => stemChange((c) => { c.even = v; }), lk),
    fadeFields(same(list.map(({ p, n }) => (p.mix && p.mix[n] && p.mix[n].fin) || 0)), same(list.map(({ p, n }) => (p.mix && p.mix[n] && p.mix[n].fout) || 0)),
      (k, v) => stemChange((c) => { c[k] = v; }), lk),
    layersIn.length === 1 && layersIn[0] !== "found" ? el("div", { class: "btns" }, btn("Separate again", { icon: "layers", title: "Split just these parts once more (for example voices left in the music)", onclick: () => separateAgain() }), el("span", { class: "note", id: "resplitNote" })) : null,
    oneGroup ? el("div", { class: "grp-now" }, dotFor(oneGroup.id), el("span", { text: "Group: " + oneGroup.name }),
      btn(oneGroup.locked ? "Unlock" : "Lock", { icon: oneGroup.locked ? "unlock" : "lock", cls: "sm ghost", onclick: () => groupEdit(oneGroup.id, "lock") }))
      : btn("Group these parts", { icon: "combine", cls: "ghost wide", title: "Give the chosen parts a name, to choose, lock and change them together later", onclick: () => makeGroup() }),
    lockedN ? el("p", { class: "hint warn", text: lockedN + " of these parts " + (lockedN === 1 ? "is" : "are") + " locked (track or group): they stay as they are." }) : null,
    el("p", { class: "hint", text: "Click parts on the sound tracks (Ctrl + click for more, Shift + click for all in between), or a track's name for the whole track. Ctrl + click a second track's name to choose two tracks together. Cuts are shared with the video sections." }));
  R.append(pad);
  if (layersIn.length === 1 && layersIn[0] !== "found") R.append(stemDuckBox(layersIn[0], trackLocked(layersIn[0])));
  const gb = groupsBox(); if (gb) R.append(gb);
  paintRange(vol);
}

// ---- pointer work on the timeline: select, drag to move, drag edges to trim, marquee, scrub
function pieceFromEvent(e) {
  const b = e.target.closest(".clipb");
  return b ? cur()[+b.dataset.k] : null;
}
function showTip(text, x, y) {
  let t = $("tlTip"); if (!t) { t = el("div", { class: "tip", id: "tlTip" }); document.body.append(t); }
  t.textContent = text; t.style.left = (x + 14) + "px"; t.style.top = (y - 34) + "px"; t.hidden = false;
}
function hideTip() { const t = $("tlTip"); if (t) t.hidden = true; }
function selectClick(p, e) {
  if (scenesOn()) { selectScene(p, e); return; }
  const K = kept();
  if (e.shiftKey && S.anchor && K.includes(S.anchor)) {
    const a = K.indexOf(S.anchor), b = K.indexOf(p);
    if (!(e.ctrlKey || e.metaKey)) S.sel.clear();
    for (let k = Math.min(a, b); k <= Math.max(a, b); k++) S.sel.add(K[k]);
  } else if (e.ctrlKey || e.metaKey) {
    if (S.sel.has(p)) S.sel.delete(p); else S.sel.add(p);
    S.anchor = p;
  } else if (!S.sel.has(p)) { S.sel = new Set([p]); S.anchor = p; }
}
function onLaneDown(e) {
  if (e.button !== 0) return;
  const sc = $("tlScroll"), rect = sc.getBoundingClientRect();
  const xIn = (ev) => ev.clientX - rect.left + sc.scrollLeft;
  const p = pieceFromEvent(e);
  const edge = e.target.dataset && e.target.dataset.edge;
  sc.setPointerCapture(e.pointerId);
  if (p && edge && locked()) { lockedNote(); return; }
  if (p && edge) {                                             // trim an edge: it may grow into any footage no other piece uses
    if (!S.sel.has(p)) { S.sel = new Set([p]); S.anchor = p; }
    T.drag = { kind: "trim", p, edge, x0: xIn(e), start: p.start, end: p.end, snap: snapshot(), moved: false, lim: Steps.extendLimits(S.proj.pieces, p, S.info.duration) };
  } else if (p) {                                              // select, maybe move
    const wasSel = S.sel.has(p) && !(e.ctrlKey || e.metaKey || e.shiftKey) && S.sel.size > 1;
    selectClick(p, e);
    T.drag = { kind: "move", p, x0: xIn(e), moved: locked(), wasSel, frozen: locked() };
    renderTimeline(); renderInspector(); renderLengths();
  } else {                                                     // empty space: marquee or seek
    T.drag = { kind: "box", x0: xIn(e), y0: e.clientY, moved: false, add: e.ctrlKey || e.metaKey || e.shiftKey, base: new Set(S.sel) };
  }
  const move = (ev) => {
    const d = T.drag; if (!d) return;
    const x = xIn(ev), dx = x - d.x0;
    if (d.frozen) return;                                      // older steps: click to look, no moving
    if (!d.moved && Math.abs(dx) < 4 && (d.kind !== "box" || Math.abs(ev.clientY - d.y0) < 4)) return;
    d.moved = true;
    if (d.kind === "trim") {
      const ds = dx / S.pps * d.p.speed;
      let stop = false;
      if (d.edge === "l") { const want = d.start + ds; d.p.start = +clamp(want, d.lim.lo, d.end - MIN_PIECE).toFixed(3); stop = want < d.lim.lo - 0.01; }
      else { const want = d.end + ds; d.p.end = +clamp(want, d.start + MIN_PIECE, d.lim.hi).toFixed(3); stop = want > d.lim.hi + 0.01; }
      renderTimeline(); renderLengths();
      showTip((d.edge === "l" ? "Starts at " + fmtTime(d.p.start, 2) : "Ends at " + fmtTime(d.p.end, 2)) + " · piece " + fmtTime(outLen(d.p), 2) + " · video " + fmtTime(finalTotal()) + (stop ? " · stops at the next piece" : ""), ev.clientX, ev.clientY);
    } else if (d.kind === "move") {
      const L = layout().filter((r) => !S.sel.has(r.p));
      let gap = L.length;
      for (let k = 0; k < L.length; k++) if (x < (px(L[k].out0) + px(L[k].out1)) / 2) { gap = k; break; }
      d.gap = gap;
      let mark = $("dropMark"); if (!mark) { mark = el("div", { class: "drop-mark", id: "dropMark" }); $("laneV").append(mark); }
      // where the moved pieces would land, measured on the timeline without them
      let edgeT = 0; for (let k = 0; k < gap; k++) edgeT += L[k].out1 - L[k].out0;
      const firstOut = layout().find((r) => S.sel.has(r.p));
      mark.style.left = (gap === 0 ? px(0) : (L[gap - 1] ? px(L[gap - 1].out1) : px(edgeT))) + "px";
      for (const b of $("laneV").querySelectorAll(".clipb.sel")) b.classList.add("drag");
      const ns = scenesOn() ? chosenScenes().size : 0;
      showTip("Move " + (ns ? ns + " scene" + (ns > 1 ? "s" : "") : S.sel.size + " piece" + (S.sel.size > 1 ? "s" : "")) + " here", ev.clientX, ev.clientY);
      void firstOut;
    } else {
      const a = Math.min(d.x0, x), b = Math.max(d.x0, x);
      let m = $("marquee"); if (!m) { m = el("div", { class: "marquee", id: "marquee" }); $("tlInner").append(m); }
      const lr = $("laneV").getBoundingClientRect(), ir = $("tlInner").getBoundingClientRect();
      m.style.left = a + "px"; m.style.width = (b - a) + "px"; m.style.top = (lr.top - ir.top) + "px"; m.style.height = lr.height + "px";
      const t0 = timeAt(a), t1 = timeAt(b);
      S.sel = new Set(d.base);
      for (const r of layout()) if (r.out1 > t0 && r.out0 < t1) { if (scenesOn()) for (const q of sceneOf(r.p)) S.sel.add(q); else S.sel.add(r.p); }
      for (const bl of $("laneV").querySelectorAll(".clipb")) bl.classList.toggle("sel", S.sel.has(cur()[+bl.dataset.k]));
      renderLengths();
    }
  };
  const up = (ev) => {
    sc.removeEventListener("pointermove", move); sc.removeEventListener("pointerup", up); sc.removeEventListener("pointercancel", up);
    hideTip(); const mark = $("dropMark"); if (mark) mark.remove(); const m = $("marquee"); if (m) m.remove();
    const d = T.drag; T.drag = null; if (!d) return;
    if (d.kind === "trim") {
      if (d.moved) { S.undo.push(d.snap); S.redo = []; markHand(); refreshAll(); scheduleSave(); }
    } else if (d.kind === "move") {
      if (d.moved && !d.frozen && d.gap !== undefined) moveSelected(d.gap);
      else {
        if (d.wasSel) { S.sel = new Set(scenesOn() ? sceneOf(d.p) : [d.p]); S.anchor = d.p; }
        const r = layout().find((q) => q.p === d.p);                   // a click on a piece also moves the playhead there
        if (r) { const tt = timeAt(xIn(ev)); seek(clamp(tt, r.out0, r.out1 - 0.01)); }
        refreshAll({ keepVideo: true });
      }
    } else {
      if (!d.moved) { if (!d.add) S.sel.clear(); seek(timeAt(d.x0)); }
      refreshAll({ keepVideo: true });
    }
  };
  sc.addEventListener("pointermove", move); sc.addEventListener("pointerup", up); sc.addEventListener("pointercancel", up);
}
function moveSelected(gap) {
  change(() => {
    const K = kept(), moving = K.filter((p) => S.sel.has(p)), rest = K.filter((p) => !S.sel.has(p));
    const order = rest.slice(0, gap).concat(moving, rest.slice(gap));
    S.proj.pieces = order.concat(S.proj.pieces.filter((p) => p.off)); markHand();
  });
}
function onRulerDown(e) {
  const sc = $("tlScroll"), rect = sc.getBoundingClientRect();
  const go = (ev) => seek(timeAt(ev.clientX - rect.left + sc.scrollLeft));
  e.stopPropagation(); sc.setPointerCapture(e.pointerId); go(e);
  const move = (ev) => go(ev);
  const up = () => { sc.removeEventListener("pointermove", move); sc.removeEventListener("pointerup", up); };
  sc.addEventListener("pointermove", move); sc.addEventListener("pointerup", up);
}

// ---- timeline actions
function removeSelected() {
  const sel = selList(); if (!sel.length) return;
  const n = scenesOn() ? chosenScenes().size : 0;
  if (change(() => { for (const p of sel) p.off = true; S.sel.clear(); markHand(); }))
    toast((n ? n + " scene" + (n > 1 ? "s" : "") : sel.length + " piece" + (sel.length > 1 ? "s" : "")) + " removed · video now " + fmtTime(finalTotal()) + ". Ctrl + Z brings it back.");
}
function duplicateSelected() {
  const sel = selList(); if (!sel.length) return;
  change(() => {
    const out = [];
    const copies = new Set();
    const scn = scenesOn();
    if (scn) {                                   // a copied scene comes right after its scene, as a scene of its own
      const K = kept(), fresh = new Map();
      let next = Math.max(...K.map((q) => (q.unit === undefined ? -1 : q.unit))) + 1;
      const lastOf = new Map(); for (const q of K) if (S.sel.has(q)) lastOf.set(q.unit, q);
      const pend = new Map();
      for (const q of K) if (S.sel.has(q)) { if (!fresh.has(q.unit)) fresh.set(q.unit, next++); const c = clone(q); c.unit = fresh.get(q.unit); (pend.get(q.unit) || pend.set(q.unit, []).get(q.unit)).push(c); copies.add(c); }
      for (const p of S.proj.pieces) { out.push(p); if (!p.off && lastOf.get(p.unit) === p && pend.has(p.unit)) out.push(...pend.get(p.unit)); }
      S.proj.pieces = out; renumberScenes(); S.sel = copies; markHand();
      return;
    }
    for (const p of S.proj.pieces) { out.push(p); if (S.sel.has(p)) { const c = clone(p); out.push(c); copies.add(c); } }
    S.proj.pieces = out; S.sel = copies; markHand();
  });
}
function splitAtPlayhead() {
  if (locked()) { lockedNote(); return; }
  const at = segAt(S.t); if (!at || at.end) return;
  const { s } = at, p = s.p;
  const cut = p.reverse ? p.end - (S.t - s.out0) * p.speed : p.start + (S.t - s.out0) * p.speed;
  if (cut - p.start < MIN_PIECE || p.end - cut < MIN_PIECE) { toast("Too close to the edge of a piece to split here."); return; }
  change(() => {
    const a = clone(p), b = clone(p);
    if (p.reverse) { a.start = +cut.toFixed(4); b.end = +cut.toFixed(4); } else { a.end = +cut.toFixed(4); b.start = +cut.toFixed(4); }
    const i = S.proj.pieces.indexOf(p);
    S.proj.pieces.splice(i, 1, a, b); S.sel = new Set([b]); S.anchor = b; markHand();
    if (scenesOn() && p.unit !== undefined && p.unit !== null) {          // in Scenes, a split starts a new scene here
      const K = kept(), fresh = Math.max(...K.map((q) => (q.unit === undefined ? -1 : q.unit))) + 1;
      for (let j = K.indexOf(b); j < K.length && K[j].unit === p.unit; j++) K[j].unit = fresh;
      renumberScenes(); S.sel = new Set(sceneOf(b));
    }
  });
}
/** Cut before / Cut after (CapCut's delete left / right): the section under the playhead loses what comes before
 *  (or after) the playhead. The rest of the video moves up to close the gap. */
function cutSide(side, at) {
  if (locked()) { lockedNote(); return; }
  const t = at === undefined ? S.t : at;
  const hit = segAt(t); if (!hit || hit.end && t >= hit.s.out1 - 1e-6) { toast("Put the playhead inside a section first."); return; }
  const { s } = hit, p = s.p;
  const cut = p.reverse ? p.end - (t - s.out0) * p.speed : p.start + (t - s.out0) * p.speed;
  const keepsFront = (side === "after") !== !!p.reverse;            // which end of the footage stays
  if (keepsFront ? cut - p.start < MIN_PIECE : p.end - cut < MIN_PIECE) { toast("That would leave too little of the section."); return; }
  const gone = side === "before" ? t - s.out0 : s.out1 - t;
  change(() => { if (keepsFront) p.end = +cut.toFixed(4); else p.start = +cut.toFixed(4); S.sel = new Set([p]); S.anchor = p; markHand(); });
  const r = layout().find((q) => q.p === p);
  if (r) seek(side === "before" ? r.out0 : Math.max(r.out0, r.out1 - 0.04));
  toast("Cut " + fmtTime(gone, 1) + (side === "before" ? " before" : " after") + " the playhead · video now " + fmtTime(finalTotal()));
}
// ---- Preview: the finished video, live, in the full window (nothing is rendered)
function startPreview(fromStart) {
  if (document.body.classList.contains("previewing")) return;
  const wasEditing = Frame.editing;
  Frame.setEditing(false);
  document.body.classList.add("previewing");
  const range = el("input", { type: "range", class: "rng pv-range", min: "0", max: String(Math.max(0.1, finalTotal())), step: "0.01", value: String(S.t), "aria-label": "Where in the video" });
  const time = el("span", { class: "num pv-time" });
  const playB = btn("", { icon: S.playing ? "pause" : "play", cls: "play", title: "Play / pause (Space)", onclick: () => togglePlay() });
  const bar = el("div", { class: "pv-bar", id: "pvBar" }, playB, time, range,
    btn("From the start", { icon: "stepb", cls: "ghost", onclick: () => { seek(0); play(); } }),
    S.mode === "final" ? btn("Make a preview file", { icon: "film", cls: "ghost", title: "A small, quick video file of the finished video (it shows in Activity and Exports)", onclick: () => { close(); quickPreview(); } }) : null,
    btn("Close", { icon: "x", cls: "ghost", title: "Esc", onclick: () => close() }));
  document.body.append(bar);
  paintRange(range);
  range.addEventListener("input", () => { seek(+range.value); });
  const timer = setInterval(() => {
    time.textContent = fmtTime(S.t) + " / " + fmtTime(finalTotal());
    if (document.activeElement !== range) { range.value = String(S.t); paintRange(range); }
    playB.replaceChildren(icon(S.playing ? "pause" : "play"));
  }, 120);
  const key = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } };
  document.addEventListener("keydown", key, true);
  function close() {
    clearInterval(timer); document.removeEventListener("keydown", key, true);
    bar.remove(); document.body.classList.remove("previewing");
    if (wasEditing && S.mode === "final") Frame.setEditing(true);
    setTimeout(() => { sizeFrame(); Frame.refresh(); }, 30);
  }
  setTimeout(() => { sizeFrame(); Frame.refresh(); }, 30);
  if (fromStart) seek(0);
  play();
}
/** The section showing in the picture becomes the chosen one (a whole scene in Scenes). Ctrl adds it to the chosen ones. */
function pickAtPlayhead(e) {
  const at = segAt(S.t); if (!at) return;
  const p = at.s.p, grp = scenesOn() ? sceneOf(p) : [p];
  if (e && (e.ctrlKey || e.metaKey)) { const on = grp.every((q) => S.sel.has(q)); for (const q of grp) { if (on) S.sel.delete(q); else S.sel.add(q); } }
  else { if (grp.every((q) => S.sel.has(q)) && !S.asel.size) return; S.sel = new Set(grp); }
  S.asel = new Map();
  S.anchor = p;
  refreshAll({ keepVideo: true });
  if (Frame.editing) Frame.renderPanel();
}
/** The right-click menu of the timeline. */
function timelineMenu(e) {
  e.preventDefault();
  const sc = $("tlScroll"), rect = sc.getBoundingClientRect(), t = clamp(timeAt(e.clientX - rect.left + sc.scrollLeft), 0, Math.max(0, rawTotal() - 0.01));
  const lk = locked(), why = "This is an older step, so it is locked.";
  const textEl = e.target.closest(".lane-item.text"), musicEl = e.target.closest(".mrow"), p = pieceFromEvent(e);
  let items;
  if (textEl) {
    const i = +textEl.dataset.i, tx = S.proj.texts[i];
    items = [["Change the words", "type", () => openPanel("text")],
      ["Start here", "clock", () => { change(() => { tx.start = +t.toFixed(2); }, { keepVideo: true }); renderTexts(); renderOverlay(); }],
      ["End here", "clock", () => { change(() => { tx.end = +t.toFixed(2); }, { keepVideo: true }); renderTexts(); renderOverlay(); }],
      "-", ["Delete these words", "trash", () => { change(() => S.proj.texts.splice(i, 1), { keepVideo: true }); renderTexts(); renderOverlay(); }, { danger: true }]];
  } else if (musicEl && musicEl.dataset.i !== undefined) {
    const i = +musicEl.dataset.i, pe = e.target.closest(".mpart");
    if (pe && S.mode === "final" && !(S.msel && S.msel.i === i && S.msel.ks.has(+pe.dataset.k))) { S.sel.clear(); S.asel = new Map(); S.msel = { i, ks: new Set([+pe.dataset.k]) }; refreshAll({ keepVideo: true }); }
    items = [["Sound settings", "sliders", () => openPanel("sound")], "-", ...musicMenuItems(i, t)];
  } else if (p && scenesOn()) {
    if (!S.sel.has(p)) { S.sel = new Set(sceneOf(p)); S.anchor = p; refreshAll({ keepVideo: true }); }
    const n = chosenScenes().size, run = sceneList().find((r) => r.pieces.includes(p));
    items = [["Play this scene", "play", () => { seek(run.out0); play(); }],
      ["Choose more scenes (Ctrl + click)", "check", () => toast("Hold Ctrl and click the other scenes you want.")],
      "-",
      n > 1 ? ["Combine " + n + " scenes into one", "combine", combineScenes, { key: "Ctrl+J", off: lk, why }] : null,
      ["Split the scene here", "split", () => { seek(t); splitAtPlayhead(); }, { key: "S", off: lk, why }],
      [n > 1 ? "Duplicate " + n + " scenes" : "Duplicate this scene", "copy", duplicateSelected, { key: "Ctrl+D", off: lk, why }],
      ["Select all", "grid", () => { S.sel = new Set(kept()); refreshAll({ keepVideo: true }); }, { key: "Ctrl+A" }],
      ["Choose sections instead", "list", () => { S.choose = "sections"; S.sel = new Set([p]); refreshAll({ keepVideo: true }); }],
      "-",
      [n > 1 ? "Remove " + n + " scenes" : "Remove this scene", "trash", removeSelected, { danger: true, key: "Del", off: lk, why }]];
  } else if (p) {
    if (!S.sel.has(p)) { S.sel = new Set([p]); S.anchor = p; refreshAll({ keepVideo: true }); }
    const n = S.sel.size;
    items = [["Play from here", "play", () => { seek(t); play(); }, { key: "Space" }],
      "-",
      ["Split here", "split", () => { seek(t); splitAtPlayhead(); }, { key: "S", off: lk, why }],
      ["Cut before here", "cutb", () => cutSide("before", t), { key: "Q", off: lk, why }],
      ["Cut after here", "cuta", () => cutSide("after", t), { key: "W", off: lk, why }],
      "-",
      [n > 1 ? "Duplicate " + n + " sections" : "Duplicate", "copy", duplicateSelected, { key: "Ctrl+D", off: lk, why }],
      ["Select all", "grid", () => { S.sel = new Set(kept()); refreshAll({ keepVideo: true }); }, { key: "Ctrl+A" }],
      "-",
      [n > 1 ? "Remove " + n + " sections" : "Remove this section", "trash", removeSelected, { danger: true, key: "Del", off: lk, why }]];
  } else {
    items = [["Move the playhead here", "target", () => seek(t)], ["Play from here", "play", () => { seek(t); play(); }],
      "-", ["Select all", "grid", () => { S.sel = new Set(kept()); refreshAll({ keepVideo: true }); }, { key: "Ctrl+A" }],
      ["Undo", "undo", undo, { key: "Ctrl+Z", off: !S.undo.length }], ["Redo", "redo", redo, { key: "Ctrl+Y", off: !S.redo.length }],
      "-", ["Zoom in here", "zin", () => zoomTo(S.pps * 2, t)], ["Show the whole video", "fit", fitZoom]];
  }
  ctxMenu(items, e.clientX, e.clientY);
}
function restorePiece(p) {
  change(() => {
    p.off = false;
    // put it back where it belongs in time, among the pieces that are in the timeline
    const arr = S.proj.pieces.filter((q) => q !== p);
    const K = arr.filter((q) => !q.off);
    const after = K.find((q) => q.start >= p.start);
    arr.splice(after ? arr.indexOf(after) : K.length ? arr.indexOf(K[K.length - 1]) + 1 : 0, 0, p);
    S.proj.pieces = arr; S.sel = new Set([p]); markHand();
  });
}

// ================================================================== left panels
function openPanel(name) {
  if (S.mode === "edit") {                                    // Edit has no tabs: its extra tools are dropdowns on the left
    const d = document.querySelector('details[data-sec="' + name + '"]');
    if (d) { d.open = true; d.scrollIntoView({ block: "nearest" }); if (name === "pattern") renderPattern(); }
    return;
  }
  const tabs = { audio: "sound", format: "frame", media: "sound" };
  name = tabs[name] || name;
  if (!document.querySelector('[data-for="' + name + '"]')) name = "sound";
  S.panel = name;
  for (const b of document.querySelectorAll(".ftabs button")) { const on = b.dataset.panel === name; b.classList.toggle("on", on); b.setAttribute("aria-selected", String(on)); }
  for (const s of document.querySelectorAll("#left [data-for]")) s.hidden = s.dataset.for !== name;
  Frame.setEditing(name === "frame");
  if (name === "text") renderTexts();
  if ($("capAuto")) paintCaptions();
  if (name === "sound") { Layers.open(); renderMusicLayers(); }
  if (name === "frame") { Frame.renderPanel(); renderShape(); }
}
// --- Cut
/** Step 1: the whole parent video cut into pieces of `sec` seconds. */
function parentPieces(sec) {
  const d = S.info.duration;
  const n = Math.ceil(d / sec - 1e-9);
  if (n > 5000) throw new Error("That makes " + n + " pieces; the most is 5,000. Choose longer pieces.");
  const edges = []; for (let k = 0; k < n; k++) edges.push(k * sec); edges.push(d);
  if (edges.length > 2 && edges[edges.length - 1] - edges[edges.length - 2] < 0.08) edges.splice(edges.length - 2, 1);
  const pieces = []; for (let k = 0; k + 1 < edges.length; k++) pieces.push(blankPiece(edges[k], edges[k + 1]));
  return pieces;
}
/** The pieces the newest step starts from: the whole video (step 1) or the pinned step before it, laid end to end. */
function stepBase() { const st = S.proj.steps[S.proj.steps.length - 1]; return st ? st.pieces : null; }
function cutInto(sec) {
  if (!(sec >= MIN_PIECE)) { $("cutNote").textContent = "Write a length of at least 0.1 seconds, for example 2."; return; }
  let pieces;
  try { pieces = stepBase() ? Steps.recut(stepBase(), sec).map(fixPiece) : parentPieces(sec); }
  catch (e) { $("cutNote").textContent = e.message; return; }
  if (!change(() => { S.proj.pieces = pieces; S.proj.rule = { interval: sec, group: 1, picks: [], action: "", hand: false }; S.sel.clear(); S.t = 0; })) return;
  $("cutNote").textContent = Steps.countUnits(pieces) + " pieces of " + sec + " s" + (stepBase() ? ", cut from step " + S.proj.steps.length + "." : ".") + " Undo brings back the old cut.";
  fitZoom();
}
/** The scene separator: one piece per scene (the scene changes are found once per video and kept). */
async function cutAtScenes() {
  const label = $("sceneCutLabel"), b = $("sceneCut");
  b.disabled = true;
  try {
    let st = await api("/api/scenes", { method: "POST", json: { id: S.proj.source } });
    while (st.state === "running" || st.state === "queued") {
      label.textContent = "Finding scenes… " + Math.round(st.progress * 100) + "%";
      await new Promise((r) => setTimeout(r, 800));
      st = await api("/api/scenes?id=" + encodeURIComponent(S.proj.source));
    }
    if (st.state !== "ready") throw new Error(st.error || "The scenes could not be found.");
    const base = stepBase() || [blankPiece(0, S.info.duration)];
    const pieces = Steps.cutAt(base, st.scenes).map(fixPiece);
    const wasThin = stepFlags(S.proj).thin;
    if (!change(() => { S.proj.pieces = pieces; S.proj.rule = { interval: 0, group: 1, picks: [], action: "", hand: true, thin: wasThin }; S.sel.clear(); S.t = 0; })) return;
    $("cutNote").textContent = Steps.countUnits(pieces) + " scenes" + (stepBase() ? " in step " + S.proj.steps.length : "") + ". Undo brings back the old cut.";
    fitZoom();
  } catch (e) { $("cutNote").textContent = errText(e); }
  finally { b.disabled = false; label.textContent = "Cut at scene changes"; }
}
// --- Pattern
const P = { group: 3, picks: new Set([1]) };
function renderPattern() {
  const g = $("patGroup");
  if (!g.firstChild) {
    const box = el("div", { class: "chips" });
    for (const n of [2, 3, 4, 5, 6]) box.append(el("button", { class: "chip", type: "button", "data-n": String(n), text: String(n), onclick: () => { P.group = n; P.picks = new Set([...P.picks].filter((k) => k <= n)); if (!P.picks.size) P.picks.add(1); renderPattern(); } }));
    const custom = el("input", { class: "input short", id: "patCustom", inputmode: "numeric", "aria-label": "Other group size", placeholder: "other" });
    custom.addEventListener("change", () => { const n = Math.round(parseFloat(custom.value)); if (n >= 2 && n <= 50) { P.group = n; P.picks = new Set([...P.picks].filter((k) => k <= n)); if (!P.picks.size) P.picks.add(1); renderPattern(); } });
    box.append(custom); g.append(box);
  }
  for (const c of g.querySelectorAll(".chip")) c.classList.toggle("on", +c.dataset.n === P.group);
  const picks = $("patPicks"); picks.replaceChildren();
  for (let k = 1; k <= P.group; k++) picks.append(el("button", { class: "chip" + (P.picks.has(k) ? " on" : ""), type: "button", text: String(k), "aria-pressed": P.picks.has(k) ? "true" : "false",
    onclick: () => { if (P.picks.has(k)) P.picks.delete(k); else P.picks.add(k); renderPattern(); } }));
  const prev = $("patPreview"); prev.replaceChildren();
  for (let k = 0; k < Math.min(18, P.group * 3); k++) { const on = P.picks.has((k % P.group) + 1); prev.append(el("i", { class: (on ? "on" : "") + (k % P.group === 0 && k ? " gap" : "") })); }
  const K = kept(), hits = patternHits(), hs = new Set(hits);
  const left = K.filter((p) => !hs.has(p));
  const L = (arr) => fmtTime(arr.reduce((a, p) => a + outLen(p), 0));
  $("patNote").textContent = P.picks.size ? Steps.countUnits(hits) + " of " + Steps.countUnits(K) + " pieces match. Removing them leaves " + L(left) + "; keeping only them leaves " + L(hits) + "." : "Tap at least one number.";
  renderRecipes();
}
function patternHits() { return Steps.patternHits(kept(), P.group, [...P.picks]); }
function setRule(action) {
  S.proj.rule = Object.assign({ interval: 0, hand: false }, S.proj.rule || {}, { group: P.group, picks: [...P.picks].sort((a, b) => a - b), action });
}
// --- Steps: stack patterns on the same parent video, nothing rendered in between
function renderSteps() {
  if (!S.proj) return;
  const steps = S.proj.steps, n = steps.length, viewing = S.viewStep === null ? n : S.viewStep;
  for (const box of document.querySelectorAll("[data-steps]")) {
    box.replaceChildren();
    // summary first: which step, its length, and the main action; the list is folded away
    const head = el("div", { class: "steps-head" },
      el("span", { class: "n", text: String(viewing + 1) }),
      el("div", { class: "t" }, el("b", { text: "Step " + (viewing + 1) + (locked() ? " (locked)" : n ? " of " + (n + 1) : "") }),
        el("small", { text: Steps.ruleText(S.viewStep === null ? S.proj.rule : steps[S.viewStep].rule) })),
      el("b", { class: "num len", text: fmtTime(Steps.stepLength(cur())) }),
      locked() ? btn("Edit last", { icon: "edit", cls: "sm", onclick: () => showStep(null) })
        : btn("Pin", { icon: "pin", cls: "sm primary", title: "Pin and add step: lock this result (with your hand edits) and start the next step from it. Nothing is rendered.", onclick: pinStep }));
    box.append(head);
    if (!n) continue;
    const list = el("div", { class: "steps-list" });
    const row = (i, rule, pieces, isNew) => list.append(el("button", { type: "button", class: "step" + ((isNew ? S.viewStep === null : S.viewStep === i) ? " on" : ""),
      title: isNew ? "The step you are editing" : "Look at this step (locked)", onclick: () => showStep(isNew ? null : i) },
      el("span", { class: "n", text: String(i + 1) }), el("span", { class: "t", text: Steps.ruleText(rule) }), el("b", { class: "num", text: fmtTime(Steps.stepLength(pieces)) }), icon(isNew ? "edit" : "lock", "s")));
    steps.forEach((st, i) => row(i, st.rule, st.pieces, false));
    row(n, S.proj.rule, S.proj.pieces, true);
    const det = el("details", { class: "steps-all", open: S.stepsOpen }, el("summary", {}, el("span", { text: "All steps (" + (n + 1) + ")" }), el("span", { class: "note", text: "same original video" }), icon("chev", "chev")),
      list, el("div", { class: "btns" },
        btn("Undo step", { icon: "undo", cls: "ghost sm", title: "Throw away the newest step and edit the one before again", onclick: undoStep }),
        btn("Save steps", { icon: "bookmark", cls: "ghost sm", title: "Keep these steps to use on another video", onclick: saveSteps }),
        btn("New video from step " + (S.viewStep === null ? 1 : S.viewStep + 1), { icon: "copy", cls: "ghost sm",
          title: "Start another project from this step (step 1 is your first pattern cut). This project stays as it is.", onclick: () => forkStep(S.viewStep === null ? 1 : S.viewStep + 1) })));
    det.addEventListener("toggle", () => { S.stepsOpen = det.open; });
    box.append(det);
  }
}
/** Keep the first pattern cut (or any pinned step) for another video: a new project that starts from that step. */
async function forkStep(step) {
  try {
    if (S.saveTimer) saveNow();
    await S.saving;
    const r = await api("/api/projects/" + S.id + "/fork", { method: "POST", json: { step } });
    toast("Made '" + r.project.name + "'. Opening it…");
    setTimeout(() => { location.href = "/edit?p=" + r.project.id; }, 500);
  } catch (e) { toast(errText(e), true); }
}
function showStep(i) {
  if (S.viewStep === i) return;
  pause(); S.viewStep = i; S.sel.clear(); S.t = 0;
  refreshAll(); fitZoom(); if (S.panel === "pattern") renderPattern();
}
function pinStep() {
  if (locked()) { showStep(null); return; }
  if (!kept().length) { toast("The timeline is empty: put a piece back first.", true); return; }
  const n = S.proj.steps.length + 1;
  change(() => {
    S.proj.steps.push({ pieces: clone(S.proj.pieces), rule: S.proj.rule || null, length: +Steps.stepLength(S.proj.pieces).toFixed(3) });
    S.proj.pieces = clone(kept()).map((p) => { delete p.unit; return fixPiece(p); });
    S.proj.rule = null; S.sel.clear(); S.t = 0;
  });
  fitZoom(); openPanel("cut");
  $("cutNote").textContent = "Step " + n + " is pinned. Step " + (n + 1) + " starts from it: choose a piece length and press Cut, then use Pattern.";
  toast("Step " + n + " pinned · step " + (n + 1) + " starts at " + fmtTime(finalTotal()));
}
async function undoStep() {
  if (!S.proj.steps.length) return;
  if (S.viewStep !== null) S.viewStep = null;
  if (!(await askYes("Throw away step " + (S.proj.steps.length + 1) + " and edit step " + S.proj.steps.length + " again? (Ctrl+Z brings it back.)", "Undo step"))) return;
  change(() => { const st = S.proj.steps.pop(); S.proj.pieces = st.pieces.map(fixPiece); S.proj.rule = st.rule; S.sel.clear(); S.t = 0; });
  fitZoom();
}
async function saveSteps() {
  const rules = S.proj.steps.map((st) => st.rule).concat([S.proj.rule]).filter((r) => r && (r.interval || r.action));
  if (!rules.length) { toast("These steps have only hand edits, which cannot be repeated on another video.", true); return; }
  const name = await askText("Name for these steps", "", "for example: 2 s, remove 1 of 3, then 1 s keep 1 of 2");
  if (!name) return;
  S.recipes.push({ name, type: "steps", steps: rules });
  try { await storeRecipes(); toast("Saved '" + name + "'. Hand edits are not part of it."); } catch (e) { S.recipes.pop(); toast(errText(e), true); }
}
/** Repeat saved steps on this video, from the whole video: cut, pattern, pin, cut, pattern ... */
async function useSteps(r) {
  if (locked()) { lockedNote(); return; }
  if (!(await askYes("Start this video's steps over with '" + r.name + "'? (Ctrl+Z brings back what you have now.)", "Use"))) return;
  let pieces, steps = [], last = null;
  try {
    r.steps.forEach((rule, i) => {
      if (i === 0) pieces = parentPieces(rule.interval || S.info.duration + 1);
      else {
        steps.push({ pieces, rule: last, length: +Steps.stepLength(pieces).toFixed(3) });
        const base = clone(pieces.filter((p) => !p.off)).map((p) => { delete p.unit; return p; });
        pieces = rule.interval ? Steps.recut(base, rule.interval) : base;
      }
      if (rule.action) {
        const hits = new Set(Steps.patternHits(pieces.filter((p) => !p.off), rule.group, rule.picks));
        for (const p of pieces.filter((q) => !q.off)) if (rule.action === "remove" ? hits.has(p) : !hits.has(p)) p.off = true;
      }
      last = Object.assign({}, rule, { hand: false });
    });
  } catch (e) { toast(e.message, true); return; }
  change(() => { S.proj.steps = steps; S.proj.pieces = pieces.map(fixPiece); S.proj.rule = last; S.sel.clear(); S.t = 0; });
  fitZoom(); toast("Used '" + r.name + "' · video now " + fmtTime(finalTotal()));
}

// --- saved patterns
function renderRecipes() {
  const box = $("recipeList"); box.replaceChildren();
  if (!S.recipes.length) box.append(el("p", { class: "hint", text: "None saved yet." }));
  S.recipes.forEach((r, i) => box.append(el("div", { class: "item" },
    el("div", { class: "t" }, el("b", { text: r.name }), el("small", { text: r.type === "steps" ? r.steps.length + " steps: " + r.steps.map(Steps.ruleText).join(" → ") : "Pieces " + r.picks.join(", ") + " of every " + r.group + (r.look ? " · with effects" : "") })),
    el("div", { class: "acts" }, btn("Use", { onclick: () => useRecipe(r) }), btn("", { icon: "trash", cls: "ghost", title: "Delete", onclick: async () => {
      if (!(await askYes("Delete the saved pattern '" + r.name + "'?", "Delete", true))) return;
      S.recipes.splice(i, 1); await storeRecipes();
    } })))));
}
async function storeRecipes() { S.recipes = (await api("/api/recipes", { method: "PUT", json: S.recipes })).recipes; renderRecipes(); }
function useRecipe(r) {
  if (r.type === "steps") { useSteps(r); return; }
  if (locked()) { lockedNote(); return; }
  P.group = r.group; P.picks = new Set(r.picks); renderPattern();
  const hits = patternHits();
  if (r.look) change(() => { for (const p of hits) Object.assign(p, clone(r.look), { start: p.start, end: p.end, off: p.off }); S.sel = new Set(hits); });
  else { S.sel = new Set(hits); refreshAll({ keepVideo: true }); }
  toast("Used '" + r.name + "' on " + hits.length + " pieces");
}

// --- Audio
/** The music layers: name, loudness, mute, solo, remove. */
function renderMusicLayers() {
  const box = $("musicLayers"); if (!box) return;
  box.replaceChildren();
  const set = (i, patch, keepVideo) => { if (trackLocked("sound")) { lockedNote("sound"); renderMusicLayers(); return; } change(() => { S.proj.settings.layers = layers().map((x, k) => (k === i ? Object.assign({}, x, patch) : x)); }, { keepVideo: true }); if (keepVideo !== false) { renderMusicLayers(); if (S.playing) musicPlay(); } };
  layers().forEach((x, i) => {
    const name = (S.files.find((f) => f.id === x.file) || { name: x.file.split("/").pop() + " (missing)" }).name;
    const slider = el("input", { type: "range", class: "rng", min: "0", max: "200", step: "1", value: String(Math.round(x.volume * 100)), "aria-label": "Loudness of " + name });
    const val = el("b", { class: "num ly-val", text: Math.round(x.volume * 100) + "%" });
    slider.addEventListener("input", () => { val.textContent = slider.value + "%"; paintRange(slider); const m = MUSIC.get(x.file); if (m) setMusicGain(m, slider.value / 100 * partGain(x, S.t) * duckGain(x, S.t)); });
    slider.addEventListener("change", () => set(i, { volume: slider.value / 100 }, false));
    const mute = el("button", { class: "ly-mute" + (x.mute ? " on" : ""), type: "button", title: "Mute this layer", "aria-label": "Mute " + name, "aria-pressed": String(!!x.mute), onclick: () => set(i, { mute: !x.mute }) }, icon(x.mute ? "mute" : "vol", "s"));
    const solo = el("button", { class: "ly-solo" + (x.solo ? " on" : ""), type: "button", title: "Hear only this layer (and other soloed ones)", "aria-label": "Solo " + name, "aria-pressed": String(!!x.solo), onclick: () => set(i, { solo: !x.solo }), text: "S" });
    const del = el("button", { class: "ly-del", type: "button", title: "Remove this music", "aria-label": "Remove " + name, onclick: () => { change(() => { S.proj.settings.layers = layers().filter((_, k) => k !== i); }, { keepVideo: true }); renderMusicLayers(); musicPlay(); if (!S.playing) musicPause(); } }, icon("x", "s"));
    box.append(el("div", { class: "ly-row" + (heard(x) ? "" : " off") },
      el("span", { class: "ly-ic" }, icon("music")),
      el("div", { class: "ly-main" }, el("div", { class: "ly-top" }, el("b", { class: "ellip", text: name })), el("div", { class: "ly-ctl" }, slider, val)),
      mute, solo, del));
    paintRange(slider);
  });
  if (!layers().length) box.append(el("p", { class: "hint", text: "No music yet." }));
  const note = $("audioNote");
  if (note) note.textContent = soloOn() ? "Solo is on: the video's own sound and the other layers are not heard." : "";
  renderTimeline();
}
/** A small, fast version to check the whole mix; the result shows in Exports with the live meter and the measured loudness. */
async function quickPreview() {
  if (!kept().length) { toast("The timeline is empty: put a piece back first.", true); return; }
  try {
    await saveNow();
    await api("/api/projects/" + S.id + "/render", { method: "POST", json: { preview: true, replace: true } });
    toast("Making a quick preview of the mix"); Exports.show();
  } catch (e) { toast(errText(e), true); }
}
function fillFileSelects() {
  renderMusicLayers();
  const c = $("sCap"), cc = S.proj.settings.captions;
  c.replaceChildren(el("option", { value: "off", text: "Off" }), el("option", { value: "auto", text: "Automatic (listen to the speech)" }));
  for (const f of S.files.filter((x) => x.subtitles)) c.append(el("option", { value: f.id, text: "From " + f.name }));
  if (![...c.options].some((o) => o.value === cc)) c.append(el("option", { value: cc, text: cc.split("/").pop() + " (missing)" }));
  c.value = cc;
  paintCaptions();
}
/** Captions: the Auto switch, the height slider and the guide line in the viewer. */
const CAP_PRESET = { bottom: 6, center: 45, top: 84 };
function capHeight() { const st = S.proj.settings; return st.caption_height === undefined || st.caption_height === null ? CAP_PRESET[st.caption_position] || 6 : +st.caption_height; }
function paintCaptions() {
  const st = S.proj.settings, on = st.captions !== "off";
  $("capAuto").checked = st.captions === "auto";
  const r = $("capHeight"); r.value = String(Math.round(capHeight())); paintRange(r);
  $("capHeightV").textContent = Math.round(capHeight()) + "% from the bottom";
  if (!$("capNote").textContent || $("capNote").dataset.auto) {
    $("capNote").dataset.auto = "1";
    $("capNote").textContent = st.captions === "auto" ? "The captions are written when you export or make a preview (the app listens to the speech)." : on ? "" : "Captions are off.";
  }
  let g = $("capGuide");
  if (!g) { g = el("div", { id: "capGuide", class: "cap-guide" }, el("span", { text: "Captions" })); $("over").append(g); }
  g.hidden = !(on && S.mode === "final" && S.panel === "text");
  g.style.bottom = capHeight() + "%";
}
const BINDS = [["sOrig", "original_sound", "check"], ["sTrans", "transition", "str"], ["sTransS", "transition_s", "num"], ["sFadeIn", "fade_in", "num"], ["sFadeOut", "fade_out", "num"],
  ["sCap", "captions", "str"], ["sCapStyle", "caption_style", "str"], ["sCapPos", "caption_position", "str"], ["sCapSize", "caption_size", "str"],
  ["sNoise", "noise", "str"], ["sVocals", "vocals", "str"], ["sBoost", "voice_boost", "check"], ["sComp", "compress", "check"], ["sBass", "bass", "num"], ["sTreble", "treble", "num"]];
function soundLabels() {
  const db = (v) => (v > 0 ? "+" : "") + Math.round(v) + " dB";
  $("sBassV").textContent = db(+$("sBass").value); $("sTrebleV").textContent = db(+$("sTreble").value);
}
function fillSettings() {
  const st = S.proj.settings;
  for (const [id, key, kind] of BINDS) { const n = $(id); if (kind === "check") n.checked = !!st[key]; else n.value = String(st[key] === undefined ? 0 : st[key]); if (n.classList.contains("rng")) paintRange(n); }
  soundLabels();
  renderShape();
  // Remove noise: four buttons instead of a list (the hidden list still carries the value)
  const ns = $("sNoise");
  $("noiseSeg").replaceChildren(segmented([["off", "Off"], ["light", "Light"], ["medium", "Medium"], ["strong", "Strong"]], ns.value || "off",
    (v) => { ns.value = v; ns.dispatchEvent(new Event("change", { bubbles: true })); }));
}
function bindSettings() {
  for (const [id, key, kind] of BINDS) {
    const n = $(id);
    n.addEventListener("change", () => {
      const v = kind === "check" ? n.checked : kind === "num" ? parseFloat(n.value) : n.value;
      soundLabels();
      change(() => { S.proj.settings[key] = v; }, { keepVideo: true });
      if (key === "original_sound") showFrame();
    });
  }
}
async function addFileThen(kind, progId, done) {
  const bar = $(progId);
  try {
    const data = await chooseFile(kind, (k) => { bar.hidden = false; bar.firstChild.style.width = Math.round(k * 100) + "%"; });
    if (!data) return;
    await loadFiles(); done(data);
  } catch (e) { toast(errText(e), true); }
  finally { bar.hidden = true; }
}
async function loadFiles() { S.files = (await api("/api/files")).files; fillFileSelects(); }
async function beatCut() {
  if (locked()) { lockedNote(); return; }
  if (S.proj.steps.length) { $("beatNote").textContent = "Cutting on the beat works in step 1 (on the whole video). Undo the steps first, or cut by time here."; return; }
  const every = Math.round(parseFloat($("beatEvery").value)), music = layers().length ? layers()[0].file : "";
  if (!music) { $("beatNote").textContent = "Choose the music first, above."; return; }
  if (!(every >= 1)) { $("beatNote").textContent = "Write a whole number of beats, for example 4."; return; }
  $("beatNote").textContent = "Listening for the beat…";
  let b;
  try { b = await api("/api/beats", { method: "POST", json: { input: music } }); } catch (e) { $("beatNote").textContent = errText(e); return; }
  if (!b.beats.length) { $("beatNote").textContent = "No clear beat was found in this music."; return; }
  const d = S.info.duration, edges = [0];
  for (let lap = 0; lap * b.duration < d && lap < 2000; lap++) for (let i = every; i < b.beats.length; i += every) {
    const t = lap * b.duration + b.beats[i];
    if (t - edges[edges.length - 1] >= 0.08 && d - t >= 0.08) edges.push(t);
  }
  edges.push(d);
  const pieces = []; for (let k = 0; k + 1 < edges.length; k++) pieces.push(blankPiece(edges[k], edges[k + 1]));
  change(() => { S.proj.pieces = pieces; S.proj.rule = null; S.sel.clear(); S.t = 0; });
  fitZoom();
  $("beatNote").textContent = pieces.length + " pieces, one every " + every + " beats (about " + Math.round(b.tempo) + " beats a minute)." + (S.proj.settings.transition !== "none" ? " Use a straight cut between pieces to stay on the beat." : "");
}

// --- Format
const SHAPE_CARDS = [["original", "Original", null], ["vertical", "Tall 9:16", 9 / 16], ["square", "Square", 1]];
function renderShape() {
  const sh = S.proj.settings.shape || "original", base = sh.split("_")[0], fill = sh.includes("_") ? sh.split("_")[1] : "middle";
  const box = $("shapeCards"); box.replaceChildren();
  for (const [k, name, a] of SHAPE_CARDS) {
    const ar = a || (S.info.width / S.info.height) || 16 / 9;
    const pic = el("i", { class: "shape-pic" }); pic.style.aspectRatio = String(ar);
    box.append(el("button", { type: "button", class: "mode" + (base === k ? " on" : ""), onclick: () => setShape(k, fill) }, el("span", { class: "pic-box" }, pic), el("b", { text: name })));
  }
  const fb = $("shapeFill"); fb.replaceChildren();
  if (Frame.active(S.proj.settings.frame)) { fb.append(el("p", { class: "hint", text: "The Frame panel sets the shape now (" + Frame.full(S.proj.settings.frame).ratio + "). Reset the frame there to use these." })); return; }
  if (base !== "original") fb.append(segmented([["middle", "Crop"], ["blur", "Whole + blur"], ["follow", "Follow face"]], fill, (v) => setShape(base, v)));
  else fb.append(el("p", { class: "hint", text: "The original keeps the whole picture." }));
}
function setShape(base, fill) {
  const v = base === "original" ? "original" : fill === "middle" ? base : base + "_" + fill;
  change(() => { S.proj.settings.shape = v; }, { keepVideo: true });
  renderShape(); sizeFrame();
}

// --- Text
function renderTexts() {
  const box = $("texts"); box.replaceChildren();
  if (!S.proj.texts.length) box.append(el("p", { class: "hint", text: "No words yet. Add a title or a line of text." }));
  S.proj.texts.forEach((t, i) => {
    const words = el("input", { class: "input", value: t.text, "aria-label": "Words" });
    words.addEventListener("change", () => { const v = words.value.trim(); if (v) change(() => { t.text = v.slice(0, 200); }, { keepVideo: true }); renderOverlay(); });
    const tin = (val, label, set) => { const n = el("input", { class: "input short", value: val, "aria-label": label, inputmode: "decimal" }); n.addEventListener("change", () => { const s = parseTime(n.value); change(() => set(s === null ? 0 : s), { keepVideo: true }); renderTexts(); renderOverlay(); }); return n; };
    const pick = (val, opts, label, set) => { const s = el("select", { "aria-label": label }); for (const [v, n] of opts) s.append(el("option", { value: v, text: n })); s.value = val; s.addEventListener("change", () => { change(() => set(s.value), { keepVideo: true }); renderOverlay(); }); return s; };
    const boxSw = el("input", { type: "checkbox", class: "sw" }); boxSw.checked = t.box;
    boxSw.addEventListener("change", () => { change(() => { t.box = boxSw.checked; }, { keepVideo: true }); renderOverlay(); });
    const card = el("div", { class: "box" },
      el("div", { class: "row" }, words, btn("", { icon: "trash", cls: "ghost", title: "Delete", onclick: () => { change(() => S.proj.texts.splice(i, 1), { keepVideo: true }); renderTexts(); renderOverlay(); } })),
      el("div", { class: "row" }, el("span", { class: "lbl", text: "From" }), tin(fmtTime(t.start), "From", (v) => { t.start = v; }), el("span", { class: "lbl", text: "to" }), tin(t.end > 0 ? fmtTime(t.end) : "", "To (empty = until the end)", (v) => { t.end = v; }), btn("", { icon: "clock", cls: "ghost", title: "Start at the playhead", onclick: () => { change(() => { t.start = +S.t.toFixed(2); }, { keepVideo: true }); renderTexts(); } })),
      el("div", { class: "grid2" },
        pick(t.position, [["top", "Top"], ["center", "Middle"], ["bottom", "Bottom"], ["top_left", "Top left"], ["top_right", "Top right"], ["bottom_left", "Bottom left"], ["bottom_right", "Bottom right"]], "Place", (v) => { t.position = v; }),
        pick(t.size, [["small", "Small"], ["medium", "Medium"], ["large", "Large"], ["huge", "Huge"]], "Size", (v) => { t.size = v; })),
      el("div", { class: "row between" }, pick(t.color, [["white", "White"], ["yellow", "Yellow"], ["black", "Black"], ["red", "Red"], ["blue", "Blue"], ["green", "Green"]], "Colour", (v) => { t.color = v; }), el("label", { class: "swl" }, el("span", { text: "Dark box" }), boxSw)));
    box.append(card);
  });
  enhanceAll(box);
}

// ================================================================== right panel: the selected pieces
function sec(title, ic, open, ...kids) {
  return el("details", { class: "sec", open }, el("summary", {}, icon(ic), el("span", { text: title }), icon("chev", "chev")), el("div", { class: "pad" }, ...kids));
}
function onSel(fn) { change(() => { selList().forEach(fn); markHand(); }, { keepVideo: false }); }
function renderInspector() {
  const R = $("right"), sel = selList();
  const open = new Set([...R.querySelectorAll("details[open] > summary span")].map((s) => s.textContent));
  R.replaceChildren();
  if (S.mode === "final" && S.msel && S.msel.ks.size && layers()[S.msel.i]) { renderMusicInspector(R); return; }
  if (stemsOn() && aselList().length) { renderStemInspector(R); return; }
  if (!sel.length) { renderOverview(R); if (stemsOn()) { const gb = groupsBox(); if (gb) R.append(gb); } return; }
  const len = sel.reduce((a, p) => a + outLen(p), 0);
  const nsc = scenesOn() ? chosenScenes().size : 0;
  R.append(el("div", { class: "side-h" }, el("h2", { text: nsc ? (nsc === 1 ? "1 scene" : nsc + " scenes") : sel.length === 1 ? "Piece" : sel.length + " pieces" }), el("span", { class: "note num", text: fmtTime(len) + " long" })));
  const all = (f) => sel.every(f);
  // basics first: speed, sound, length
  const speeds = [0.25, 0.5, 1, 1.5, 2, 3, 4];
  const cur = all((p) => p.speed === sel[0].speed) ? sel[0].speed : null;
  const chipsBox = el("div", { class: "chips" });
  for (const v of speeds) chipsBox.append(el("button", { class: "chip" + (cur === v ? " on" : ""), type: "button", text: v + "×", onclick: () => onSel((p) => { p.speed = v; }) }));
  const vol = el("input", { type: "range", class: "rng", min: "0", max: "2", step: "0.01", value: String(sel[0].volume), "aria-label": "Loudness" });
  const onSound = (fn) => { if (!change(() => { selList().forEach(fn); markHand(); }, { sound: true })) renderInspector(); };
  vol.addEventListener("change", () => onSound((p) => { p.volume = parseFloat(vol.value); p.mute = false; }));
  const muteSw = el("input", { type: "checkbox", class: "sw" }); muteSw.checked = all((p) => p.mute);
  muteSw.addEventListener("change", () => onSound((p) => { p.mute = muteSw.checked; }));
  vol.disabled = muteSw.disabled = trackLocked("sound");
  const basics = el("div", { class: "pad" }, el("div", { class: "field" }, el("span", { text: "Speed" }), chipsBox));
  const volTxt = el("b", { class: "num", text: Math.round(sel[0].volume * 100) + "%" });
  vol.addEventListener("input", () => { volTxt.textContent = Math.round(vol.value * 100) + "%"; });
  if (S.mode === "final") basics.append(el("div", { class: "field" }, el("span", {}, "Loudness ", volTxt, el("small", { class: "note", text: " (up to 200%)" })), vol), el("label", { class: "swl" }, el("span", { text: "Mute" }), muteSw));
  if (S.mode === "final" && S.info.has_audio && !stemsOn()) basics.append(
    evenField(same(sel.map((p) => p.even || 0)), (v) => onSound((p) => { if (v) p.even = v; else delete p.even; }), trackLocked("sound")),
    fadeFields(same(sel.map((p) => p.fin || 0)), same(sel.map((p) => p.fout || 0)), (k, v) => onSound((p) => { if (v > 0) p[k] = v; else delete p[k]; }), trackLocked("sound"), ["Sound fade in", "Sound fade out"]));
  if (sel.length === 1) basics.append(trimFields(sel[0]));
  if (S.mode === "edit") basics.append(nudgeBox(sel));
  basics.append(el("div", { class: "btns" },
    btn("Split", { icon: "split", onclick: splitAtPlayhead, title: "Split at the playhead (S)" }),
    btn("Duplicate", { icon: "copy", onclick: duplicateSelected }),
    btn("Remove", { icon: "trash", cls: "danger", onclick: removeSelected })));
  R.append(basics);
  if (S.mode !== "final") { enhanceAll(R); return; }            // the Edit stage has no looks, colour, zoom or sound
  // extras, closed until wanted
  const looks = el("div", { class: "looks" });
  for (const [k, name, ic] of LOOKS) {
    const on = all((p) => p.fx.includes(k));
    looks.append(el("button", { type: "button", class: "btn" + (on ? " on" : ""), onclick: () => onSel((p) => { p.fx = p.fx.filter((f) => f !== k); if (!on) p.fx.push(k); }) }, icon(ic, "s"), el("span", { text: name })));
  }
  const back = el("input", { type: "checkbox", class: "sw" }); back.checked = all((p) => p.reverse);
  back.addEventListener("change", () => onSel((p) => { p.reverse = back.checked; }));
  R.append(sec("Effects", "sparkles", open.has("Effects"), looks, el("label", { class: "swl" }, el("span", { text: "Play backwards" }), back)));
  const c0 = sel[0].color;
  const slider = (label, key, min, max, step) => {
    const r = el("input", { type: "range", class: "rng", min: String(min), max: String(max), step: String(step), value: String(c0[key]), "aria-label": label });
    r.addEventListener("change", () => onSel((p) => { p.color = Object.assign({}, p.color, { [key]: parseFloat(r.value) }); }));
    return el("div", { class: "field" }, el("span", { text: label }), r);
  };
  R.append(sec("Colour", "palette", open.has("Colour"), slider("Brightness", "brightness", -0.5, 0.5, 0.05), slider("Contrast", "contrast", 0.5, 2, 0.05), slider("Colour strength", "saturation", 0, 2, 0.05),
    btn("Reset colour", { cls: "ghost", onclick: () => onSel((p) => { p.color = { brightness: 0, contrast: 1, saturation: 1 }; }) })));
  const z = sel[0].zoom;
  const zMode = segmented([["none", "Off"], ["in", "In"], ["out", "Out"], ["hold", "Hold"]], z.mode, (v) => onSel((p) => { p.zoom = { mode: v, amount: p.zoom.amount || 1.3 }; }));
  const zAmt = el("input", { type: "range", class: "rng", min: "1.1", max: "2.5", step: "0.05", value: String(z.amount), "aria-label": "Zoom amount" });
  zAmt.addEventListener("change", () => onSel((p) => { p.zoom = { mode: p.zoom.mode === "none" ? "hold" : p.zoom.mode, amount: parseFloat(zAmt.value) }; }));
  R.append(sec("Zoom", "zoom", open.has("Zoom"), zMode, el("div", { class: "field" }, el("span", { text: "How much" }), zAmt)));
  const f = sel[0].follow;
  const fZoom = el("input", { type: "range", class: "rng", min: "1.2", max: "2.5", step: "0.1", value: String(f.zoom || 1.6), "aria-label": "How close" });
  fZoom.addEventListener("change", () => onSel((p) => { p.follow = Object.assign({}, p.follow, { zoom: parseFloat(fZoom.value) }); }));
  R.append(sec("Follow", "target", open.has("Follow"),
    el("p", { class: "hint", text: "Zoom in and keep a face, or a thing you draw a box around, in the middle. Works with the original shape." }),
    el("div", { class: "btns" },
      btn("Face", { icon: "face", cls: all((p) => p.follow.mode === "face") ? "on" : "", onclick: () => onSel((p) => { p.follow = { mode: "face", zoom: parseFloat(fZoom.value), path: [] }; }) }),
      btn("A thing", { icon: "target", cls: all((p) => p.follow.mode === "object") ? "on" : "", onclick: startDrawBox }),
      btn("Off", { cls: "ghost", onclick: () => onSel((p) => { p.follow = { mode: "none", zoom: p.follow.zoom, path: [] }; }) })),
    el("div", { class: "field" }, el("span", { text: "How close" }), fZoom)));
  enhanceAll(R);
  for (const r of R.querySelectorAll("input.rng")) paintRange(r);
}
/** Edit stage: make the selected sections longer or shorter into the footage around them (never over the next section). */
function nudgeBox(sel) {
  const amt = S.nudge || 0.5;
  const go = (edge, d) => {
    let moved = 0;
    change(() => {
      for (const p of sel) {
        const lim = Steps.extendLimits(S.proj.pieces, p, S.info.duration);
        if (edge === "l") { const v = +clamp(p.start + d, lim.lo, p.end - MIN_PIECE).toFixed(3); if (v !== p.start) { p.start = v; moved++; } }
        else { const v = +clamp(p.end + d, p.start + MIN_PIECE, lim.hi).toFixed(3); if (v !== p.end) { p.end = v; moved++; } }
      }
      markHand();
    });
    if (!moved) toast(d > 0 && edge === "r" || d < 0 && edge === "l" ? "It already touches the next section (or the end of the clip)." : "It is as short as it can be.", true);
  };
  const seg = segmented([[0.1, "0.1 s"], [0.5, "0.5 s"], [1, "1 s"]], amt, (v) => { S.nudge = v; renderInspector(); });
  return el("div", { class: "field nudge" }, el("span", { text: sel.length === 1 ? "Make it longer or shorter" : "Make them longer or shorter" }), seg,
    el("div", { class: "grid2" },
      btn("Start earlier", { icon: "back", onclick: () => go("l", -amt), title: "Show " + amt + " s more before it" }),
      btn("End later", { icon: "fwd", onclick: () => go("r", amt), title: "Show " + amt + " s more after it" }),
      btn("Start later", { cls: "ghost", onclick: () => go("l", amt) }),
      btn("End sooner", { cls: "ghost", onclick: () => go("r", -amt) })));
}
function trimFields(p) {
  const tin = (label, val, set) => {
    const n = el("input", { class: "input", value: fmtTime(val, 2), "aria-label": label, inputmode: "decimal" });
    n.addEventListener("change", () => { const v = parseTime(n.value); if (v === null) { n.value = fmtTime(val, 2); return; } change(() => set(v)); });
    return el("label", { class: "field" }, el("span", { text: label }), n);
  };
  const lim = () => Steps.extendLimits(S.proj.pieces, p, S.info.duration);
  return el("div", { class: "grid2" },
    tin("Starts at", p.start, (v) => { p.start = +clamp(v, lim().lo, p.end - MIN_PIECE).toFixed(3); markHand(); }),
    tin("Ends at", p.end, (v) => { p.end = +clamp(v, p.start + MIN_PIECE, lim().hi).toFixed(3); markHand(); }));
}
function renderOverview(R) {
  const K = kept(), off = cur().filter((p) => p.off);
  const stat = (label, value, strong) => el("div", { class: "stat" }, el("span", { class: "lbl", text: label }), el(strong ? "b" : "span", { class: strong ? "" : "num", text: value }));
  const box = el("div", { class: "box" }, stat("Length", fmtTime(finalTotal()), true));
  if (S.mode === "edit") {
    const scenes = sceneCount();
    box.append(stat("Sections", String(K.length)), stat("Taken out", String(off.length)));
    if (scenes) box.append(stat("Scenes", String(scenes)));
    box.append(stat("The clip", fmtTime(S.info.duration)));
  } else {
    const fr = S.proj.settings.frame;
    box.append(stat("Shape", fr && Frame.active(fr) ? Frame.full(fr).ratio.replace("original", "Original") : ({ original: "Original", vertical: "Tall 9:16", square: "Square" }[(S.proj.settings.shape || "original").split("_")[0]] || "Original")),
      stat("Loudness", "-14 LUFS (YouTube)"), stat("Music layers", String(layers().length)), stat("Pieces", String(K.length)));
  }
  R.append(el("div", { class: "side-h" }, el("h2", { text: S.mode === "edit" ? "This version" : "Your video" })));
  R.append(el("div", { class: "pad" }, box,
    el("p", { class: "hint", text: S.mode === "edit" ? "Click a section in the timeline to make it longer, shorter, or take it out. Ctrl+click or drag across empty space to pick several." : "Click a piece in the timeline for its speed, look, colour and zoom." })));
  const list = el("div", { class: "list" });
  for (const p of off.slice(0, 200)) list.append(el("div", { class: "item" },
    lazyThumb(thumbUrl(S.proj.source, Math.round(p.start + 0.1)), "thumb"),
    el("div", { class: "t" }, el("b", { class: "num", text: fmtTime(p.start) + " – " + fmtTime(p.end) }), el("small", { text: fmtTime(outLen(p)) + " long" })),
    btn("", { icon: "restore", cls: "ghost", title: "Put back", onclick: () => restorePiece(p) })));
  if (off.length > 200) list.append(el("p", { class: "hint", text: "…and " + (off.length - 200) + " more." }));
  const all = btn("Put all back", { icon: "restore", onclick: () => change(() => { for (const p of off) p.off = false; S.proj.pieces.sort((a, b) => a.start - b.start); markHand(); }) });
  R.append(sec("Removed pieces (" + off.length + ")", "trash", false, off.length ? list : el("p", { class: "hint", text: "Nothing removed yet." }), off.length ? all : null));
  R.append(sec("Shortcuts", "info", false,
    ...[["Space", "Play / pause"], ["S", "Split at the playhead"], ["Delete", "Remove selected"], ["Ctrl+Z / Ctrl+Y", "Undo / redo"], ["Ctrl+D", "Duplicate"], ["Ctrl+A", "Select all"], ["← →", "One frame (Shift: one second)"], ["+ / −", "Zoom the timeline"]]
      .map(([k, v]) => el("div", { class: "row between" }, el("span", { class: "kbd", text: k }), el("span", { class: "note", text: v })))));
}

// ---- follow a thing: draw a box on the viewer
function startDrawBox() {
  const sel = selList();
  if (S.proj.settings.shape !== "original") { toast("Follow works with the original shape. Change the shape in Format first, or choose a 'Follow faces' shape there.", true); return; }
  if (!S.info.has_video) return;
  pause();
  const L = layout(), firstOut = L.find((r) => S.sel.has(r.p));
  if (firstOut && !(S.t >= firstOut.out0 && S.t < firstOut.out1)) { S.t = firstOut.out0 + 0.01; showFrame(); }
  $("drawLayer").hidden = false;
  toast("Drag a box tightly around the thing to follow.");
  const layer = $("drawLayer"), bx = $("drawBox");
  let x0 = 0, y0 = 0, r = null;
  const down = (e) => { layer.setPointerCapture(e.pointerId); x0 = e.clientX; y0 = e.clientY; r = null; bx.hidden = false; };
  const move = (e) => {
    if (!layer.hasPointerCapture(e.pointerId)) return;
    const lr = layer.getBoundingClientRect();
    r = { x: Math.min(x0, e.clientX), y: Math.min(y0, e.clientY), w: Math.abs(e.clientX - x0), h: Math.abs(e.clientY - y0) };
    bx.style.left = (r.x - lr.left) + "px"; bx.style.top = (r.y - lr.top) + "px"; bx.style.width = r.w + "px"; bx.style.height = r.h + "px";
  };
  const up = async () => {
    layer.removeEventListener("pointerdown", down); layer.removeEventListener("pointermove", move); layer.removeEventListener("pointerup", up);
    layer.hidden = true; bx.hidden = true;
    if (!r || r.w < 8 || r.h < 8) { toast("That box was too small. Try again."); return; }
    const v = active(), vr = v.getBoundingClientRect(), k = Math.min(vr.width / v.videoWidth, vr.height / v.videoHeight);
    const pw = v.videoWidth * k, ph = v.videoHeight * k, pl = vr.left + (vr.width - pw) / 2, pt = vr.top + (vr.height - ph) / 2;
    const box = { x: clamp((r.x - pl) / pw, 0, 1), y: clamp((r.y - pt) / ph, 0, 1), w: r.w / pw, h: r.h / ph };
    const at = segAt(S.t), srcT = at.s.p.start + (S.t - at.s.out0) * at.s.p.speed;
    const lo = Math.min(...sel.map((p) => p.start)), hi = Math.max(...sel.map((p) => p.end));
    toast("Following it through the selected pieces…");
    try {
      const res = await api("/api/track", { method: "POST", json: { input: S.proj.source, at: clamp(srcT, lo, hi), box, start: lo, end: hi } });
      const zoom = sel[0].follow.zoom || 1.6;
      change(() => sel.forEach((p) => { p.follow = { mode: "object", zoom, path: res.path.filter((pt) => pt[0] >= p.start - 0.5 && pt[0] <= p.end + 0.5) }; }));
      toast("Found it " + Math.round(res.found * 100) + "% of the time" + (res.found < 0.7 ? ". Try a tighter box or fewer pieces." : "."), res.found < 0.7);
    } catch (e) { toast(errText(e), true); }
  };
  layer.addEventListener("pointerdown", down); layer.addEventListener("pointermove", move); layer.addEventListener("pointerup", up);
}

// ================================================================== export
function exportDialog() {
  if (!kept().length) { toast("The timeline is empty: put a piece back first.", true); return; }
  let quality = S.proj.settings.quality || "best";
  const close = () => { scrim.remove(); dlg.remove(); };
  const scrim = el("div", { class: "scrim", onclick: close });
  const sh = S.proj.settings.shape || "original";
  const size = sh.startsWith("vertical") ? "1080×1920" : sh.startsWith("square") ? "1080×1080" : S.info.width + "×" + S.info.height;
  const go = async (preview) => {
    try {
      if (quality !== S.proj.settings.quality) { S.proj.settings.quality = quality; }
      await saveNow();
      await api("/api/projects/" + S.id + "/render", { method: "POST", json: { preview } });
      close(); toast(preview ? "Making a quick preview" : "Exporting your video"); Exports.show();
    } catch (e) { toast(errText(e), true); }
  };
  const dlg = el("div", { class: "dialog", role: "dialog", "aria-label": "Export" },
    el("div", { class: "side-h" }, el("h2", { text: "Export video" }), btn("", { icon: "x", cls: "ghost", title: "Close", onclick: close })),
    el("div", { class: "pad" },
      el("div", { class: "box" },
        el("div", { class: "stat" }, el("span", { class: "lbl", text: "Length" }), el("b", { text: fmtTime(finalTotal()) })),
        el("div", { class: "stat" }, el("span", { class: "lbl", text: "Size" }), el("span", { class: "num", text: size })),
        el("div", { class: "stat" }, el("span", { class: "lbl", text: "Pieces" }), el("span", { class: "num", text: String(kept().length) }))),
      el("div", { class: "field" }, el("span", { text: "Quality" }), segmented([["best", "Best"], ["high", "High"], ["small", "Smaller file"]], quality, (v) => { quality = v; })),
      el("p", { class: "hint", text: "The export is made from your original video, exact to the frame. A quick preview is small and fast, to check everything first." }),
      el("div", { class: "btns" }, btn("Quick preview", { icon: "eye", onclick: () => go(true) }), el("span", { class: "grow" }), btn("Export", { icon: "export", cls: "primary big", onclick: () => go(false) }))));
  document.body.append(scrim, dlg);
}

// ================================================================== other projects (Media panel)
function projItem(p, cur) {
  const tag = p.version ? p.version.charAt(0).toUpperCase() + p.version.slice(1) + " · " : "";
  return el("div", { class: "item" + (cur ? " on" : ""), onclick: () => { location.href = (p.stage === "final" ? "/final" : "/edit") + "?p=" + p.id; } },
    icon("layers"), el("div", { class: "t" }, el("b", { text: p.name }), el("small", { text: tag + fmtTime(p.length, 0) + " · " + p.pieces + " sections" })), icon("chevr", "s"));
}

// ================================================================== open a project
async function openProject() {
  let r;
  try { r = await api("/api/projects/" + S.id); }
  catch (e) { location.replace("/?msg=" + encodeURIComponent(errText(e))); return; }
  S.proj = r.project; S.info = r.info;
  const stage = S.proj.stage === "final" ? "final" : "edit";
  if (stage !== S.mode) { location.replace("/" + stage + "?p=" + S.id); return; }       // the project belongs to the other stage
  applyStage();
  S.proj.pieces.forEach(fixPiece); if (!Array.isArray(S.proj.texts)) S.proj.texts = [];
  if (!Array.isArray(S.proj.steps)) S.proj.steps = [];
  for (const st of S.proj.steps) st.pieces.forEach(fixPiece);
  const st0 = S.proj.settings;                                  // a single old music file becomes the first music layer
  if (!Array.isArray(st0.layers)) st0.layers = [];
  if (st0.music && !st0.layers.length) { st0.layers = [{ file: st0.music, volume: st0.music_volume === undefined ? 0.25 : st0.music_volume, mute: false, solo: false }]; st0.music = ""; S.migrated = true; }
  $("suite").hidden = false;
  $("projName").value = S.proj.name;
  $("srcName").textContent = S.proj.source.split("/").pop();
  $("srcFacts").textContent = fmtTime(S.info.duration, 0) + (S.info.has_video ? " · " + S.info.width + "×" + S.info.height : " · sound only");
  $("srcWhere").textContent = S.info.where ? "Used where it is (not copied): " + S.info.where : "A copy kept by the app.";
  if (S.info.has_video) $("srcThumb").src = thumbUrl(S.proj.source, 1);
  document.title = S.proj.name + " · " + APP_NAME;
  // the live viewer jumps around a lot, so it uses the light copy (fast to seek, plays everywhere)
  const ready = S.info.preview && S.info.preview.state === "ready";
  if (ready) setSource(mediaUrl(S.proj.source, true));
  else {
    if (S.info.plays_in_browser) setSource(mediaUrl(S.proj.source, false));
    banner("Preparing smooth playback…", 0);
    const swap = (url) => { const t = S.t; V.src = ""; setSource(url); S.t = t; for (const v of [V.a, V.b]) v.addEventListener("loadeddata", () => showFrame(), { once: true }); };
    let quick = false;
    ensurePreview(S.proj.source, S.info, (st) => {
      if (st.state === "running") banner((S.info.plays_in_browser || quick ? "Preparing smoother playback… " : "This file needs a light copy to play here (" + S.info.playback_note + "). Preparing… ") + Math.round(st.progress * 100) + "%", st.progress);
      if (st.state === "failed") banner("A light copy could not be made: " + st.error, 0);
    }, true, () => { if (!S.info.plays_in_browser) { quick = true; swap(mediaUrl(S.proj.source, "q")); } }).then((ok) => { if (ok) { const t = S.t; V.src = ""; setSource(mediaUrl(S.proj.source, true)); S.t = t; for (const v of [V.a, V.b]) v.addEventListener("loadeddata", () => showFrame(), { once: true }); banner(null); } });
  }
  bindSettings(); fillSettings(); Layers.init();
  Frame.init({ host: $("frame"), video: active, srcAspect: S.info.width && S.info.height ? S.info.width / S.info.height : 16 / 9,
    get: effectiveFrame, set: storeFrame, scope: placeScopeInfo, resetPlace,
  });
  sizeFrame(); new ResizeObserver(() => { sizeFrame(); renderTimeline(); }).observe($("stage"));
  setTimeout(fitZoom, 0);
  refreshAll();
  loadFiles().catch(() => {});
  api("/api/recipes").then((x) => { S.recipes = x.recipes; renderRecipes(); }).catch(() => {});
  api("/api/projects").then(({ projects }) => { const pl = $("projList"); for (const p of projects.filter((q) => q.id !== S.id && !q.trashed && !q.missing && (q.stage || "edit") === S.mode).slice(0, 30)) pl.append(projItem(p)); if (!pl.children.length) pl.append(el("p", { class: "hint", text: "No other projects." })); }).catch(() => {});
  if (S.mode === "edit") renderVersionList(); else openPanel("sound");
  loadPeaks();
  if (S.mode === "edit") { try { const r = await api("/api/projects/" + S.id + "/task"); followTask(r.task); } catch (e) { /* only a help */ } }
  renderSteps();
  if (S.migrated) { S.migrated = false; scheduleSave(); }
  $("saveState").textContent = "Saved";
}
function banner(text, k) {
  const b = $("banner"); if (!text) { b.hidden = true; return; }
  b.hidden = false; $("bannerText").textContent = text; $("bannerBar").style.width = Math.round((k || 0) * 100) + "%";
}

// ================================================================== Edit stage: the three buttons
async function saved() { if (S.saveTimer) saveNow(); await S.saving; }
function secNote(t, bad) { const n = $("secNote"); n.textContent = t || ""; n.classList.toggle("bad", !!bad); }
async function secCall(action) {
  await saved();
  return api("/api/projects/" + S.id + "/sections", { method: "POST", json: { action, pieces: S.proj.pieces, steps: S.proj.steps } });
}
/** Versions of the same clip: the clip itself and the Odd / Even versions made from it. */
async function renderVersionList() {
  const box = $("secVersionList");
  try {
    const { projects } = await api("/api/projects");
    const root = S.proj.parent && projects.some((p) => p.id === S.proj.parent && (p.stage || "edit") === "edit") ? S.proj.parent : S.id;
    const rel = projects.filter((p) => !p.trashed && !p.missing && (p.stage || "edit") === "edit" && (p.id === root || p.parent === root));
    rel.sort((a, b) => (a.id === root ? -1 : b.id === root ? 1 : String(a.name).localeCompare(String(b.name), undefined, { numeric: true })));
    box.replaceChildren();
    for (const p of rel) {
      const on = p.id === S.id, tag = p.id === root ? "Clip" : p.version ? p.version.charAt(0).toUpperCase() + p.version.slice(1) : "Version";
      const pic = el("span", { class: "vpic" }); if (S.info.has_video) pic.append(lazyThumb(thumbUrl(S.proj.source, Math.max(0, Math.round(p.thumb_at || 1))), "", true));
      box.append(el("button", { type: "button", class: "vcard" + (on ? " on" : ""), onclick: on ? null : async () => { await saved(); location.href = "/edit?p=" + p.id; } },
        pic, el("span", { class: "t" }, el("span", { class: "vtag" + (p.id === root ? "" : " " + (p.version || "")), text: tag }), el("b", { class: "ellip", text: p.name }),
          el("small", { text: fmtTime(p.length, 0) + " · " + p.pieces + " sections" }), p.done ? stepTicks(on ? Object.assign({}, p.done, stepFlags(S.proj)) : p.done) : null,
          p.sent ? el("small", { class: "vnext good", text: "In Final" }) : null),
        on ? el("span", { class: "pill", text: "Open" }) : icon("chevr", "s")));
    }
    const me = projects.find((p) => p.id === S.id);
    S.madeVersions = !!(me && me.done && me.done.made_versions);
    S.sentTo = (me && me.sent) || "";
    renderStepbar();
    $("verCount").textContent = rel.length > 1 ? rel.length + " versions" : "";
    $("verHint").hidden = rel.length > 1;
  } catch (e) { /* the list is only a help */ }
}
/** Scenes found by step 3: sections that share a scene number. (After step 2 every section has its own number, so that is not scenes.) */
function sceneCount() {
  const K = kept(), units = new Set(K.map((p) => p.unit).filter((u) => u !== undefined && u !== null));
  if (S.viewStep === null && S.proj.rule && S.proj.rule.scenes) return units.size;
  return units.size && units.size < K.length ? units.size : 0;
}
/** Which Edit steps were already done on a version (the same rule as step_flags in project.py). */
function stepFlags(d) {
  const rules = (d.steps || []).map((st) => st && st.rule).concat([d.rule]).filter((r) => r && typeof r === "object");
  const thin = rules.some((r) => r.thin || (r.interval === 1 && r.group === 4 && r.action === "remove"));
  return { versions: !!d.version, thin, scenes: !!(d.rule && d.rule.scenes) };
}
/** Which steps are done on this version: shown on the step bar (a tick), so nothing is done twice by mistake. */
function renderStepbar() {
  if (S.mode !== "edit") return;
  const P = S.proj.pieces, rule = S.proj.rule || {}, f = stepFlags(S.proj);
  const done1 = f.versions || !!S.madeVersions, done2 = f.thin, scenes = sceneCount(), done3 = scenes > 0 || f.scenes;
  const mark = (id, done, txt) => { const b = $(id); b.classList.toggle("done", done); if (txt) b.querySelector("small").textContent = txt; };
  const gone = P.filter((p) => p.off).length;
  mark("secVersions", done1, f.versions ? "done · this is the " + S.proj.version + " version" : done1 ? "done · Odd and Even are made (left)" : "2 s sections, two versions");
  mark("secThin", done2, done2 ? "done" + (rule.interval === 1 && gone ? " · " + gone + " seconds taken out" : " on this version") : "keep 1 2 3, cut 4 …");
  mark("secScenes", done3, done3 ? "done · " + (scenes || "") + (scenes === 1 ? " scene" : scenes ? " scenes" : "scenes separated") : "cut where each scene ends");
  mark("secFinal", !!S.sentTo, S.sentTo ? "done · click to open it in Final" : "sound, picture, export");
  // the step to do now is lit, so it is always clear where this version stands
  const order = [["secVersions", done1], ["secThin", done2], ["secScenes", done3], ["secFinal", !!S.sentTo]];
  const next = S.madeVersions && !f.versions ? "" : (order.find(([, d]) => !d) || [""])[0];
  for (const [id] of order) $(id).classList.toggle("next", id === next);
  if (S.madeVersions && !f.versions && !$("secNote").textContent) secNote("Odd and Even are made from this clip. Open one of them on the left and go on with step 2.");
}
/** The small 1 2 3 ticks of a version card: which steps it has had. */
function stepTicks(f) {
  const t = (n, on, what) => el("i", { class: on ? "done" : "", title: what + (on ? ": done" : ": not yet"), text: String(n) });
  return el("span", { class: "vsteps" }, t(1, f.versions || f.made_versions, "Odd / Even versions"), t(2, f.thin, "Remove every 4th second"), t(3, f.scenes, "Separate scenes"));
}
async function secVersions() {
  const f = stepFlags(S.proj);
  // never twice: a second pair would be the same two videos again
  if (S.madeVersions) { toast("Step 1 is done: Odd and Even are already made from this clip. Open one of them on the left."); return; }
  if (f.versions) { toast("Step 1 is done: this is already the " + S.proj.version + " version. Go on with the next step."); return; }
  const b = $("secVersions"); b.disabled = true; secNote("Making the versions…");
  try {
    const r = await secCall("versions");
    const odd = r.versions.find((v) => v.version === "odd"), even = r.versions.find((v) => v.version === "even");
    secNote("Made '" + odd.name + "' and '" + even.name + "'. Click one on the left to work on it.");
    await renderVersionList();
  } catch (e) { secNote(errText(e), true); }
  finally { b.disabled = false; }
}
async function secThin() {
  if (locked()) { lockedNote(); return; }
  if (stepFlags(S.proj).thin) { toast("Step 2 is already done on this version. To change it, press Ctrl + Z (Undo) first."); return; }
  const b = $("secThin"); b.disabled = true; secNote("Cutting…");
  try {
    const r = await secCall("thin");
    r.pieces.forEach(fixPiece); r.steps.forEach((st) => st.pieces.forEach(fixPiece));
    change(() => { S.proj.steps = r.steps; S.proj.pieces = r.pieces; S.proj.rule = r.rule; S.sel.clear(); S.t = 0; });
    fitZoom();
    secNote(r.sections - r.removed + " sections kept, " + r.removed + " taken out · video now " + fmtTime(finalTotal()) + ". Undo brings the old one back.");
  } catch (e) { secNote(errText(e), true); }
  finally { b.disabled = false; }
}
/** Separate scenes: the app does it in the background (one video at a time, the others wait in line), so you can
 *  open other projects meanwhile. The result is put into this project also when this page is closed. */
async function secScenes() {
  if (locked()) { lockedNote(); return; }
  if ((sceneCount() > 0 || stepFlags(S.proj).scenes) && !(await askYes("The scenes are already separated on this version. Separate them again? (Your scene changes are replaced.)", "Separate again"))) return;
  try {
    await saved();
    const t = await api("/api/projects/" + S.id + "/scenes", { method: "POST", json: {} });
    followTask(t);
    if (typeof Activity !== "undefined") Activity.refresh();
  } catch (e) { secNote(errText(e), true); }
}
function followTask(t) {
  S.task = t;
  clearTimeout(S.taskTimer);
  const b = $("secScenes"), label = $("secScenesLabel");
  if (t.state === "running" || t.state === "queued") {
    S.waiting = true; b.disabled = true; document.body.classList.add("is-waiting");
    const pct = Math.round((t.progress || 0) * 100);
    label.textContent = t.state === "queued" ? "Waiting in line" + (t.place ? " (" + t.place + ")" : "") + "…" : "Separating scenes… " + pct + "%";
    secNote("");
    const n = $("secNote");
    n.append(el("span", { text: t.state === "queued" ? "Other videos are being looked at first. " : "Looking at every picture. " }),
      el("span", { text: "You can open other projects meanwhile: the scenes are put in here when they are ready. " }),
      el("button", { type: "button", class: "linkbtn", id: "taskStop", text: "Stop", onclick: async () => { const r = await api("/api/projects/" + S.id + "/scenes-stop", { method: "POST", json: {} }); followTask(r); secNote("Stopped. Nothing was changed."); } }));
    if (!S.wasWaiting) renderTimeline();
    S.wasWaiting = true;
    S.taskTimer = setTimeout(async () => {
      try { const r = await api("/api/projects/" + S.id + "/task"); followTask(r.task); } catch (e) { S.taskTimer = setTimeout(() => followTask(S.task), 3000); }
    }, 1000);
    return;
  }
  const was = S.waiting;
  S.waiting = false; S.wasWaiting = false; b.disabled = false; label.textContent = "Separate scenes"; document.body.classList.remove("is-waiting");
  if (t.state === "done" && (was || !t.seen)) takeScenes(t);
  else if (t.state === "failed" && (was || !t.seen)) { secNote(t.error || "The scenes could not be found.", true); api("/api/projects/" + S.id + "/task-seen", { method: "POST", json: {} }).catch(() => {}); }
  else if (was) refreshAll({ keepVideo: true });
}
/** The scenes are in (put in by the app): load them, and keep the cut from before for Undo. */
async function takeScenes(t) {
  try {
    const r = await api("/api/projects/" + S.id);
    const done = r.project.task_done || {};
    const before = snapshot();
    const old = done.before ? JSON.stringify(Object.assign(JSON.parse(before), { pieces: done.before })) : before;
    S.proj.pieces = r.project.pieces.map(fixPiece); S.proj.rule = r.project.rule;
    S.undo.push(old); S.redo = [];
    S.sel.clear(); S.t = 0;
    await api("/api/projects/" + S.id + "/task-seen", { method: "POST", json: {} });
    refreshAll(); fitZoom();
    secNote(t.scenes + (t.scenes === 1 ? " scene" : " scenes") + " separated. Each cut is at the end of a scene. Click a scene to choose it (Ctrl + click for more). Undo brings the old cut back.");
  } catch (e) { secNote(errText(e), true); }
}
async function sendToFinal() {
  if (!kept().length) { toast("The timeline is empty: put a section back first.", true); return; }
  try {
    await saved();
    const r = await api("/api/projects/" + S.id + "/to-final", { method: "POST", json: {} });
    toast(r.existing ? "'" + r.project.name + "' is already in Final. Opening it…" : "Sent '" + r.project.name + "' to Final. Opening it…");
    setTimeout(() => { location.href = "/final?p=" + r.project.id; }, 500);
  } catch (e) { toast(errText(e), true); }
}
/** Show only the tools of this page's stage. */
function applyStage() {
  for (const n of document.querySelectorAll("[data-stage]")) n.hidden = n.dataset.stage !== S.mode;
  document.body.classList.toggle("stage-final", S.mode === "final");
  document.body.classList.toggle("stage-edit", S.mode === "edit");
  $("suite").classList.add(S.mode === "final" ? "final" : "edit");
}

// ================================================================== wiring
function wire() {
  for (const b of document.querySelectorAll(".ftabs button")) b.addEventListener("click", () => openPanel(b.dataset.panel));
  for (const d of document.querySelectorAll('details[data-sec="pattern"]')) d.addEventListener("toggle", () => { if (d.open) renderPattern(); });

  $("projName").addEventListener("change", () => { const v = $("projName").value.trim(); if (v) change(() => { S.proj.name = v; }, { keepVideo: true }); });
  // cut
  const chips = segmented([[1, "1 s"], [2, "2 s"], [3, "3 s"], [5, "5 s"], [10, "10 s"]], 2, (v) => { $("cutSec").value = String(v); });
  $("cutChips").append(chips);
  $("sceneCut").addEventListener("click", cutAtScenes);
  $("secVersions").addEventListener("click", secVersions); $("secThin").addEventListener("click", secThin);
  $("secScenes").addEventListener("click", secScenes); $("secFinal").addEventListener("click", sendToFinal);
  $("cutBtn").addEventListener("click", async () => {
    if (locked()) { lockedNote(); return; }
    const sec = parseFloat(String($("cutSec").value).replace(",", "."));
    const edited = S.proj.pieces.length > 1 && (S.proj.pieces.some((p) => p.off || p.speed !== 1 || p.fx.length) || S.undo.length);
    if (edited && !(await askYes("Cutting again starts the pieces of this step over. Undo brings back what you have now.", "Cut again"))) return;
    cutInto(sec);
  });
  // pattern
  $("patRemove").addEventListener("click", () => { const h = patternHits(); if (!h.length) return; if (!change(() => { for (const p of h) p.off = true; S.sel.clear(); setRule("remove"); })) return; renderPattern(); toast(Steps.countUnits(h) + " pieces removed · video now " + fmtTime(finalTotal())); });
  $("patKeep").addEventListener("click", () => { const h = new Set(patternHits()); if (!h.size) return; const gone = kept().filter((p) => !h.has(p)); if (!change(() => { for (const p of gone) p.off = true; S.sel.clear(); setRule("keep"); })) return; renderPattern(); toast(Steps.countUnits(gone) + " pieces removed · video now " + fmtTime(finalTotal())); });
  $("patSelect").addEventListener("click", () => { S.sel = new Set(patternHits()); refreshAll({ keepVideo: true }); });
  $("recipeSave").addEventListener("click", async () => {
    const name = await askText("Name for this pattern", "", "for example: remove 1st of every 3");
    if (!name) return;
    const first = selList()[0];
    let look = null;
    if (first) { look = clone(first); delete look.start; delete look.end; delete look.off; if (look.follow.mode === "object") look.follow = { mode: "none", zoom: look.follow.zoom, path: [] }; }
    S.recipes.push({ name: name.trim(), group: P.group, picks: [...P.picks].sort((a, b) => a - b), look });
    try { await storeRecipes(); toast("Saved '" + name.trim() + "'"); } catch (e) { S.recipes.pop(); toast(errText(e), true); }
  });
  // audio, text, format
  $("musicAdd").addEventListener("click", () => addFileThen("audio", "musicProg", (d) => {
    if (d.has_video) { toast("That is a video. Choose a music file such as an MP3.", true); return; }
    if (layers().length >= 8) { toast("That is the most: 8 music layers.", true); return; }
    change(() => { S.proj.settings.layers = layers().concat([{ file: d.id, volume: 0.2, mute: false, solo: false, auto: 1, duck: { on: true, level: 0.5 } }]); }, { keepVideo: true });
    renderMusicLayers(); if (S.playing) musicPlay();
    autoSongLevel(d.id);
  }));
  $("checkMix").addEventListener("click", soundCheck);
  $("beatBtn").addEventListener("click", beatCut);
  for (const id of ["sBass", "sTreble"]) $(id).addEventListener("input", soundLabels);
  paintFollow();
  $("bFollow").addEventListener("click", () => {
    S.follow = !S.follow; paintFollow();
    try { localStorage.setItem("ef.follow", S.follow ? "1" : "0"); } catch (e) { /* not kept */ }
    toast(S.follow ? "Follow on: the timeline moves along with the video." : "Follow off: the timeline stays where you put it.");
    followPlayhead();
  });
  $("capAuto").addEventListener("change", () => { change(() => { S.proj.settings.captions = $("capAuto").checked ? "auto" : "off"; }, { keepVideo: true }); $("capNote").textContent = ""; fillFileSelects(); });
  $("capHeight").addEventListener("input", () => { $("capHeightV").textContent = $("capHeight").value + "% from the bottom"; paintRange($("capHeight")); const g = $("capGuide"); if (g) { g.hidden = false; g.style.bottom = $("capHeight").value + "%"; } });
  $("capHeight").addEventListener("change", () => { change(() => { S.proj.settings.caption_height = +$("capHeight").value; }, { keepVideo: true }); paintCaptions(); });
  $("sCapPos").addEventListener("change", () => { delete S.proj.settings.caption_height; setTimeout(paintCaptions, 0); });
  $("sCap").addEventListener("change", () => { $("capNote").textContent = ""; setTimeout(paintCaptions, 0); });
  $("capAdd").addEventListener("click", () => addFileThen("subtitles", "musicProg", (d) => {
    if (!d.subtitles) { toast("That is not a subtitle file (.srt or .vtt).", true); return; }
    change(() => { S.proj.settings.captions = d.id; }, { keepVideo: true }); fillFileSelects(); $("capNote").textContent = d.words + " words found.";
  }));
  $("addText").addEventListener("click", () => {
    change(() => S.proj.texts.push({ text: "Your words", start: +S.t.toFixed(2), end: +Math.min(S.t + 3, rawTotal()).toFixed(2), position: "bottom", size: "medium", color: "white", box: true }), { keepVideo: true });
    renderTexts(); renderOverlay();
    const cards = $("texts").querySelectorAll(".box"), w = cards.length && cards[cards.length - 1].querySelector(".input"); if (w) { w.focus(); w.select(); }
  });
  // transport
  $("tPlay").addEventListener("click", togglePlay);
  $("tStart").addEventListener("click", () => seek(0));
  $("tEnd").addEventListener("click", () => seek(rawTotal()));
  const frame = () => 1 / (S.info.fps_float || 25);
  $("tBack").addEventListener("click", () => seek(S.t - frame()));
  $("tFwd").addEventListener("click", () => seek(S.t + frame()));
  $("tMute").addEventListener("click", () => { S.mutedAll = !S.mutedAll; $("tMute").replaceChildren(icon(S.mutedAll ? "mute" : "vol")); showFrame(); musicMute(); });
  $("frame").addEventListener("click", (e) => { if (e.target.closest("#drawLayer")) return; if (!Frame.editing) togglePlay(); });
  // a press on the picture chooses the section that is showing there (also before dragging it in Picture)
  $("frame").addEventListener("pointerdown", (e) => { if (e.button === 0 && !e.target.closest("#drawLayer")) pickAtPlayhead(e); }, true);
  // timeline
  $("tlScroll").addEventListener("pointerdown", (e) => { if (e.button === 0 && !e.target.closest(".mrow")) S.msel = null; if (e.button === 0 && S.mode === "final" && e.target.closest(".mpart")) { onMusicDown(e); return; } if (e.button === 0 && e.target.closest(".lane.stem")) { onStemDown(e); return; } if (e.target.closest(".lane-head, .mrow")) return;
    if (S.asel.size && e.target.closest("#laneV")) S.asel = new Map(); if (e.target.closest("#ruler")) onRulerDown(e); else onLaneDown(e); });
  let raf = 0; $("tlScroll").addEventListener("scroll", () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(renderTimeline); });
  $("tlScroll").addEventListener("wheel", (e) => {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); const r = $("tlScroll").getBoundingClientRect(); zoomTo(S.pps * (e.deltaY < 0 ? 1.2 : 1 / 1.2), timeAt(e.clientX - r.left + $("tlScroll").scrollLeft)); }
    else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      // over the tracks: up and down when they do not all fit (Shift + wheel: left and right), else left and right
      const sc = $("tlScroll"), tall = sc.scrollHeight > sc.clientHeight + 2;
      e.preventDefault();
      if (tall && !e.shiftKey) sc.scrollTop += e.deltaY; else sc.scrollLeft += e.deltaY;
    }
  }, { passive: false });
  $("zoom").addEventListener("input", () => { const t = S.t; setZoomFromSlider(); renderTimeline(); void t; });
  $("bZoomIn").addEventListener("click", () => zoomTo(S.pps * 1.5));
  $("bZoomOut").addEventListener("click", () => zoomTo(S.pps / 1.5));
  $("bFit").addEventListener("click", fitZoom);
  $("bUndo").addEventListener("click", undo); $("bRedo").addEventListener("click", redo);
  $("bSplit").addEventListener("click", splitAtPlayhead);
  $("bCombine").addEventListener("click", combineScenes);
  $("lockV").addEventListener("click", () => toggleLock("video")); $("lockA").addEventListener("click", () => toggleLock("sound"));
  try { if (localStorage.getItem("ef.choose") === "sections") S.choose = "sections"; } catch (e) { /* off */ }
  $("bCutB").addEventListener("click", () => cutSide("before")); $("bCutA").addEventListener("click", () => cutSide("after"));
  $("tlScroll").addEventListener("contextmenu", (e) => { if (stemMenu(e)) return; if (e.target.closest(".lane-head")) { e.preventDefault(); return; } timelineMenu(e); });
  $("frame").addEventListener("contextmenu", (e) => {
    e.preventDefault();
    ctxMenu([[S.playing ? "Pause" : "Play", S.playing ? "pause" : "play", togglePlay, { key: "Space" }], "-",
      ["Split here", "split", splitAtPlayhead, { key: "S", off: locked() }],
      ["Cut before the playhead", "cutb", () => cutSide("before"), { key: "Q", off: locked() }],
      ["Cut after the playhead", "cuta", () => cutSide("after"), { key: "W", off: locked() }],
      "-", ["Undo", "undo", undo, { key: "Ctrl+Z", off: !S.undo.length }], ["Redo", "redo", redo, { key: "Ctrl+Y", off: !S.redo.length }]], e.clientX, e.clientY);
  }); $("bDup").addEventListener("click", duplicateSelected); $("bDel").addEventListener("click", removeSelected);
  // resize the timeline by dragging its top edge
  $("tlResize").addEventListener("pointerdown", (e) => {
    const h0 = $("tl").offsetHeight, y0 = e.clientY; e.target.setPointerCapture(e.pointerId);
    const mv = (ev) => { document.documentElement.style.setProperty("--tl", clamp(h0 - (ev.clientY - y0), 150, window.innerHeight * 0.6) + "px"); };
    const up = () => { e.target.removeEventListener("pointermove", mv); e.target.removeEventListener("pointerup", up); };
    e.target.addEventListener("pointermove", mv); e.target.addEventListener("pointerup", up);
  });
  document.addEventListener("keydown", (e) => {
    if (!S.proj) return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || document.querySelector(".dialog")) return;
    const k = e.key, mod = e.ctrlKey || e.metaKey;
    if (k === " ") { e.preventDefault(); togglePlay(); }
    else if (mod && k.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
    else if (mod && k.toLowerCase() === "y") { e.preventDefault(); redo(); }
    else if (mod && k.toLowerCase() === "a" && S.msel && S.msel.ks.size) { e.preventDefault(); S.msel.ks = new Set(mspans(layers()[S.msel.i]).map((r) => r.k)); refreshAll({ keepVideo: true }); }
    else if (mod && k.toLowerCase() === "a" && S.asel.size) { e.preventDefault(); const ls = aselLayers(); for (const p of kept()) for (const n of ls) aselSet(p, n, true); refreshAll({ keepVideo: true }); }
    else if (mod && k.toLowerCase() === "a") { e.preventDefault(); S.sel = new Set(kept()); refreshAll({ keepVideo: true }); }
    else if (mod && k.toLowerCase() === "j") { e.preventDefault(); combineScenes(); }
    else if (mod && k.toLowerCase() === "d") { e.preventDefault(); duplicateSelected(); }
    else if (mod && k.toLowerCase() === "b") { e.preventDefault(); splitAtPlayhead(); }
    else if (k.toLowerCase() === "s" && !mod && S.msel && S.msel.ks.size) { e.preventDefault(); cutMusic(S.msel.i, S.t); }
    else if (k.toLowerCase() === "s" && !mod) { e.preventDefault(); splitAtPlayhead(); }
    else if (k.toLowerCase() === "p" && !mod && !e.altKey) { e.preventDefault(); startPreview(); }
    else if (k.toLowerCase() === "q" && !mod && !e.altKey) { e.preventDefault(); cutSide("before"); }
    else if (k.toLowerCase() === "w" && !mod && !e.altKey) { e.preventDefault(); cutSide("after"); }
    else if ((k === "Delete" || k === "Backspace") && S.msel && S.msel.ks.size) { e.preventDefault(); musicChange((c) => { c.mute = true; }); }
    else if ((k === "Delete" || k === "Backspace") && aselList().length) { e.preventDefault(); stemChange((c) => { c.mute = true; }); }
    else if (k === "Delete" || k === "Backspace") { e.preventDefault(); removeSelected(); }
    else if (k === "Escape") { S.sel.clear(); S.asel = new Map(); S.msel = null; refreshAll({ keepVideo: true }); }
    else if (k === "ArrowLeft") { e.preventDefault(); seek(S.t - (e.shiftKey ? 1 : frame())); }
    else if (k === "ArrowRight") { e.preventDefault(); seek(S.t + (e.shiftKey ? 1 : frame())); }
    else if (k === "Home") seek(0); else if (k === "End") seek(rawTotal());
    else if (k === "+" || k === "=") zoomTo(S.pps * 1.5); else if (k === "-") zoomTo(S.pps / 1.5);
  });
  // Leaving the page within half a second of a change: send the save in a way that survives closing the page.
  window.addEventListener("pagehide", () => {
    if (!S.saveTimer) return;
    clearTimeout(S.saveTimer); S.saveTimer = null;
    const body = JSON.stringify({ name: S.proj.name, pieces: S.proj.pieces, settings: S.proj.settings, texts: S.proj.texts, steps: S.proj.steps, rule: S.proj.rule });
    try { fetch("/api/projects/" + S.id, { method: "PUT", keepalive: body.length < 60000, headers: { "X-EditForge-Token": TOKEN, "Content-Type": "application/json" }, body }); } catch (e) { /* closing */ }
  });
}

(async function init() {
  topBar("/" + S.mode, [el("div", { class: "lenpill", title: "Length of the video" }, icon("clock", "s"), el("span", { text: "Video" }), el("b", { id: "topLen", text: "0:00.0" })),
    Object.assign(btn("Preview", { icon: "eye", title: "See the finished video before it is made: full window, with the frame, words and music (P)", onclick: () => startPreview() }), { id: "previewBtn" }),
    S.mode === "final" ? btn("Export", { icon: "export", cls: "primary", onclick: () => exportDialog() }) : null].filter(Boolean));
  paintIcons(); enhanceAll();
  if (!S.id) { location.replace("/?phase=" + S.mode); return; }
  wire(); await openProject();
})();
