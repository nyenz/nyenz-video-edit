"use strict";
// The Editor: a video cut into pieces on a timeline, played live as you edit.
// Model: S.proj.pieces is the list the server renders. Pieces with off=true are not in the timeline
// (they are "removed" and can be put back). The timeline shows the other pieces, in order.
// Steps: S.proj.steps are pinned (locked) earlier steps; S.proj.pieces is the newest step, the one you edit.
// Every piece is a range of the PARENT video, so nothing is rendered between steps (see steps.js).

const S = {
  id: new URLSearchParams(location.search).get("p") || "",
  mode: location.pathname.startsWith("/final") || location.pathname.startsWith("/studio") ? "final" : "edit",
  studio: location.pathname.startsWith("/studio"),                     // /studio: the Final tools plus the precision tools, for any video      // /edit: the Edit stage (sections), /final: the Final stage (sound, picture)
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
  ["invert", "Invert", "palette"], ["sepia", "Sepia", "palette"], ["blur", "Blur", "drop"], ["sharpen", "Sharpen", "sparkles"], ["vignette", "Dark corners", "eye"],
  ["denoise", "Less grain", "sliders"], ["stabilize", "Steady shaky", "fit"]];
const COLOR_ZERO = { brightness: 0, contrast: 1, saturation: 1, warmth: 0 };
const COLOR_KEYS = Object.keys(COLOR_ZERO);
/** Finished colour looks: pick one, then fine-tune with the sliders if wanted. */
const COLOR_PRESETS = [["Natural", {}], ["Warm", { warmth: 0.45, saturation: 1.08 }], ["Cool", { warmth: -0.45 }], ["Vivid", { saturation: 1.45, contrast: 1.1 }],
  ["Muted", { saturation: 0.6, contrast: 0.95 }], ["Film", { contrast: 1.15, saturation: 0.85, warmth: 0.2 }], ["Bright", { brightness: 0.08, contrast: 1.05 }], ["B&W", { saturation: 0, contrast: 1.12 }]];
/** The colour settings as a CSS filter for the live view (warmth is shown close to what the export does). */
function colorCss(c) {
  const f = [];
  if (c.brightness) f.push("brightness(" + (1 + c.brightness) + ")");
  if (c.contrast !== undefined && c.contrast !== 1) f.push("contrast(" + c.contrast + ")");
  if (c.saturation !== undefined && c.saturation !== 1) f.push("saturate(" + c.saturation + ")");
  const w = c.warmth || 0;
  if (w > 0) f.push("sepia(" + (w * 0.35).toFixed(3) + ")", "saturate(" + (1 + w * 0.15).toFixed(3) + ")");
  else if (w < 0) f.push("hue-rotate(" + (w * 14).toFixed(1) + "deg)", "saturate(" + (1 + w * 0.12).toFixed(3) + ")");
  return f.join(" ");
}
const LOOK_NAME = Object.fromEntries(LOOKS.map(([k, n]) => [k, n]));
const SHAPES = { original: null, vertical: 9 / 16, square: 1, portrait: 4 / 5 };
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
  if (p.color.warmth === undefined) p.color.warmth = 0;
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
const STEM_LOCKS = ["voices", "music", "effects", "found", "found_voices", "found_music", "found_effects"];
function trackLocked(k) {
  const l = S.proj && S.proj.settings && S.proj.settings.locks;
  if (!l) return false;
  return !!l[k] || (STEM_LOCKS.includes(k) && !!l.sound);   // the sound lock covers the split tracks too
}
function toggleLock(k) {
  const l = Object.assign({ video: false, sound: false, voices: false, music: false, effects: false, found: false, found_voices: false, found_music: false, found_effects: false }, S.proj.settings.locks || {});
  if (STEM_LOCKS.includes(k) && l.sound) { toast("The whole sound is locked. Unlock it at the Sound track first.", true); return; }
  l[k] = !l[k]; S.proj.settings.locks = l; scheduleSave();
  const what = { video: "Video track ", sound: "Sound track " }[k] || ((Layers.TITLE[k] || k) + " track ");
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
  remember(); const before = S.undo[S.undo.length - 1];
  fn(); refreshAll(opts); scheduleSave();
  noteHistory(before);
  return true;
}
// ---- Back: for each kind of change, the last 5 versions before it, kept with the project (also after the app closes).
// Going back changes only that kind of thing: going back on Loudness keeps the cuts, words and pictures you made since.
const PIECE_GROUPS = {
  "Loudness": ["volume", "mute"], "Level and fades": ["even", "fin", "fout"], "Shape the sound": ["tone", "hp", "lp", "dyn", "nr", "nudge"],
  "Picture": ["fx", "color", "zoom", "follow", "place"],
};
const SETTING_GROUPS = {
  "Songs": ["layers", "music", "music_volume", "duck"], "Volume lines": ["vline"], "Mute, solo and locks": ["mute", "solo", "locks"],
  "Split tracks": ["mix_split", "mix_voices", "mix_music", "mix_effects", "mix_found", "mix_found_voices", "mix_found_music", "mix_found_effects", "ducks"],
  "Groups": ["sound_groups"], "Picture": ["frame", "shape"], "Export": ["quality", "export_size", "loudness_step", "made_for"],
  "Sound clean-up": ["noise", "vocals", "voice_boost", "compress", "bass", "treble", "original_sound"],
};
S.hist = {};
const cutsOf = (ps) => JSON.stringify(ps.map((p) => [p.start, p.end, !!p.off, p.speed, !!p.reverse]));
function mixPart(m, keys) { const o = {}; for (const [n, v] of Object.entries(m || {})) { const x = {}; for (const k of keys) if (v[k] !== undefined) x[k] = v[k]; if (Object.keys(x).length) o[n] = x; } return o; }
/** Which kinds of things a change touched (labels of the Back menu). */
function historyLabels(a, b) {
  const out = new Set();
  if (cutsOf(a.pieces) !== cutsOf(b.pieces)) out.add("Cuts");
  else {
    for (const [label, keys] of Object.entries(PIECE_GROUPS)) {
      const pick = (ps) => JSON.stringify(ps.map((p) => [keys.map((k) => p[k] === undefined ? null : p[k]), mixPart(p.mix, label === "Picture" ? [] : keys.concat(label === "Loudness" ? ["group"] : []))]));
      if (pick(a.pieces) !== pick(b.pieces)) out.add(label === "Loudness" && JSON.stringify(a.pieces.map((p) => mixPart(p.mix, ["group"]))) !== JSON.stringify(b.pieces.map((p) => mixPart(p.mix, ["group"]))) ? "Groups" : label);
    }
  }
  for (const [label, keys] of Object.entries(SETTING_GROUPS)) if (keys.some((k) => JSON.stringify(a.settings[k]) !== JSON.stringify(b.settings[k]))) out.add(label);
  if (JSON.stringify(a.texts || []) !== JSON.stringify(b.texts || [])) out.add("Words");
  if (a.name !== b.name) out.add("Name");
  return [...out];
}
function noteHistory(before) {
  const a = JSON.parse(before), b = JSON.parse(snapshot()), now = Date.now();
  const labels = historyLabels(a, b); if (!labels.length) return;
  if (S.mode === "final" && (labels.includes("Cuts") || labels.includes("Picture"))) followChanged();
  for (const label of labels) {
    const list = S.hist[label] = S.hist[label] || [];
    if (list.length && now - list[0].when < 1200) continue;          // one step for quick repeats (a drag, a typed number)
    list.unshift({ when: now, before });
    if (list.length > 5) list.length = 5;
  }
  clearTimeout(S.histTimer); S.histTimer = setTimeout(saveHistory, 1500);
}
async function saveHistory() {
  if (!S.id) return;
  try { await api("/api/projects/" + S.id + "/history", { method: "PUT", json: { history: S.hist } }); } catch (e) { /* kept in memory; tried again next time */ }
}
async function loadHistory() {
  try { const r = await api("/api/projects/" + S.id + "/history"); S.hist = r.history || {}; } catch (e) { S.hist = {}; }
}
/** Go back on one kind of change: only that kind comes back as it was (the cuts come back whole). */
function backTo(label, i) {
  const e = (S.hist[label] || [])[i]; if (!e) return;
  const old = JSON.parse(e.before), cur = JSON.parse(snapshot());
  const sameCuts = cutsOf(old.pieces) === cutsOf(cur.pieces);
  const ok = change(() => {
    if (label === "Cuts") S.proj.pieces = old.pieces.map(fixPiece);
    else if (PIECE_GROUPS[label] || label === "Groups") {
      const keys = label === "Groups" ? [] : PIECE_GROUPS[label], mk = label === "Groups" ? ["group"] : keys.concat(label === "Loudness" ? ["group"] : []);
      // each section takes the setting of the section it was part of then (a section cut in two since gets it on both halves)
      const from = (p, j) => sameCuts ? old.pieces[j] : old.pieces.find((q) => !!q.off === !!p.off && q.start <= p.start + 1e-3 && q.end >= p.end - 1e-3)
        || old.pieces.find((q) => q.start < p.end && q.end > p.start);
      S.proj.pieces.forEach((p, j) => {
        const q = from(p, j); if (!q) return;
        for (const k of keys) { if (q[k] === undefined) delete p[k]; else p[k] = clone(q[k]); }
        if (label !== "Picture") {
          const m = Object.assign({}, p.mix || {});
          for (const n of new Set(Object.keys(m).concat(Object.keys(q.mix || {})))) {
            const c = Object.assign({ volume: 1, mute: false }, m[n] || {}), from = (q.mix || {})[n] || {};
            for (const k of mk) { if (from[k] === undefined) delete c[k]; else c[k] = from[k]; }
            if (!c.mute && Math.abs(c.volume - 1) < 0.001 && !c.group && !SHAPE_KEYS.some((k) => c[k])) delete m[n]; else m[n] = c;
          }
          if (Object.keys(m).length) p.mix = m; else delete p.mix;
        }
      });
    }
    if (SETTING_GROUPS[label]) for (const k of SETTING_GROUPS[label]) { if (old.settings[k] === undefined) delete S.proj.settings[k]; else S.proj.settings[k] = clone(old.settings[k]); }
    if (label === "Groups") S.proj.settings.sound_groups = clone(old.settings.sound_groups || []);
    if (label === "Words") S.proj.texts = clone(old.texts || []);
    if (label === "Name") S.proj.name = old.name;
  }, { any: true });
  if (!ok) return;
  if (typeof Layers !== "undefined") { S.stemFor = null; Layers.refresh(); }
  refreshAll(); if (S.playing) musicPlay();
  toast("Back: " + label + " as it was " + agoText(e.when) + ". Everything else stays as it is now. Ctrl + Z undoes this.");
}
function agoText(when) {
  const s = Math.max(0, (Date.now() - when) / 1000);
  if (s < 60) return "just now"; if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago"; return new Date(when).toLocaleDateString();
}
/** The Back menu items: one row per kind of change, each with its last steps. Only some kinds when ``only`` is given. */
function backItems(only) {
  const labels = Object.keys(S.hist).filter((l) => S.hist[l].length && (!only || only.includes(l)));
  if (!labels.length) return [["Nothing to go back to yet", "info", () => {}, { off: true }]];
  labels.sort((x, y) => S.hist[y][0].when - S.hist[x][0].when);
  return labels.map((l) => [l, "restore", null, { sub: S.hist[l].map((e, i) => [(i === 0 ? "Before the last change · " : "Step " + (i + 1) + " back · ") + agoText(e.when), null, () => backTo(l, i)]) }]);
}
function backMenu(e) { const r = e.currentTarget.getBoundingClientRect(); ctxMenu(backItems(), r.left, r.bottom + 4); }
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
  if (S.studio && $("stMarksN")) $("stMarksN").textContent = String((S.proj.settings.markers || []).length);
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
  $("shapeTag").textContent = { original: "Original shape", vertical: "Tall 9:16", vertical_follow: "Tall 9:16 · tracking", vertical_blur: "Tall 9:16 · blurred edges", square: "Square", square_follow: "Square · tracking", square_blur: "Square · blurred edges",
    portrait: "Portrait 4:5", portrait_follow: "Portrait 4:5 · tracking", portrait_blur: "Portrait 4:5 · blurred edges" }[sh] || "";
  for (const v of [V.a, V.b]) v.style.objectPosition = "";
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
  const cc = colorCss(p.color); if (cc) f.push(cc);
  v.style.filter = f.join(" ");
  v.muted = S.mutedAll || p.mute || !ownSoundOn() || Layers.on();     // with the three layers on, they carry the sound
  setVideoVol(v, p.volume, p);
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
  Layers.follow(active(), V.seg.p); musicGains(); musicFollow(); paintMeter(); followView(active(), V.seg.p);
  if (!Layers.on() && V.seg.p) { const vv = active(), pp = V.seg.p; setVideoVol(vv, pp.volume * partShapeGain(pp, "original", vv.currentTime), pp); }
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
/** Solo is on when any track is soloed: a music track, the video's own sound, or one of its split tracks. */
function soloOn() { return layers().some((x) => x.solo) || (S.proj.settings.solo || []).length > 0; }
const KEY_TITLE = { original: "Sound" };
function keyName(k) { return KEY_TITLE[k] || (typeof Layers !== "undefined" && Layers.TITLE[k]) || k; }
/** The video's own sound ('original') or a split track: muted, or left out by someone else's Solo. */
function keyMuted(k) { return (S.proj.settings.mute || []).includes(k); }
function keySolo(k) { return (S.proj.settings.solo || []).includes(k); }
function keyHeard(k) { return !keyMuted(k) && (!soloOn() || keySolo(k)); }
/** Mute or solo the video's own sound or one split track. Mute is a change (a lock stops it); Solo is only for listening. */
function flipKey(list, k) {
  if (list === "mute" && (trackLocked(k) || trackLocked("sound"))) { lockedNote("sound"); return; }
  change(() => { const a = (S.proj.settings[list] || []).slice(), j = a.indexOf(k); if (j >= 0) a.splice(j, 1); else a.push(k); S.proj.settings[list] = a; }, { keepVideo: true });
  soundFlipped();
  const on = (S.proj.settings[list] || []).includes(k);
  toast(keyName(k) + (list === "mute" ? (on ? " is muted." : " is heard again.") : (on ? " is soloed: only for listening, the export keeps every track." : " is no longer soloed.")));
}
function soundFlipped() {
  if (typeof Layers !== "undefined" && Layers.apply) Layers.apply();
  if (S.playing) { for (const v of [V.a, V.b]) if (V.seg && v === active()) dress(v, V.seg.p); musicPlay(); }
  renderTimeline(); renderInspector();
}
/** The Mute and Solo buttons at the head of a sound track (the same look as on the music tracks). */
function msBtns(k, name) {
  const m = keyMuted(k), so = keySolo(k);
  return [el("button", { type: "button", class: "lh-btn" + (m ? " on" : ""), title: m ? "Unmute" : "Mute", "aria-label": "Mute " + name, "aria-pressed": String(m), onclick: (e) => { e.stopPropagation(); flipKey("mute", k); } }, icon(m ? "mute" : "vol", "s")),
    el("button", { type: "button", class: "lh-btn solo" + (so ? " on" : ""), title: so ? "Stop solo" : "Solo: hear only this (and other soloed tracks)", "aria-label": "Solo " + name, "aria-pressed": String(so), onclick: (e) => { e.stopPropagation(); flipKey("solo", k); }, text: "S" })];
}
/** Solo is easy to forget: while it is on, the player says so, with one click to hear everything again. */
function renderSoloChip() {
  const c = $("soloChip"); if (!c) return;
  const stems = (S.proj.settings.solo || []).length, on = S.mode === "final" && (soloOn() || stems > 0);
  c.hidden = !on; if (!on) return;
  const names = layers().filter((x) => x.solo).map((x) => ((S.files || []).find((f) => f.id === x.file) || { name: x.file.split("/").pop() }).name)
    .concat((S.proj.settings.solo || []).map(keyName));
  c.querySelector("span").textContent = "Solo on";
  c.title = "Solo: here you only hear " + (names.length ? names.join(", ") : "the chosen track") + ". It is only for listening: the export always has every track that is not muted. Click to hear everything again.";
}
function stopSolo() {
  change(() => { S.proj.settings.layers = layers().map((x) => (x.solo ? Object.assign({}, x, { solo: false }) : x)); S.proj.settings.solo = []; }, { keepVideo: true });
  if (typeof Layers !== "undefined" && Layers.apply) Layers.apply();
  renderMusicLayers(); renderTimeline(); renderInspector(); if (S.playing) musicPlay();
  toast("Solo is off: you hear everything again.");
}
function heard(x) { return !x.mute && (!soloOn() || x.solo); }
function ownSoundOn() { return S.proj.settings.original_sound && keyHeard("original"); }
let MCTX = null;
function musicPlayer(file) {
  let a = MUSIC.get(file);
  if (!a) {
    a = new Audio(mediaUrl(file, false)); a.preload = "auto"; MUSIC.set(file, a);
    try {                                          // through Web Audio, so the viewer can play it louder than 100 %
      const C = window.AudioContext || window.webkitAudioContext;
      if (C) { MCTX = MCTX || new C(); const g = MCTX.createGain(), tc = toneChain(MCTX); MCTX.createMediaElementSource(a).connect(tc.input); tc.output.connect(g); g.connect(soundOut(MCTX)); a._gain = g; a._tone = tc; }
    } catch (e) { a._gain = null; }
  }
  return a;
}
function setMusicGain(m, v) { v *= masterGain(); if (m._gain) { if (m.volume !== 1) m.volume = 1; m._gain.gain.value = Math.max(0, v); } else m.volume = clamp(v, 0, 1); }
/** The Overall loudness chosen in Export, heard live in the player (Standard = 1): the whole sound a step quieter or louder. */
function masterGain() { return S.mode === "final" && S.proj ? Math.pow(10, ((+S.proj.settings.loudness_step || 0) * 1.5) / 20) : 1; }
/** The video's own sound. Louder than 100 % needs Web Audio, so a video is routed through it once that is wanted. */
function setVideoVol(v, vol, sh) {
  const g = Math.max(0, vol) * masterGain() * (S.mode === "final" && S.proj ? lineAt((S.proj.settings.vline || {}).original, S.t) : 1);
  if (!v._gain && (g > 1.001 || hasTone(sh))) {
    try {
      const C = window.AudioContext || window.webkitAudioContext;
      if (C) {
        MCTX = MCTX || new C(); const n = MCTX.createGain(), tc = toneChain(MCTX);
        MCTX.createMediaElementSource(v).connect(tc.input); tc.output.connect(n); n.connect(soundOut(MCTX));
        v._gain = n; v._tone = tc; if (MCTX.state === "suspended") MCTX.resume();
      }
    } catch (e) { v._gain = null; }
  }
  if (v._tone) v._tone.set(sh);
  if (v._gain) { if (v.volume !== 1) v.volume = 1; v._gain.gain.value = g; } else v.volume = clamp(g, 0, 1);
}
function hasTone(sh) { return !!(sh && (sh.tone || sh.hp || sh.lp || sh.dyn)); }
/** Hear a new Overall loudness right away: everything playing now follows it. */
function applyMaster() {
  musicGains();
  if (typeof Layers !== "undefined" && Layers.apply) Layers.apply();
  if (V.seg && V.seg.p) for (const v of [V.a, V.b]) setVideoVol(v, V.seg.p.volume, V.seg.p);
}
/** How loud a music track is right now: the track, the part under the playhead, and going down under voices. */
function musicLevel(x, t) { return Math.max(0, x.volume) * partGain(x, t) * duckGain(x, t) * musicShapeGain(x, t) * lineAt(x.vline, t); }
/** The tone of a song right now: its own (whole song), with the part under the playhead on top. */
function songTone(x, t) { let q = null; for (const r of mspans(x)) if (t >= r.a && t < r.b) q = r.q; return Object.assign({}, x.shape || {}, q && hasTone(q) ? { tone: q.tone, hp: q.hp, lp: q.lp } : {}); }
function musicGains() { for (const x of layers()) if (heard(x)) { const m = musicPlayer(x.file); setMusicGain(m, musicLevel(x, S.t)); if (m._tone) m._tone.set(songTone(x, S.t)); } }
function musicPlay() {
  const on = new Set();
  if (MCTX && MCTX.state === "suspended") MCTX.resume();
  for (const x of layers()) {
    if (!heard(x)) continue;
    const m = musicPlayer(x.file); on.add(x.file);
    setMusicGain(m, musicLevel(x, S.t)); if (m._tone) m._tone.set(songTone(x, S.t)); m.muted = S.mutedAll;
    const st = songTime(x, m, S.t); if (st !== null) m.currentTime = st;
    const pr = m.play(); if (pr && pr.catch) pr.catch(() => {});
  }
  for (const [f, m] of MUSIC) if (!on.has(f)) m.pause();
}
function musicPause() { for (const m of MUSIC.values()) m.pause(); }
function musicMute() { for (const m of MUSIC.values()) m.muted = S.mutedAll; }
function musicSync() { if (!S.proj || !MUSIC.size) return; for (const x of layers()) { const m = MUSIC.get(x.file), st = m && songTime(x, m, S.t); if (st !== null && st !== undefined) m.currentTime = st; } }
/** While playing: a moved part (or a bit taken out of the song) makes the song jump; follow it. */
function musicFollow() {
  if (!S.playing) return;
  for (const x of layers()) {
    if (!heard(x)) continue;
    const m = MUSIC.get(x.file), st = m && songTime(x, m, S.t);
    if (st !== null && st !== undefined && Math.abs(m.currentTime - st) > 0.25 && Math.abs(m.currentTime - st) < m.duration - 0.25) m.currentTime = st;
  }
}
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
  if (p && p.place && p.place.track && !S.dragFrom) {          // tracking: the picture moves with the tracked thing
    const f = Object.assign(Frame.full(base), p.place), v = active(), t = v && isFinite(v.currentTime) ? v.currentTime : p.start;
    const [dx, dy] = trackOffset(p.place, t), sh = pictureShare(f);
    const lx = Math.max(0, sh.w - 1), ly = Math.max(0, sh.h - 1);
    f.x = lx > 0 ? clamp(f.x + dx, -lx, lx) : f.x + dx;
    f.y = dy ? (ly > 0 ? clamp(f.y + dy, -ly, ly) : f.y + dy) : f.y;
    delete f.track;
    return f;
  }
  if (p && p.place) { const f = Object.assign(Frame.full(base), p.place); delete f.track; return f; }
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
  // slider 0..100 maps to 2 .. 4000 pixels per second on a log scale (all the way in, every frame is a wide picture)
  const v = parseFloat($("zoom").value);
  S.pps = 2 * Math.pow(ZOOM_MAX / 2, v / 100);
}
const ZOOM_MAX = 4000;
function sliderFromZoom() { $("zoom").value = String(clamp(Math.log(S.pps / 2) / Math.log(ZOOM_MAX / 2) * 100, 0, 100)); paintRange($("zoom")); }
function zoomTo(pps, anchorT) {
  const sc = $("tlScroll"), t = anchorT === undefined ? S.t : anchorT, before = px(t) - sc.scrollLeft;
  S.pps = clamp(pps, 2, ZOOM_MAX); sliderFromZoom(); renderTimeline();
  sc.scrollLeft = px(t) - before;
}
function fitZoom() { const w = $("tlScroll").clientWidth - X0() - 32; S.pps = clamp(w / Math.max(1, rawTotal()), 2, ZOOM_MAX); sliderFromZoom(); renderTimeline(); $("tlScroll").scrollLeft = 0; }
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
  // zoomed in far: a tick for every frame (and its number inside the second when there is room)
  const fps = S.info.fps_float || 25, fpx = S.pps / fps;
  if (fpx >= 7) {
    const f0 = Math.floor(a * fps), f1 = Math.ceil(b * fps);
    for (let k = f0; k <= f1; k++) {
      const tick = el("i", { class: "fr" }); tick.style.left = px(k / fps) + "px"; r.append(tick);
      if (fpx >= 46 && k % Math.round(fps) !== 0) { const lab = el("span", { class: "frn", text: String(((k % Math.round(fps)) + Math.round(fps)) % Math.round(fps)) }); lab.style.left = (px(k / fps) + fpx / 2) + "px"; r.append(lab); }
    }
  }
  // scene changes: a small mark; click to go there
  for (const m of cutMarks()) {
    if (m < a || m > b) continue;
    const d = el("button", { type: "button", class: "scut", title: "Scene change at " + fmtTime(m, 2) + " (click to go there; [ and ] jump between them)", onclick: (e) => { e.stopPropagation(); seek(m); } });
    d.style.left = px(m) + "px"; r.append(d);
  }
  if (S.studio) Studio.ruler(r);
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
      const fps = S.info.fps_float || 25, fpx = S.pps / fps, look = (img) => { if (p.fx.includes("hflip")) img.style.transform = "scaleX(-1)"; if (p.fx.includes("grayscale")) img.style.filter = "grayscale(1)"; };
      if (fpx >= T.thumbW * 0.5) {
        // zoomed in to single frames: every frame its own exact picture (only the ones on screen)
        strip.classList.add("frames");
        const k0 = Math.max(0, Math.floor((left - x0) / fpx)), k1 = Math.min(Math.ceil((r.out1 - r.out0) * fps), Math.ceil((right - x0) / fpx));
        for (let k = k0; k < k1 && k - k0 < 160; k++) {
          const ot = (k + 0.5) / fps, st = clamp(p.reverse ? p.end - ot * p.speed : p.start + ot * p.speed, p.start, Math.max(p.start, p.end - 0.5 / fps));
          const img = lazyThumb(thumbUrl(S.proj.source, st) + "&exact=1");
          img.style.left = (k * fpx) + "px"; img.style.width = Math.max(4, fpx - 1) + "px"; look(img);
          strip.append(img);
        }
      } else {
        const fine = T.thumbW / S.pps < 1.2;               // zoomed in: pictures a tenth of a second apart, not whole seconds
        const k0 = Math.max(0, Math.floor((left - x0) / T.thumbW)), k1 = Math.min(Math.ceil(w / T.thumbW), Math.ceil((right - x0) / T.thumbW));
        for (let k = k0; k < k1 && k - k0 < 80; k++) {
          const ot = (k * T.thumbW + T.thumbW / 2) / S.pps;
          const st = clamp(p.reverse ? p.end - ot * p.speed : p.start + ot * p.speed, p.start, p.end - 0.04);
          const img = lazyThumb(thumbUrl(S.proj.source, Math.min(fine ? Math.round(st * 10) / 10 : Math.round(st), Math.floor(S.info.duration - 0.05))));
          img.style.left = (k * T.thumbW) + "px"; img.style.width = T.thumbW + "px"; look(img);
          strip.append(img);
        }
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
    const flip = (k) => (e) => { e.stopPropagation(); if (k === "mute" && (x.locked || trackLocked("sound"))) { lockedNote("sound"); return; } change(() => { S.proj.settings.layers = layers().map((y, j) => (j === i ? Object.assign({}, y, { [k]: !y[k] }) : y)); }, { keepVideo: true }); renderMusicLayers(); if (S.playing) musicPlay(); };
    const row = el("div", { class: "mrow" + (x.locked || trackLocked("sound") ? " track-locked" : ""), "data-i": String(i), title: "Right-click for more" });
    if (S.mode === "final") row.append(head("music", name,
      el("button", { type: "button", class: "lh-btn" + (x.mute ? " on" : ""), title: "Mute", "aria-label": "Mute " + name, onclick: flip("mute") }, icon(x.mute ? "mute" : "vol", "s")),
      el("button", { type: "button", class: "lh-btn solo" + (x.solo ? " on" : ""), title: "Solo", "aria-label": "Solo " + name, onclick: flip("solo"), text: "S" }),
      el("button", { type: "button", class: "lock-btn" + (x.locked ? " on" : ""), title: x.locked ? "Unlock this music" : "Lock this music", "aria-pressed": String(!!x.locked), onclick: flip("locked") }, icon(x.locked ? "lock" : "unlock", "s"))));
    for (const r of mspans(x)) {
      const chosen = S.msel && S.msel.i === i && S.msel.ks.has(r.k);
      const g = r.q.mute ? 0 : x.volume * r.q.volume;
      const d = el("div", { class: "lane-item music mpart" + (heard(x) ? "" : " off") + (r.q.mute ? " muted" : "") + (chosen ? " sel" : ""), "data-k": String(r.k), ondblclick: () => openPanel("sound") },
        icon(r.q.mute ? "mute" : "music", "s"), el("span", { text: (r.k === 0 || chosen ? name + " · " : "") + (r.q.mute ? "gap (silent)" : Math.round(g * 100) + "%") +
          ((r.q.even === undefined ? x.auto : r.q.even) ? " · level " + levelName(r.q.even === undefined ? x.auto : r.q.even).toLowerCase() : "") + (r.q.fin || r.q.fout ? " · fades" : "") }));
      d.style.left = px(r.a) + "px"; d.style.width = Math.max(6, px(r.b) - px(r.a) - 2) + "px"; row.append(d);
    }
    for (const k of Object.keys(duckOf(x.duck, null, "voices"))) for (const [a, b] of S.duckBy[k] || []) {
      const z = el("i", { class: "duckz" }); z.style.left = px(a) + "px"; z.style.width = Math.max(2, px(b) - px(a)) + "px"; row.append(z);
    }
    lm.append(row);
  });
  renderAudioLane();
  renderStemLanes();
  renderLoudLane();
  if (S.mode === "final") prefetchEnvs();
  if (S.mode === "final" && !S.playing) paintMeter();
  renderSoloChip();
  renderLines();
  renderPlayhead();
}
// ---- volume lines: dots on a track's line that set its loudness at exact moments (100 % in the middle, 200 % at the top)
function lineOf(key) {
  if (key.startsWith("song:")) { const x = layers()[+key.slice(5)]; return (x && x.vline) || []; }
  return ((S.proj.settings.vline || {})[key]) || [];
}
function setLine(key, pts) {
  pts = pts.slice().sort((a, b) => a[0] - b[0]).map(([t, g]) => [+Math.max(0, t).toFixed(3), +clamp(g, 0, 2).toFixed(3)]);
  if (key.startsWith("song:")) {
    const i = +key.slice(5); if (musicLocked(i)) { toast(musicLocked(i), true); return false; }
    change(() => setLayer(i, { vline: pts.length ? pts : undefined }), { keepVideo: true });
  } else {
    if (trackLocked(key === "original" ? "sound" : key) || trackLocked("sound")) { lockedNote("sound"); return false; }
    change(() => { const v = Object.assign({}, S.proj.settings.vline || {}); if (pts.length) v[key] = pts; else delete v[key]; S.proj.settings.vline = v; }, { keepVideo: true });
  }
  if (typeof Layers !== "undefined" && Layers.apply) Layers.apply();
  if (S.playing) musicGains();
  renderLines(); return true;
}
S.lineShow = new Set();
function lineItems(key, t) {
  const L = lineOf(key), shown = L.length || S.lineShow.has(key);
  return [
    shown ? null : ["Show the volume line", "pulse", () => { S.lineShow.add(key); renderLines(); toast("Double-click the line to add a dot, then drag dots up or down. Right-click a dot to remove it."); }],
    ["Add a dot here", "plus", () => { S.lineShow.add(key); setLine(key, L.concat([[t, lineAt(L, t)]])); }],
    ["Dip here (down to 30% for 2 s)", "vol", () => { const a = Math.max(0, t - 1), b = t + 1, g0 = lineAt(L, a - 0.3), g1 = lineAt(L, b + 0.3);
      setLine(key, L.filter(([x]) => x < a - 0.3 || x > b + 0.3).concat([[a - 0.3, g0], [a, 0.3], [b, 0.3], [b + 0.3, g1]])); }],
    L.length ? ["Remove the volume line", "trash", () => { S.lineShow.delete(key); setLine(key, []); }, { danger: true }] : null,
    shown && !L.length ? ["Hide the volume line", "x", () => { S.lineShow.delete(key); renderLines(); }] : null];
}
function renderLines() {
  if (S.mode !== "final") { for (const v of document.querySelectorAll("#tlScroll svg.vline")) v.remove(); return; }
  const lanes = [];
  const la = $("laneA"); if (la && !la.hidden) lanes.push([la, "original"]);
  for (const l of document.querySelectorAll("#laneStems .lane.stem")) if (!$("laneStems").hidden) lanes.push([l, l.dataset.layer]);
  for (const r of document.querySelectorAll("#laneM .mrow")) lanes.push([r, "song:" + r.dataset.i]);
  const keep = new Set();
  for (const [lane, key] of lanes) {
    const L = lineOf(key); if (!L.length && !S.lineShow.has(key)) { const o = lane.querySelector(":scope > svg.vline"); if (o) o.remove(); continue; }
    keep.add(lane);
    drawLine(lane, key, L);
  }
}
function drawLine(lane, key, L) {
  const NS = "http://www.w3.org/2000/svg", T = rawTotal(), x0 = px(0), W = Math.max(1, px(T) - x0), H = lane.clientHeight || 30;
  let svg = lane.querySelector(":scope > svg.vline");
  if (!svg) { svg = document.createElementNS(NS, "svg"); svg.setAttribute("class", "vline"); lane.append(svg); }
  svg.style.left = x0 + "px"; svg.style.width = W + "px"; svg.style.height = H + "px"; svg.setAttribute("viewBox", "0 0 " + W + " " + H);
  const Y = (g) => 3 + (1 - g / 2) * (H - 6), G = (y) => clamp((1 - (y - 3) / (H - 6)) * 2, 0, 2), X = (t) => px(t) - x0;
  const pts = L.length ? L : [[0, 1]];
  const d = "M0," + Y(pts[0][1]) + pts.map(([t, g]) => " L" + X(t) + "," + Y(g)).join("") + " L" + W + "," + Y(pts[pts.length - 1][1]);
  svg.replaceChildren();
  const mid = document.createElementNS(NS, "line"); mid.setAttribute("class", "vl-mid"); mid.setAttribute("x1", "0"); mid.setAttribute("x2", String(W)); mid.setAttribute("y1", String(Y(1))); mid.setAttribute("y2", String(Y(1))); svg.append(mid);
  const hit = document.createElementNS(NS, "path"); hit.setAttribute("d", d); hit.setAttribute("class", "vl-hit"); svg.append(hit);
  const path = document.createElementNS(NS, "path"); path.setAttribute("d", d); path.setAttribute("class", "vl-path"); svg.append(path);
  const tAt = (e) => { const r = svg.getBoundingClientRect(); return clamp(timeAt(e.clientX - r.left + x0), 0, T); };
  const gAt = (e) => { const r = svg.getBoundingClientRect(); return G(e.clientY - r.top); };
  hit.addEventListener("pointerdown", (e) => e.stopPropagation());
  hit.addEventListener("dblclick", (e) => { e.stopPropagation(); setLine(key, L.concat([[tAt(e), gAt(e)]])); });
  hit.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); ctxMenu(lineItems(key, tAt(e)), e.clientX, e.clientY); });
  L.forEach(([t, g], i) => {
    const c = document.createElementNS(NS, "circle"); c.setAttribute("cx", String(X(t))); c.setAttribute("cy", String(Y(g))); c.setAttribute("r", "4.5"); c.setAttribute("class", "vl-dot");
    const tip = document.createElementNS(NS, "title"); tip.textContent = Math.round(g * 100) + "% at " + fmtTime(t, 2) + " · drag to change, right-click to remove"; c.append(tip);
    c.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.stopPropagation(); e.preventDefault(); c.setPointerCapture(e.pointerId);
      const lo = i > 0 ? L[i - 1][0] + 0.01 : 0, hi = i < L.length - 1 ? L[i + 1][0] - 0.01 : T;
      let nt = t, ng = g;
      const mv = (ev) => { nt = clamp(tAt(ev), lo, hi); ng = gAt(ev); c.setAttribute("cx", String(X(nt))); c.setAttribute("cy", String(Y(ng))); showTip(Math.round(ng * 100) + "% · " + fmtTime(nt, 2), ev.clientX, ev.clientY); };
      const up = () => { c.removeEventListener("pointermove", mv); c.removeEventListener("pointerup", up); hideTip(); if (nt !== t || ng !== g) setLine(key, L.map((q, j) => (j === i ? [nt, ng] : q))); };
      c.addEventListener("pointermove", mv); c.addEventListener("pointerup", up);
    });
    c.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation();
      ctxMenu([["Remove this dot", "trash", () => setLine(key, L.filter((_, j) => j !== i))], ["Back to 100%", "restore", () => setLine(key, L.map((q, j) => (j === i ? [q[0], 1] : q)))],
        "-", ...lineItems(key, t)], e.clientX, e.clientY); });
    svg.append(c);
  });
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
  if (S.mode === "final") {
    const old = la.querySelector(".lane-head"), sig = [keyMuted("original"), keySolo("original"), trackLocked("sound")].join();
    if (!old || old.dataset.sig !== sig) {         // rebuilt only when it changed, so a click is never lost to a redraw
      if (old) old.remove();
      la.prepend(el("div", { class: "lane-head", "data-sig": sig }, icon("vol", "s"), el("span", { class: "ellip", text: "Sound" }), ...msBtns("original", "the sound"), lockBtn("sound")));
    }
  }
  la.classList.toggle("muted", !keyHeard("original"));
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
  if (sh.even && !S.levelOff) {
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
  if (s && !S.levelOff) {
    const pts = envPoints({ file: x.file }, s), m = MUSIC.get(x.file), D = m && m.duration;
    if (pts && D) g *= dbGain(envDb(pts, (t + (+x.start || 0)) % D));
  }
  return g;
}
/** Level: every loud moment down and every quiet moment up, smoothly, so the sound stays at a good level all the way.
 *  Light (1), Medium (3), Strong (2), Max (4), or Custom (1000 + speed * 100 + most boost * 10 + most cut). */
const LEVELS = [[0, "Off"], [1, "Light"], [3, "Medium"], [2, "Strong"], [4, "Max"]];
const LV_SPEED = ["Slow", "Normal", "Fast"], LV_BOOST = [3, 6, 12, 18, 24], LV_CUT = [6, 12, 18, 24, 36];
function levelName(v) { v = +v || 0; if (v >= 1000) return "Custom"; const x = LEVELS.find(([k]) => k === v); return x ? x[1] : "Off"; }
function levelCode(sp, bo, cu) { return 1000 + sp * 100 + bo * 10 + cu; }
function levelParts(v) { return v >= 1000 ? [Math.floor((v - 1000) / 100), Math.floor(v / 10) % 10, v % 10] : [1, 2, 2]; }
S.levelOff = false;            // A/B: hear the sound without Level for a moment
function evenField(cur, onpick, off, note) {
  const custom = cur !== null && cur >= 1000;
  const seg = segmented(LEVELS.concat([["c", "Custom"]]), cur === null ? "" : custom ? "c" : cur, (v) => onpick(v === "c" ? (custom ? cur : levelCode(1, 2, 2)) : +v));
  seg.classList.add("level-seg");
  if (off) for (const b of seg.children) b.disabled = true;
  let more = null;
  if (custom) {
    const [sp, bo, cu] = levelParts(cur);
    const row = (label, opts, val, mk) => { const g = segmented(opts.map((o, i) => [i, o]), val, (i) => onpick(mk(+i))); if (off) for (const b of g.children) b.disabled = true;
      return el("div", { class: "field" }, el("span", { text: label }), g); };
    more = el("div", { class: "level-custom" },
      row("How fast it reacts", LV_SPEED, sp, (i) => levelCode(i, bo, cu)),
      row("Most it lifts quiet moments", LV_BOOST.map((d) => "+" + d), bo, (i) => levelCode(sp, i, cu)),
      row("Most it lowers loud moments", LV_CUT.map((d) => "−" + d), cu, (i) => levelCode(sp, bo, i)));
  }
  const ab = el("button", { type: "button", class: "ab-btn" + (S.levelOff ? " on" : ""), title: "Hear it without Level (A/B). Click again to hear it with Level.",
    onclick: () => { S.levelOff = !S.levelOff; ab.classList.toggle("on", S.levelOff); ab.textContent = S.levelOff ? "Hearing before" : "A/B"; if (typeof Layers !== "undefined") Layers.apply(); musicGains(); } }, S.levelOff ? "Hearing before" : "A/B");
  return el("div", { class: "field even-field" },
    el("span", { class: "lv-head" }, el("b", { text: "Level" }), el("small", { class: "note", text: " keeps it at a good level all the way" }), cur ? ab : null), seg, more,
    el("p", { class: "hint", text: note || "Quiet pauses are never pulled up, so no hiss comes up. Voices stay above music with Go down under voices." }));
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
// ---- Shape the sound: Tone, Cuts, Dynamics, Clean and Timing of a part, a group, a section or a whole song. In tabs, so the
// panel never grows long; the same in the player and in the export (Clean only in the export: it cannot be done live).
const SHAPE_KEYS = ["even", "fin", "fout", "tone", "hp", "lp", "dyn", "nr", "nudge"];
const TONE_KEYS = ["tone", "hp", "lp", "dyn", "nr", "nudge"];
let SHAPE_TAB = "tone";
/** get(k): the value of the chosen parts (null when they differ); set(k, v): change them (0 / "" = off). */
function shapeBox(get, set, off, opts) {
  opts = opts || {};
  const tabs = [["tone", "Tone"], ["cut", "Cuts"]].concat(opts.dyn === false ? [] : [["dyn", "Dynamics"]]).concat(opts.clean === false ? [] : [["clean", "Clean"]]).concat(opts.nudge ? [["time", "Timing"]] : []);
  if (!tabs.some(([k]) => k === SHAPE_TAB)) SHAPE_TAB = "tone";
  const on = (k) => { const v = get(k); return v !== null && v !== undefined && v !== 0 && v !== ""; };
  const dot = { tone: on("tone"), cut: on("hp") || on("lp"), dyn: on("dyn"), clean: on("nr"), time: on("nudge") };
  const body = el("div", { class: "shape-body" });
  const bar = el("div", { class: "shape-tabs", role: "tablist" });
  const seg = (k, choices) => { const sg = segmented(choices, get(k) === null ? "__mixed" : String(get(k) || 0), (v) => set(k, isNaN(+v) || v === "" ? v : +v)); if (off) for (const b of sg.children) b.disabled = true; return sg; };
  const paint = () => {
    for (const b of bar.children) b.classList.toggle("on", b.dataset.k === SHAPE_TAB);
    body.replaceChildren();
    if (SHAPE_TAB === "tone") {
      const sg = segmented(TONE_NAMES.map(([k, l]) => [k, l]), get("tone") === null ? "__mixed" : get("tone") || "", (v) => set("tone", v));
      sg.classList.add("wrap"); if (off) for (const b of sg.children) b.disabled = true;
      body.append(el("p", { class: "note", text: "A sound colour for these parts. Clear voice suits talking." }), sg);
    } else if (SHAPE_TAB === "cut") {
      body.append(el("div", { class: "field" }, el("span", {}, el("b", { text: "Low cut" }), el("small", { class: "note", text: " rumble, wind, hum" })), seg("hp", [["0", "Off"], ["80", "80 Hz"], ["150", "150 Hz"], ["300", "300 Hz"]])),
        el("div", { class: "field" }, el("span", {}, el("b", { text: "High cut" }), el("small", { class: "note", text: " hiss, harsh highs" })), seg("lp", [["0", "Off"], ["12000", "12k"], ["8000", "8k"], ["4000", "4k"]])));
    } else if (SHAPE_TAB === "dyn") {
      body.append(el("p", { class: "note", text: "Loud peaks come down and the sound gets fuller and steadier." }), seg("dyn", [["0", "Off"], ["1", "Gentle"], ["2", "Strong"]]));
    } else if (SHAPE_TAB === "clean") {
      body.append(el("p", { class: "note", text: "Takes out hiss and noise. Heard in the export and the Quick preview file (it cannot be done live)." }), seg("nr", [["0", "Off"], ["1", "Light"], ["2", "Medium"], ["3", "Strong"]]));
    } else if (SHAPE_TAB === "time") {
      const v = get("nudge"), inp = el("input", { class: "input short num", inputmode: "numeric", value: v === null ? "" : String(v || 0), "aria-label": "Nudge in milliseconds", placeholder: "mixed" });
      inp.disabled = !!off;
      const put = (x) => set("nudge", clamp(Math.round(x), -2000, 2000));
      inp.addEventListener("change", () => { const x = parseFloat(inp.value); if (isFinite(x)) put(x); else inp.value = String(get("nudge") || 0); });
      const step = (d) => btn((d > 0 ? "+" : "") + d, { cls: "sm ghost", onclick: () => put((+get("nudge") || 0) + d) });
      body.append(el("p", { class: "note", text: "Move the sound a little later (+) or earlier (−) to fix lip sync. In milliseconds (1000 = 1 second)." }),
        el("div", { class: "nudge-row" }, step(-40), step(-10), inp, el("small", { class: "note", text: "ms" }), step(10), step(40), btn("Reset", { cls: "sm ghost", onclick: () => set("nudge", 0) })));
    }
  };
  for (const [k, l] of tabs) bar.append(el("button", { type: "button", role: "tab", class: "shape-tab", "data-k": k, onclick: () => { SHAPE_TAB = k; paint(); } },
    el("span", { text: l }), dot[k] ? el("i", { class: "shape-dot" }) : null));
  paint();
  const any = Object.values(dot).some(Boolean);
  return el("div", { class: "pad shape-box" },
    el("div", { class: "field" }, el("span", {}, el("b", { text: opts.title || "Shape the sound" }), any ? el("small", { class: "note", text: " · changed" }) : null,
      any && !off ? el("button", { type: "button", class: "link-btn", text: "Reset all", onclick: () => set("__all", 0) }) : null)),
    bar, body);
}

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
    S.check = Object.assign(c, { sig: JSON.stringify([S.proj.pieces, S.proj.settings]), clipped: clippedSpots() });
    api("/api/jobs/" + job.id, { method: "DELETE" }).catch(() => {});      // the quick version was only for measuring: no leftover file
  } catch (e) { box.replaceChildren(el("p", { class: "hint warn", text: errText(e) })); return; } finally { b.disabled = false; }
  renderCheck(); renderTimeline();
}
const PROBLEM = { loud: ["Too loud", "#ff6b8a"], quiet: ["Too quiet", "#ffd166"], silent: ["Silent", "#9aa0ad"], noisy: ["Noise", "#c08cff"], clipped: ["Clipped", "#ff4d4d"] };
S.probTab = "all";
function probDot(col) { const d = el("i", { class: "prob-dot" }); d.style.background = col; return d; }
/** Clipped spots in the recording itself (the wave picture touches the top), in finished-video time. */
function clippedSpots() {
  const out = [], add = (a, b) => { const l = out[out.length - 1]; if (l && a - l.end < 1) l.end = Math.max(l.end, b); else out.push({ kind: "clipped", start: a, end: b }); };
  for (const r of layout()) {
    const p = r.p; if (p.mute) continue;
    const srcs = stemsOn() ? Layers.NAMES.map((n) => [(S.stemPeaks || {})[n], Layers.split().start, 50, Layers.gainOf(n) * Layers.ownGain(p, n) * p.volume]) : [[S.peaks, 0, S.peakRate || 50, p.volume]];
    for (const [P, off, R, g] of srcs) {
      if (!P || !P.length || g < 0.5) continue;
      let hits = 0, first = -1;
      for (let i = Math.max(0, Math.floor((p.start - off) * R)); i < Math.min(P.length, Math.ceil((p.end - off) * R)); i++) {
        if (P[i] >= 253) { hits++; if (first < 0) first = i; }
      }
      if (hits >= 3) { const ts = first / R + off, t = r.out0 + (p.reverse ? p.end - ts : ts - p.start) / p.speed; add(Math.max(r.out0, t - 0.5), Math.min(r.out1, t + 2)); }
    }
  }
  return out;
}
function renderCheck() {
  const box = $("mixCheck"), c = S.check; if (!box || !c) return;
  const m = c.loudness, all = c.problems.concat(c.clipped || []).sort((a, b) => a.start - b.start);
  const old = c.sig !== JSON.stringify([S.proj.pieces, S.proj.settings]);
  const counts = {}; for (const x of all) counts[x.kind] = (counts[x.kind] || 0) + 1;
  if (S.probTab !== "all" && !counts[S.probTab]) S.probTab = "all";
  const tabs = el("div", { class: "prob-tabs" }, ...[["all", "All", null]].concat(Object.keys(PROBLEM).filter((k) => counts[k]).map((k) => [k, PROBLEM[k][0], PROBLEM[k][1]])).map(([k, l, col]) =>
    el("button", { type: "button", class: "prob-tab" + (S.probTab === k ? " on" : ""), onclick: () => { S.probTab = k; renderCheck(); } },
      col ? probDot(col) : null, el("span", { text: l }), el("small", { class: "num", text: String(k === "all" ? all.length : counts[k]) }))));
  const shown = all.filter((x) => S.probTab === "all" || x.kind === S.probTab);
  const list = el("div", { class: "prob-list" });
  for (const x of shown.slice(0, S.probMore ? 200 : 6)) {
    list.append(el("div", { class: "prob-row", onclick: () => { seek(x.start); } },
      probDot(PROBLEM[x.kind][1]), el("span", { class: "prob-kind", text: PROBLEM[x.kind][0] }),
      el("span", { class: "num note", text: fmtTime(x.start, 0) + " – " + fmtTime(x.end, 0) }),
      el("span", { class: "grow" }),
      x.kind === "silent" ? btn("Remove", { cls: "sm ghost", title: "Take the silence out of the video", onclick: (e) => { e.stopPropagation(); removeSilenceDialog(); } })
        : btn("Fix", { cls: "sm ghost", title: FIX_TIP[x.kind], onclick: (e) => { e.stopPropagation(); fixProblems([x]); } })));
  }
  if (shown.length > 6) list.append(el("button", { type: "button", class: "link-btn", text: S.probMore ? "Show fewer" : "Show all " + shown.length, onclick: () => { S.probMore = !S.probMore; renderCheck(); } }));
  const verdict = !all.length ? ["good", "No problems found: even, clean and at the right level all the way."]
    : ["warn", all.length + " problem" + (all.length > 1 ? "s" : "") + " found. Click one to go there. They also show on the Loudness strip under the tracks."];
  box.replaceChildren(
    el("div", { class: "check-nums" },
      el("span", {}, el("small", { text: "Whole video" }), el("b", { class: "num", text: m ? m.lufs.toFixed(1) + " LUFS" : "—" })),
      el("span", {}, el("small", { text: "Highest peak" }), el("b", { class: "num", text: m ? m.true_peak.toFixed(1) + " dB" : "—" })),
      el("span", {}, el("small", { text: "Aim" }), el("b", { class: "num", text: final_target() + " LUFS" }))),
    el("p", { class: "hint " + verdict[0], text: verdict[1] }),
    old ? el("p", { class: "hint", text: "You changed things since this check. Press Find problems again to see the new result." }) : null,
    all.length ? tabs : null, all.length ? list : null,
    all.some((x) => x.kind !== "silent") ? btn("Fix all (" + all.filter((x) => x.kind !== "silent").length + ")", { icon: "pulse", cls: "wide", title: "Level for too loud and too quiet, Clean for noise, a little lower and Level for clipped spots", onclick: () => fixProblems(all) }) : null);
}
const FIX_TIP = { loud: "Level (medium) for the parts here", quiet: "Level (medium) for the parts here", noisy: "Clean (medium) for the parts here", clipped: "A little lower and Level (medium) for the parts here" };
function final_target() { const MF = { youtube: -14, tiktok: -14, instagram: -14, podcast: -16, tv: -23 }; return (MF[S.proj.settings.made_for] || -14) + 1.5 * (+S.proj.settings.loudness_step || 0); }
/** Fix problems: Level for too loud / too quiet, Clean for noise, lower and Level for clipped spots, for everything that plays there. */
function fixProblems(list) {
  const c = S.check; if (!c) return;
  list = (list || c.problems).filter((x) => x.kind !== "silent"); if (!list.length) return;
  const kinds = (a, b) => new Set(list.filter((x) => a < x.end && b > x.start).map((x) => x.kind));
  const apply = (sh, ks) => {
    let did = false;
    if ((ks.has("loud") || ks.has("quiet") || ks.has("clipped")) && !sh.even) { sh.even = 3; did = true; }
    if (ks.has("noisy") && !sh.nr) { sh.nr = 2; did = true; }
    if (ks.has("clipped") && (sh.volume === undefined || sh.volume > 0.7)) { sh.volume = 0.7; did = true; }
    return did;
  };
  let n = 0;
  if (!change(() => {
    for (const r of layout()) {
      const ks = kinds(r.out0, r.out1); if (!ks.size) continue;
      const p = r.p;
      if (stemsOn()) {
        for (const k of Layers.NAMES) { if (partLocked(p, k)) continue; const m = Object.assign({}, p.mix || {}); m[k] = Object.assign({ volume: 1, mute: false }, m[k] || {}); if (apply(m[k], ks)) n++; p.mix = m; }
      } else if (apply(p, ks)) n++;
    }
    layers().forEach((x, i) => {
      if (musicLocked(i)) return;
      const ps = mparts(x).map((q) => Object.assign({ volume: 1, mute: false }, q));
      mspans(x).forEach((r) => { const ks = kinds(r.a, r.b); ks.delete("noisy"); ks.delete("clipped"); if (ks.size && !(r.q.even === undefined ? x.auto : r.q.even)) { ps[r.k].even = 3; n++; } });
      setLayer(i, { parts: ps });
    });
  }, { sound: true, keepVideo: true })) return;
  toast(n ? "Fixed " + n + " part" + (n === 1 ? "" : "s") + ". Press Find problems again to check." : "Those parts are already fixed (or locked).");
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
  for (const x of c.problems.concat(c.clipped || [])) { g.globalAlpha = .26; g.fillStyle = PROBLEM[x.kind][1]; g.fillRect(px(x.start) - left, 0, Math.max(2, px(x.end) - px(x.start)), H); g.globalAlpha = 1; }
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
        const g = Layers.gainOf(n) * Layers.ownGain(p, n) * p.volume * partShapeGain(p, n, ts) * stemDuckGain(n, ts) * lineAt((S.proj.settings.vline || {})[n], t);
        const a = pk((S.stemPeaks || {})[n], ts - sp.start) * g; pw += a * a;
      }
    } else { const a = pk(S.peaks, ts) * p.volume * partShapeGain(p, "original", ts) * lineAt((S.proj.settings.vline || {}).original, t); pw += a * a; }
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
const DUCK_DOWN = 0.35, DUCK_UP = 0.8, DUCK_LEVEL = 0.35;
function mparts(x) { return x.parts && x.parts.length ? x.parts : [{ end: null, volume: 1, mute: false }]; }
/** The parts of a music track as they lie on the timeline: { k, a, b, q }. */
function mspans(x) {
  const T = rawTotal(), out = []; let a = 0, src = +x.start || 0;
  mparts(x).forEach((q, k) => {
    const b = q.end === null || q.end === undefined ? T : Math.min(T, q.end);
    if (q.from !== undefined && q.from !== null) src = +q.from;          // a part that was moved keeps its own bit of the song
    if (b > a + 1e-6) out.push({ k, a, b, q, src });
    src += Math.max(0, b - a); a = Math.max(a, b);
  });
  return out;
}
/** Where in the song file a music track is at timeline time t (null: a gap / deleted part). */
function songAt(x, t) { for (const r of mspans(x)) if (t >= r.a && t < r.b) return r.q.mute ? null : r.src + (t - r.a); return null; }
function songTime(x, m, t) { const v = songAt(x, t); return v === null || !m.duration ? null : v % m.duration; }
function partGain(x, t) { for (const r of mspans(x)) if (t >= r.a && t < r.b) return r.q.mute ? 0 : +r.q.volume; return 1; }
/** How low something goes under each track: { voices: 0.3, effects: 0.1 } (empty: it does not go down). Older projects
 *  saved one track and one level ({ level, under }); they read as the same. */
function duckOf(dk, own, def) {
  if (!dk || !dk.on) return {};
  if (dk.by) { const out = {}; for (const k of Object.keys(UNDER)) if (k !== own && dk.by[k] !== undefined && dk.by[k] !== null) out[k] = +dk.by[k]; return out; }
  const u = dk.under || def; return u === own ? {} : { [u]: dk.level === undefined ? DUCK_LEVEL : +dk.level };
}
/** Gain at time t under stretches [[a, b], ...] (already widened): down to low, gradually. */
function spanGain(spans, low, t) {
  for (const [a, b] of spans || []) {
    if (t < a) break;
    if (t <= b) return 1 - (1 - low) * clamp(Math.min((t - a) / DUCK_DOWN, (b - t) / DUCK_UP), 0, 1);
  }
  return 1;
}
function duckGain(x, t) {
  let g = 1;
  for (const [k, low] of Object.entries(duckOf(x.duck, null, "voices"))) g = Math.min(g, spanGain((S.duckBy || {})[k], low, t));
  return g;
}
const UNDER = { voices: "Voices", music: "Music", effects: "Effects" };
/** A split track that goes down while another one is heard: its live gain at source time t. */
function stemDuckGain(n, t) {
  let g = 1;
  for (const [k, low] of Object.entries(duckOf((S.proj.settings.ducks || {})[n], n, n === "voices" ? "music" : "voices"))) {
    const act = (S.acts || {})[k]; if (!act) continue;
    if (!act.spans) act.spans = joinSpans(act.ranges.map(([a, b]) => [a, b]), 1e9);
    g = Math.min(g, spanGain(act.spans, low, t));
  }
  return g;
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
/** Set (or switch off) the going down of a whole split track. by: { voices: 0.3, ... } (empty: off). */
async function setStemDuck(n, by) {
  if (trackLocked(n)) { lockedNote(n); renderInspector(); return; }
  const on = Object.keys(by).length > 0;
  change(() => { const d = Object.assign({}, S.proj.settings.ducks || {}); if (on) d[n] = { on: true, by }; else delete d[n]; S.proj.settings.ducks = d; }, { keepVideo: true });
  await loadUnder(by, Layers.TITLE[n]);
  Layers.apply(); renderInspector();
}
/** Find when each of these tracks is heard (once), and say so when one of them has nothing. */
async function loadUnder(by, what) {
  for (const k of Object.keys(by)) {
    const v = await loadVoices(false, k);
    if (v && !v.ranges.length) toast("Nothing was found on the " + UNDER[k] + " track, so " + what + " does not go down under it.", true);
  }
}
/** The 'go down while other tracks are heard' box: one switch for it all, then each track on its own with its own level
 *  (for example 30 % under voices and 10 % under effects at the same time). */
function duckEditor(title, own, def, by, lk, onset, hint) {
  const on = Object.keys(by).length > 0;
  const sw = el("input", { type: "checkbox", class: "sw", "aria-label": title }); sw.checked = on; sw.disabled = lk;
  sw.addEventListener("change", () => onset(sw.checked ? { [def]: DUCK_LEVEL } : {}));
  const rows = Object.keys(UNDER).filter((k) => k !== own).map((k) => {
    const has = by[k] !== undefined, lv = has ? by[k] : DUCK_LEVEL;
    const ck = el("input", { type: "checkbox", class: "sw sm", "aria-label": "Go down under " + UNDER[k] }); ck.checked = has; ck.disabled = lk;
    ck.addEventListener("change", () => {
      if (ck.checked && k !== "voices" && !stemsOn()) { toast("Split the sound first (Sound panel): then it can go down under " + UNDER[k] + ".", true); ck.checked = false; return; }
      const nb = Object.assign({}, by); if (ck.checked) nb[k] = lv; else delete nb[k]; onset(nb);
    });
    const val = el("b", { class: "num", text: Math.round(lv * 100) + "%" });
    const r = el("input", { type: "range", class: "rng", min: "0", max: "80", step: "1", value: String(Math.round(lv * 100)), "aria-label": "Loudness under " + UNDER[k] });
    r.disabled = lk || !has;
    r.addEventListener("input", () => { val.textContent = r.value + "%"; paintRange(r); });
    r.addEventListener("change", () => onset(Object.assign({}, by, { [k]: r.value / 100 })));
    setTimeout(() => paintRange(r), 0);
    const act = (S.acts || {})[k];
    const note = !has ? "" : !act ? "listening…" : act.ranges.length + " stretch" + (act.ranges.length === 1 ? "" : "es");
    return el("div", { class: "duck-row" + (has ? " on" : ""), "data-under": k },
      el("label", { class: "swl" }, el("span", {}, "Under ", el("b", { text: UNDER[k] }), " ", el("small", { class: "note", text: note })), ck),
      el("div", { class: "field" }, el("span", {}, "Loudness then ", val), r));
  });
  return el("div", { class: "pad duck-box" },
    el("label", { class: "swl" }, el("span", {}, el("b", { text: title })), sw),
    on ? el("div", { class: "duck-rows" }, ...rows) : null,
    el("p", { class: "hint", text: hint }));
}
/** The 'Go down while ... is heard' box of a split track. */
function stemDuckBox(n, lk) {
  const def = n === "voices" ? "music" : "voices", by = duckOf((S.proj.settings.ducks || {})[n], n, def);
  for (const k of Object.keys(by)) if (!(S.acts || {})[k]) loadVoices(false, k);
  return duckEditor("Whole " + Layers.TITLE[n].split(" (")[0] + " track: go down while others are heard", n, def, by, lk, (nb) => setStemDuck(n, nb),
    "Each track you switch on has its own level. Where two are heard at once, the lower level counts.");
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
function ducksOn(x) { return Object.keys(duckOf(x.duck, null, "voices")).length > 0; }
function ducking() { return layers().some((x) => Object.keys(duckOf(x.duck, null, "voices")).length > 0); }
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
  for (const x of layers()) for (const k of Object.keys(duckOf(x.duck, null, "voices"))) need.add(k);
  for (const [n, dk] of Object.entries(S.proj.settings.ducks || {})) for (const k of Object.keys(duckOf(dk, n, n === "voices" ? "music" : "voices"))) need.add(k);
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
    toast("Song set to " + Math.round(vol * 100) + "% by itself (from how loud it is). It goes down to 35% while people talk and fades in and out over 3 s.");
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
  change(() => { const ps = clone(mparts(x)); ps.splice(r.k, 0, Object.assign({}, ps[r.k], { end: +t.toFixed(3) })); delete ps[r.k + 1].from; if (ps[r.k].from === undefined && r.q.from !== undefined) ps[r.k].from = r.q.from; setLayer(i, { parts: ps }); }, { keepVideo: true });
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
/** How low a song goes under each track: by = { voices: 0.3, effects: 0.1 } (empty: it does not go down). */
async function setDuck(i, by) {
  const x = layers()[i]; if (!x) return;
  const why = musicLocked(i); if (why) { toast(why, true); renderInspector(); return; }
  const on = Object.keys(by).length > 0;
  change(() => { setLayer(i, { duck: on ? { on: true, by } : { on: false } }); }, { keepVideo: true });
  await loadUnder(by, "the music");
  if (S.playing) musicPlay();
  renderInspector();
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
  const x = layers()[i], spans = mspans(x), r = spans.find((q) => q.k === k), pr = part.getBoundingClientRect();
  const edge = !r || e.shiftKey || add ? null : e.clientX - pr.left <= 6 && r.a > 0.001 ? "left" : pr.right - e.clientX <= 6 && r.b < rawTotal() - 0.001 ? "right" : null;
  if (!edge) seek(clamp(timeAt(e.clientX - rect.left + sc.scrollLeft), 0, Math.max(0, rawTotal() - 0.01)));
  refreshAll({ keepVideo: true });
  if (r && !e.shiftKey && !add && !musicLocked(i)) musicDrag(e, i, r, edge);
  return true;
}
/** Drag a music part: from its middle it moves (its sound goes with it, like CapCut; what it lands on is covered, and
 *  where it was becomes a gap); from an edge, the cut between it and its neighbour moves. */
function musicDrag(e, i, r, edge) {
  const x0 = e.clientX, T = rawTotal();
  let d = 0, live = false;
  const node = () => document.querySelector('.mrow[data-i="' + i + '"] .mpart[data-k="' + r.k + '"]');
  const move = (ev) => {
    d = (ev.clientX - x0) / S.pps;
    if (!live && Math.abs(ev.clientX - x0) < 4) return;
    live = true; document.body.classList.add("dragging");
    const n = node(); if (!n) return;
    if (edge === "left") { const a = clamp(r.a + d, 0.05, r.b - 0.05); n.style.left = px(a) + "px"; n.style.width = Math.max(6, px(r.b) - px(a) - 2) + "px"; }
    else if (edge === "right") { const b = clamp(r.b + d, r.a + 0.05, T - 0.05); n.style.width = Math.max(6, px(b) - px(r.a) - 2) + "px"; }
    else { const len = r.b - r.a; const a = clamp(r.a + d, 0, Math.max(0, T - Math.min(len, T) )); n.style.left = px(a) + "px"; n.classList.add("moving"); }
  };
  const up = () => {
    window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
    document.body.classList.remove("dragging");
    if (!live || Math.abs(d) < 0.01) return;
    if (edge) moveMusicCut(i, edge === "left" ? r.k - 1 : r.k, (edge === "left" ? r.a : r.b) + d);
    else moveMusicPart(i, r.k, d);
  };
  window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
}
/** The parts as clips on the timeline, each with its own place in the song: [{ a, b, src, q }]. */
function musicClips(x) { return mspans(x).map((r) => ({ a: r.a, b: r.b, src: r.src, q: Object.assign({}, r.q) })); }
/** Clips back to parts. A part only says where it plays from in the song when it does not simply follow on from the
 *  part before it (so "Song starts at" still moves a song that was only cut). Gaps next to each other become one. */
function clipsToParts(clips, skip) {
  const T = rawTotal(), out = [];
  let a = 0, src = +skip || 0;
  for (const c of clips.filter((c) => c.b - c.a > 0.02).sort((u, v) => u.a - v.a)) {
    const last = out[out.length - 1];
    if (last && last.mute && c.q.mute && last._b >= c.a - 1e-6) { last._b = c.b; src += c.b - a; a = c.b; continue; }
    const q = Object.assign({}, c.q); delete q.from;
    if (Math.abs(c.src - src) > 0.001) q.from = +c.src.toFixed(3);
    q._b = c.b; out.push(q); src = c.src + (c.b - c.a); a = c.b;
  }
  out.forEach((q, j) => { q.end = j === out.length - 1 || q._b >= T - 0.001 ? null : +q._b.toFixed(3); delete q._b; });
  return out;
}
const GAP = { volume: 1, mute: true };
function moveMusicPart(i, k, d) {
  const x = layers()[i], why = musicLocked(i); if (!x) return; if (why) { toast(why, true); return; }
  const T = rawTotal(), clips = musicClips(x), j = mspans(x).findIndex((r) => r.k === k);
  if (j < 0) return;
  const c = clips[j], last = j === clips.length - 1, len = c.b - c.a;
  const na = clamp(c.a + d, 0, last ? T - 0.1 : T - len), nb = last ? T : Math.min(T, na + len);
  const rest = [];
  clips.forEach((o, n) => {
    if (n === j) { rest.push({ a: o.a, b: o.b, src: o.src, q: Object.assign({}, GAP) }); return; }
    rest.push(o);
  });
  const out = [];
  for (const o of rest) {                                  // what the moved part lands on is covered (cut away)
    if (o.b <= na || o.a >= nb) { out.push(o); continue; }
    if (o.a < na) out.push({ a: o.a, b: na, src: o.src, q: o.q });
    if (o.b > nb) out.push({ a: nb, b: o.b, src: o.src + (nb - o.a), q: o.q });
  }
  out.push({ a: na, b: nb, src: c.src, q: c.q });
  change(() => setLayer(i, { parts: clipsToParts(out, x.start) }), { keepVideo: true });
  const nk = mspans(layers()[i]).findIndex((r) => Math.abs(r.a - na) < 0.002);
  S.msel = { i, ks: new Set(nk >= 0 ? [mspans(layers()[i])[nk].k] : []) };
  refreshAll({ keepVideo: true }); if (S.playing) musicPlay(); else musicSync();
  toast("Music part moved by " + (d > 0 ? "+" : "−") + Math.abs(d).toFixed(2) + " s. Ctrl + Z to undo.");
}
/** Move the cut between part k and the next one to time t; both keep their sound where it was (the next part starts later or earlier in the song). */
function moveMusicCut(i, k, t) {
  const x = layers()[i], why = musicLocked(i); if (!x) return; if (why) { toast(why, true); return; }
  const sp = mspans(x), j = sp.findIndex((r) => r.k === k); if (j < 0 || j >= sp.length - 1) return;
  const clips = musicClips(x), L = clips[j], R = clips[j + 1];
  t = clamp(t, L.a + 0.05, R.b - 0.05);
  R.src += t - R.a; R.a = t; L.b = t;
  change(() => setLayer(i, { parts: clipsToParts(clips, x.start) }), { keepVideo: true });
  refreshAll({ keepVideo: true }); if (S.playing) musicPlay(); else musicSync();
}
/** Take the chosen parts out of the song and close the gap: what comes after moves earlier (like deleting in CapCut). */
function deleteMusicParts(close) {
  const i = S.msel && S.msel.i, x = layers()[i]; if (!x) return;
  const why = musicLocked(i); if (why) { toast(why, true); return; }
  const ks = S.msel.ks; if (!ks.size) return;
  if (!close) { musicChange((c) => { c.mute = true; }); refreshAll({ keepVideo: true }); return; }
  const T = rawTotal(), sp = mspans(x), out = []; let shift = 0;
  sp.forEach((r) => {
    const gone = ks.has(r.k) && r.b < T - 0.001;           // (the last part is only emptied: nothing comes after it)
    if (gone) { shift += r.b - r.a; return; }
    out.push({ a: r.a - shift, b: r.b >= T - 0.001 ? T : r.b - shift, src: r.src, q: Object.assign({}, r.q, ks.has(r.k) ? GAP : {}) });
  });
  change(() => setLayer(i, { parts: clipsToParts(out, x.start) }), { keepVideo: true });
  S.msel = { i, ks: new Set() };
  refreshAll({ keepVideo: true }); if (S.playing) musicPlay(); else musicSync();
  toast("Taken out of the song; what came after moved up. Ctrl + Z to undo.");
}
function musicMenuItems(i, t) {
  const x = layers()[i], lk = !!musicLocked(i), list = mselList(), n = list.length, allMuted = n && list.every((q) => q.q.mute);
  const set = (patch) => { change(() => setLayer(i, patch), { keepVideo: true }); renderMusicLayers(); if (S.playing) musicPlay(); };
  return [
    ["Cut the music here", "split", () => cutMusic(i, t), { key: "S", off: lk }],
    n ? ["Delete and close the gap", "trash", () => deleteMusicParts(true), { key: "Shift+Del", off: lk }] : null,
    n ? [allMuted ? "Turn these parts on" : "Delete, leave a gap (mute)", allMuted ? "vol" : "mute", () => musicChange((c) => { c.mute = !allMuted; }), { key: "Del", off: lk }] : null,
    n ? ["Loudness", "sliders", null, { off: lk, sub: loudnessItems((v) => musicChange((c) => { c.volume = v; c.mute = false; }), () => normaliseMusic(false), n > 1 ? () => normaliseMusic(true) : null) }] : null,
    n > 1 ? ["Join these parts", "combine", () => joinMusicParts(), { off: lk }] : null,
    n ? ["Level and fades", "pulse", null, { off: lk, sub: [
      ...LEVELS.map(([v, l]) => ["Level: " + l.toLowerCase(), v ? "pulse" : "x", () => musicChange((c) => { c.even = v; })]), "-",
      ["Gentle fade in and out (1 s)", "sliders", () => musicChange((c) => { c.fin = 1; c.fout = 1; })], ["No fades", "x", () => musicChange((c) => { delete c.fin; delete c.fout; })]] }] : null,
    ...(n ? shapeMenuItems((k) => same(list.map((q) => q.q[k] || 0)), (k, v) => musicChange((c) => { if (v) c[k] = v; else delete c[k]; }), lk, false) : []),
    ["Volume line", "pulse", null, { sub: lineItems("song:" + i, t) }],
    ["Back", "restore", null, { sub: backItems(["Songs", "Volume lines"]) }],
    "-",
    [ducksOn(x) ? "Stop going down under other tracks" : "Go down under voices", "vol", () => setDuck(i, ducksOn(x) ? {} : { voices: DUCK_LEVEL }), { off: lk }],
    [x.mute ? "Turn this music on" : "Mute this music", x.mute ? "vol" : "mute", () => set({ mute: !x.mute })],
    [x.solo ? "Stop solo" : "Hear only this (solo)", "target", () => set({ solo: !x.solo })],
    [x.locked ? "Unlock this music" : "Lock this music", x.locked ? "unlock" : "lock", () => set({ locked: !x.locked })],
    "-", ["Remove this music", "trash", () => { change(() => { S.proj.settings.layers = layers().filter((_, k) => k !== i); }, { keepVideo: true }); S.msel = null; renderMusicLayers(); musicPlay(); if (!S.playing) musicPause(); }, { danger: true, off: lk }],
  ].filter(Boolean);
}
/** One part: which bit of the song it plays (type a time, or nudge it), without moving the part on the timeline. */
function partFromField(x, i, r, lk) {
  const m = MUSIC.get(x.file), D = m && m.duration;
  const inp = el("input", { class: "input short", value: fmtTime(r.src, 2), "aria-label": "Where in the song this part plays from", inputmode: "decimal", title: "Minutes:seconds into the song, for example 1:05.5" });
  const set = (v) => {
    if (v === null || !isFinite(v) || v < 0) { toast("Type a time like 1:05 (minutes:seconds).", true); inp.value = fmtTime(r.src, 2); return; }
    if (D) v = Math.min(v, Math.max(0, D - 0.05));
    const why = musicLocked(i); if (why) { toast(why, true); return; }
    const clips = musicClips(x), j = mspans(x).findIndex((q) => q.k === r.k); if (j < 0) return;
    clips[j].src = v;
    change(() => setLayer(i, { parts: clipsToParts(clips, x.start) }), { keepVideo: true });
    refreshAll({ keepVideo: true }); if (S.playing) musicPlay(); else musicSync();
  };
  const parse = (v) => { const p = String(v).trim().split(":").map(Number); if (p.some((n) => !isFinite(n))) return null; return p.length === 2 ? p[0] * 60 + p[1] : p.length === 1 ? p[0] : null; };
  inp.addEventListener("change", () => { const v = parse(inp.value); setTimeout(() => set(v), 0); });
  inp.disabled = !!lk;
  const nudge = (s) => btn((s > 0 ? "+" : "−") + Math.abs(s) + " s", { cls: "sm ghost", title: "Play a bit " + (s > 0 ? "later" : "earlier") + " in the song", onclick: () => { if (!lk) set(Math.max(0, r.src + s)); } });
  return el("div", { class: "field song-start" }, el("span", {}, "This part plays the song from ", el("small", { class: "note", text: D ? "of " + fmtTime(D, 0) : "" })),
    el("div", { class: "row" }, inp, nudge(-1), nudge(1)));
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
    const r = el("input", { type: "range", class: "rng", min: "0", max: "500", step: "1", value: String(Math.round((v === null ? 1 : v) * 100)), "aria-label": aria });
    r.addEventListener("input", () => { val.textContent = r.value + "%"; paintRange(r); });
    r.addEventListener("change", () => onset(r.value / 100));
    r.disabled = lk; setTimeout(() => paintRange(r), 0);
    return el("div", { class: "field" }, el("span", {}, label + " ", val, el("small", { class: "note", text: " (up to 500%)" })), r);
  };
  const vols = [...new Set(list.map((q) => +q.q.volume))], mutes = [...new Set(list.map((q) => !!q.q.mute))];
  const mute = el("input", { type: "checkbox", class: "sw", "aria-label": "Mute the chosen parts" });
  mute.checked = mutes.length === 1 && mutes[0]; mute.indeterminate = mutes.length > 1; mute.disabled = lk;
  mute.addEventListener("change", () => musicChange((c) => { c.mute = mute.checked; }));
  const dby = duckOf(x.duck, null, "voices");
  const dfrom = (S.acts || {}).voices;
  const dhint = !Object.keys(dby).length ? "The music goes down gradually while the tracks you choose are heard, and comes back up after. Each track has its own level."
    : dby.voices !== undefined && dfrom && dfrom.from !== "voices" && !stemsOn() ? "Talking is guessed from the plain sound. Split the sound for a much better result."
      : "They show as dips on the music. Where two are heard at once, the lower level counts.";
  R.append(el("div", { class: "pad" },
    list.length ? rng("Chosen parts", vols.length === 1 ? vols[0] : null, (v) => musicChange((c) => { c.volume = v; c.mute = false; }), "Loudness of the chosen music parts") : null,
    list.length ? el("label", { class: "swl" }, el("span", { text: "Mute the chosen parts" }), mute) : null,
    list.length ? el("div", { class: "btns" },
      btn("Same loudness", { icon: "sliders", title: "Each chosen part as a whole goes up or down, so they all sound equally loud (up to 200%). Inside a part nothing changes: for that use Even out.", onclick: () => normaliseMusic(false) }),
      btn("Keep balance", { icon: "sliders", cls: "ghost", title: "The chosen parts go up or down together by the same amount, so their balance stays", onclick: () => normaliseMusic(true) })) : null,
    list.length ? el("div", { class: "btns" },
      btn("Delete, close gap", { icon: "trash", cls: "ghost", title: "Take the chosen parts out of the song; what comes after moves up (Shift + Delete)", onclick: () => deleteMusicParts(true) }),
      btn("Leave a gap", { icon: "mute", cls: "ghost", title: "Silence the chosen parts and keep everything where it is (Delete)", onclick: () => deleteMusicParts(false) })) : null,
    list.length === 1 && !list[0].q.mute ? partFromField(x, i, list[0], lk) : null,
    el("div", { class: "btns" },
      btn("Cut here", { icon: "split", title: "Cut the music at the playhead (S). The video is not cut.", onclick: () => cutMusic(i, S.t) }),
      list.length > 1 ? btn("Join", { icon: "combine", cls: "ghost", title: "Make the chosen parts one part again", onclick: joinMusicParts }) : btn("Full loudness", { icon: "restore", cls: "ghost", onclick: () => musicChange((c) => { c.volume = 1; c.mute = false; }) })),
    list.length ? evenField(same(list.map((q) => (q.q.even === undefined ? x.auto || 0 : q.q.even))), (v) => musicChange((c) => { c.even = v; }), lk,
      "Only the chosen parts. Parts that are fine are not changed.") : null,
    list.length ? fadeFields(same(list.map((q) => q.q.fin || 0)), same(list.map((q) => q.q.fout || 0)), (k, v) => musicChange((c) => { if (v > 0) c[k] = v; else delete c[k]; }), lk) : null,
    list.length ? shapeBox((k) => same(list.map((q) => q.q[k] || (k === "tone" ? "" : 0))),
      (k, v) => musicChange((c) => { if (k === "__all") for (const x of TONE_KEYS) delete c[x]; else if (v) c[k] = v; else delete c[k]; }), lk,
      { title: "Shape the chosen parts", dyn: false }) : null));
  const setTrack = (patch) => { if (musicLocked(i)) { toast(musicLocked(i), true); renderInspector(); return; } change(() => setLayer(i, patch), { keepVideo: true }); renderMusicLayers(); if (S.playing) musicPlay(); };

  R.append(el("div", { class: "pad track-box" },
    el("div", { class: "field" }, el("span", {}, el("b", { text: "Whole song" })) ),
    evenField(x.auto || 0, (v) => setTrack({ auto: v }), lk, "Level for the whole song. A part's own Level (above) wins for that part."),
    rng("Loudness", x.volume, (v) => setTrack({ volume: v }), "Loudness of the whole music track"),
    songStartField(x, setTrack, lk),
    el("div", { class: "btns" },
      btn("Ends with the video", { icon: "outp", cls: "sm ghost", title: "Start the song so its own ending lands at the end of the video", onclick: () => songEndsWithVideo(i) }),
      btn("Cuts on the beat", { icon: "magnet", cls: "sm ghost", title: "Move each cut between sections a little, so it lands on a beat of this song", onclick: () => cutsOnBeat(i) })),
    fadeFields(x.fade_in === undefined ? 0.5 : x.fade_in, x.fade_out === undefined ? 1.5 : x.fade_out, (k, v) => setTrack(k === "fin" ? { fade_in: v } : { fade_out: v }), lk,
      ["Song fades in", "Song fades out"]),
    shapeBox((k) => (x.shape || {})[k] || (k === "tone" ? "" : 0),
      (k, v) => { const sh = Object.assign({}, x.shape || {}); if (k === "__all") for (const y of TONE_KEYS) delete sh[y]; else if (v) sh[k] = v; else delete sh[k]; setTrack({ shape: Object.keys(sh).length ? sh : undefined }); renderInspector(); }, lk,
      { title: "Shape the whole song" })));
  R.append(duckEditor("Go down while other tracks are heard", null, "voices", dby, lk, (nb) => setDuck(i, nb), dhint));
  R.append(el("div", { class: "pad" },
    btn(x.locked ? "Unlock this music" : "Lock this music", { icon: x.locked ? "unlock" : "lock", cls: "ghost wide", onclick: () => { change(() => setLayer(i, { locked: !x.locked }), { any: true }); } }),
    el("p", { class: "hint", text: "Click a part on the music track (Ctrl + click for more, Shift + click for all in between). S cuts the music at the playhead. Drag a part to move it (its sound goes with it), or drag its edge to move the cut. Delete leaves a gap; Shift + Delete takes the part out of the song and closes the gap. " +
      "The export is made ready for YouTube by itself: the whole mix is set to -14 LUFS with peaks under -1 dB." })));
  for (const k of Object.keys(dby)) if (!(S.acts || {})[k]) loadVoices(false, k);
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
  const colour = { voices: "#5ab8ff", music: "#c08cff", effects: "#ffb35a", found: "#7ee081", found_voices: "#8fd0ff", found_music: "#d6b4ff", found_effects: "#ffcf8f" };
  for (const lane of box.querySelectorAll(".lane.stem")) {
    const n = lane.dataset.layer, cv = lane.querySelector("canvas"), P = S.stemPeaks[n];
    const whole = kept().length && kept().every((p) => aselHas(p, n));
    const head = lane.querySelector(".stem-head");
    head.classList.toggle("on", whole);
    const sig = [keyMuted(n), keySolo(n), trackLocked(n)].join();
    if (head.dataset.sig !== sig) {                // rebuilt only when it changed, so a click is never lost to a redraw
      head.dataset.sig = sig;
      for (const b of head.querySelectorAll(".lock-btn, .lh-btn")) b.remove();
      head.append(...msBtns(n, Layers.TITLE[n].toLowerCase()), lockBtn(n));
    }
    lane.classList.toggle("track-locked", trackLocked(n) || trackLocked("sound"));
    const g0 = Layers.gainOf(n);
    lane.classList.toggle("muted", g0 < 0.001 || !keyHeard(n));
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
  if (e.target.closest(".lock-btn, .lh-btn")) return true;
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
      for (const k of SHAPE_KEYS) if (!cur[k]) delete cur[k];
      if (!cur.mute && Math.abs(cur.volume - 1) < 0.001 && !cur.group && !SHAPE_KEYS.some((k) => cur[k])) delete m[n]; else m[n] = cur;
      if (!cur.group) delete cur.group;
      if (Object.keys(m).length) p.mix = m; else delete p.mix;
    }
  }, { sound: true });
  Layers.apply();
}
function stemMenu(e) {
  const lane = e.target.closest(".lane.stem"); if (!lane) return false;
  e.preventDefault();
  const n = lane.dataset.layer, sc = $("tlScroll"), rect = sc.getBoundingClientRect();
  const t = clamp(timeAt(e.clientX - rect.left + sc.scrollLeft), 0, Math.max(0, rawTotal() - 0.01));
  if (e.target.closest(".stem-head") || !aselList().length) { S.sel.clear(); S.asel = new Map(); for (const p of kept()) aselSet(p, n, true); refreshAll({ keepVideo: true }); }
  else { const at = segAt(t); if (at && !aselHas(at.s.p, n)) { S.sel.clear(); S.asel = new Map(); aselSet(at.s.p, n, true); S.aAnchor = { p: at.s.p, n }; refreshAll({ keepVideo: true }); } }
  const list = aselList(), allMuted = list.every(({ p, n: k }) => Layers.ownGain(p, k) < 0.001), lk = list.every(({ p, n: k }) => partLocked(p, k));
  const val = (k) => same(list.map(({ p, n: q }) => (p.mix && p.mix[q] && p.mix[q][k]) || 0));
  const put = (k, v) => stemChange((c) => { c[k] = v; });
  ctxMenu([
    [allMuted ? "Turn these parts on" : "Mute these parts", allMuted ? "vol" : "mute", () => stemChange((c) => { c.mute = !allMuted; }), { key: "Del", off: lk }],
    ["Loudness", "sliders", null, { off: lk, sub: loudnessItems((v) => stemChange((c) => { c.volume = v; c.mute = false; }), () => normaliseParts(false), () => normaliseParts(true)) }],
    ["Level and fades", "pulse", null, { off: lk, sub: [
      ...LEVELS.map(([v, l]) => ["Level: " + l.toLowerCase(), v ? "pulse" : "x", () => put("even", v), { on: val("even") === v }]), "-",
      ["Gentle fade in and out (1 s)", "sliders", () => stemChange((c) => { c.fin = 1; c.fout = 1; })], ["No fades", "x", () => stemChange((c) => { c.fin = 0; c.fout = 0; })]] }],
    ...shapeMenuItems(val, put, lk, true),
    "-",
    ["Group", "combine", null, { sub: groupItems() }],
    ["Choose", "check", null, { sub: chooseItems(n, t) }],
    ["Volume line", "pulse", null, { sub: lineItems(n, t) }],
    aselLayers().length === 1 && !aselLayers()[0].startsWith("found") ? ["Separate again", "layers", null, { off: lk, sub: ["voices", "music", "effects"].filter((k) => k !== aselLayers()[0]).map((k) =>
      ["Pull out " + Layers.TITLE[k].toLowerCase(), Layers.ICON[k], () => startPull(aselLayers()[0], k)]) }] : null,
    ["Back", "restore", null, { sub: backItems(["Loudness", "Level and fades", "Shape the sound", "Groups", "Volume lines", "Split tracks"]) }],
    "-",
    ["Split here (cuts the video section too)", "split", () => { seek(t); splitAtPlayhead(); }, { key: "S", off: locked() }],
  ].filter(Boolean), e.clientX, e.clientY);
  return true;
}
/** Loudness choices for a menu: fixed steps, and the two "same loudness" ways. */
function loudnessItems(setV, same1, same2) {
  return [["Full loudness (100%)", "restore", () => setV(1)], ["Half (50%)", "vol", () => setV(0.5)], ["Louder (150%)", "vol", () => setV(1.5)],
    ["Twice (200%)", "vol", () => setV(2)], ["Very loud (300%)", "vol", () => setV(3)], same1 ? "-" : null,
    same1 ? ["Same loudness", "sliders", same1, { tip: "Each part goes up or down so they all sound equally loud" }] : null,
    same2 ? ["Same loudness, keep balance", "sliders", same2, { tip: "They move together by the same amount" }] : null];
}
/** Tone, Cuts, Dynamics and Clean as sub-menus (the same as Shape the sound in the panel). */
function shapeMenuItems(val, put, lk, dyn) {
  const pick = (k, choices) => choices.map(([v, l]) => [l, null, () => put(k, v), { on: (val(k) || (k === "tone" ? "" : 0)) === v }]);
  return [
    ["Tone", "sparkles", null, { off: lk, sub: pick("tone", TONE_NAMES.map(([v, l]) => [v, l])) }],
    ["Cuts", "scissors", null, { off: lk, sub: [...pick("hp", [[0, "Low cut: off"], [80, "Low cut: 80 Hz"], [150, "Low cut: 150 Hz"], [300, "Low cut: 300 Hz"]]), "-",
      ...pick("lp", [[0, "High cut: off"], [12000, "High cut: 12k"], [8000, "High cut: 8k"], [4000, "High cut: 4k"]])] }],
    dyn ? ["Dynamics", "gauge", null, { off: lk, sub: pick("dyn", [[0, "Off"], [1, "Gentle"], [2, "Strong"]]) }] : null,
    ["Clean (noise)", "drop", null, { off: lk, sub: pick("nr", [[0, "Off"], [1, "Light"], [2, "Medium"], [3, "Strong"]]) }],
  ];
}
/** Group menu: make a group, add the chosen parts to a group that is there, take them out, or choose a group. */
function groupItems() {
  const list = aselList(), gs = soundGroups();
  const inG = [...new Set(list.map(({ p, n }) => p.mix && p.mix[n] && p.mix[n].group).filter(Boolean))];
  return [["Make a new group…", "plus", () => makeGroup(), { off: !list.length }],
    ...gs.map((g) => ["Add to '" + g.name + "'", "combine", () => addToGroup(g.id), { off: !list.length || g.locked, why: "The group '" + g.name + "' is locked." }]),
    inG.length ? ["Take out of the group", "x", () => takeOutOfGroup()] : null,
    gs.length ? "-" : null,
    ...gs.map((g) => ["Choose all of '" + g.name + "'", "check", () => chooseGroup(g.id)])];
}
function addToGroup(id) {
  const g = soundGroups().find((x) => x.id === id); if (!g) return;
  const list = aselList(); if (!list.length) return;
  change(() => { for (const { p, n } of list) { const m = Object.assign({}, p.mix || {}); m[n] = Object.assign({ volume: 1, mute: false }, m[n] || {}, { group: id }); p.mix = m; } }, { sound: true });
  refreshAll({ keepVideo: true });
  toast("Added " + list.length + " part" + (list.length > 1 ? "s" : "") + " to '" + g.name + "' (" + groupParts(id).length + " now). A part is in one group at a time.");
}
function takeOutOfGroup() {
  const list = aselList();
  stemChange((c) => { delete c.group; });
  refreshAll({ keepVideo: true });
  toast("Took " + list.length + " part" + (list.length > 1 ? "s" : "") + " out of the group. Their sound stays as it is.");
}
/** Loudness of each section's sound on a track, in dB, from its wave picture (fast, good enough to choose by). */
function partDb(P, offset, p, rate) {
  if (!P || !P.length) return null;
  const R = rate || 50;
  let sum = 0, k = 0;
  for (let i = Math.max(0, Math.floor((p.start - offset) * R)); i < Math.min(P.length, Math.ceil((p.end - offset) * R)); i++) { const v = P[i] / 255; sum += v * v; k++; }
  return k ? 10 * Math.log10(sum / k + 1e-12) : null;
}
/** Choose menu: the whole track, by loudness (loud / quiet / silent), the opposite, or by time. */
function chooseItems(n, t) {
  const sp = Layers.split(), P = (S.stemPeaks || {})[n], off = sp ? sp.start : 0;
  const pick = (test, what) => {
    const lv = kept().map((p) => [p, partDb(P, off, p)]).filter(([, d]) => d !== null);
    if (!lv.length) { toast("The sound of this track is still loading. Try again in a moment.", true); return; }
    const sorted = lv.map(([, d]) => d).filter((d) => d > -50).sort((a, b) => a - b), mid = sorted.length ? sorted[Math.floor(sorted.length / 2)] : -30;
    S.sel.clear(); S.asel = new Map();
    let k = 0; for (const [p, d] of lv) if (test(d, mid)) { aselSet(p, n, true); k++; }
    refreshAll({ keepVideo: true });
    toast(k ? "Chose " + k + " " + what + " part" + (k > 1 ? "s" : "") + " on " + Layers.TITLE[n] + "." : "No " + what + " parts on " + Layers.TITLE[n] + ".", !k);
  };
  return [["The whole " + Layers.TITLE[n] + " track", "list", () => { S.asel = new Map(); for (const p of kept()) aselSet(p, n, true); refreshAll({ keepVideo: true }); }],
    ["Also the other tracks here", "layers", () => { for (const { p } of aselList()) for (const k of Layers.NAMES) aselSet(p, k, true); refreshAll({ keepVideo: true }); }],
    "-",
    ["All loud parts", "vol", () => pick((d, m) => d > -50 && d >= m + 5, "loud"), { tip: "Clearly louder than most parts of this track" }],
    ["All quiet parts", "vol", () => pick((d, m) => d > -50 && d <= m - 6, "quiet"), { tip: "Clearly quieter than most parts, but not silent" }],
    ["All silent parts", "mute", () => pick((d) => d <= -50, "silent")],
    ["The opposite (invert)", "swap", () => { const was = new Set(aselList().filter((x) => x.n === n).map((x) => x.p)); S.asel = new Map(); for (const p of kept()) if (!was.has(p)) aselSet(p, n, true); refreshAll({ keepVideo: true }); }],
    ["By time…", "clock", () => chooseByTime((a, b) => { S.sel.clear(); S.asel = new Map(); for (const r of layout()) if (r.out1 > a && r.out0 < b) aselSet(r.p, n, true); refreshAll({ keepVideo: true }); })]];
}
/** Choose video sections by how loud their own sound is (from the wave picture). */
function chooseSections(test, what) {
  const lv = kept().map((p) => [p, partDb(S.peaks, 0, p, S.peakRate || 50)]).filter(([, d]) => d !== null);
  if (!lv.length) { toast("The sound is still loading. Try again in a moment.", true); return; }
  const sorted = lv.map(([, d]) => d).filter((d) => d > -50).sort((a, b) => a - b), mid = sorted.length ? sorted[Math.floor(sorted.length / 2)] : -30;
  S.asel = new Map(); S.sel = new Set(lv.filter(([, d]) => test(d, mid)).map(([p]) => p));
  refreshAll({ keepVideo: true });
  toast(S.sel.size ? "Chose " + S.sel.size + " " + what + " section" + (S.sel.size > 1 ? "s" : "") + "." : "No " + what + " sections.", !S.sel.size);
}
/** Remove silence: finds the pauses (in the voices when the sound is split, else in the sound) and takes them out of
 *  the video sections, keeping a little around the words so nothing is cut off. */
async function removeSilenceDialog() {
  if (locked()) { lockedNote(); return; }
  let noise = -40, min = 1, keep = 0.25;
  const body = [
    el("p", { class: "msg", text: "Takes the pauses out of the video. Ctrl + Z brings them back." }),
    el("div", { class: "field" }, el("span", { text: "What counts as silent" }), segmented([[-50, "Very quiet"], [-40, "Quiet"], [-30, "Soft talking too"]], noise, (v) => { noise = +v; })),
    el("div", { class: "field" }, el("span", { text: "Shortest pause to take out" }), segmented([[0.5, "0.5 s"], [1, "1 s"], [2, "2 s"], [4, "4 s"]], min, (v) => { min = +v; })),
    el("div", { class: "field" }, el("span", { text: "Keep around the words" }), segmented([[0.1, "0.1 s"], [0.25, "0.25 s"], [0.5, "0.5 s"]], keep, (v) => { keep = +v; })),
  ];
  if (!(await dialogBox("Remove silence", body, [["Cancel", null, "ghost"], ["Remove the pauses", true, "primary"]]))) return;
  toast("Listening for pauses…");
  let r;
  try { await saveNow(); r = await api("/api/projects/" + S.id + "/silences", { method: "POST", json: { noise, min } }); } catch (e) { toast(errText(e), true); return; }
  const cuts = r.ranges.map(([a, b]) => [a + keep, b - keep]).filter(([a, b]) => b - a >= 0.2);
  let removed = 0, n = 0;
  const out = [];
  for (const p of S.proj.pieces) {
    if (p.off) { out.push(p); continue; }
    let parts = [[p.start, p.end]];
    for (const [a, b] of cuts) {
      const next = [];
      for (const [x, y] of parts) {
        if (b <= x || a >= y) { next.push([x, y]); continue; }
        if (a > x) next.push([x, a]); if (b < y) next.push([b, y]);
        removed += Math.min(y, b) - Math.max(x, a); n++;
      }
      parts = next;
    }
    parts = parts.filter(([x, y]) => y - x >= 0.15);
    for (const [x, y] of parts) out.push(Object.assign(clone(p), { start: +x.toFixed(4), end: +y.toFixed(4) }));
  }
  if (!n) { toast("No pauses that long were found (from the " + r.from + ").", true); return; }
  if (!change(() => { S.proj.pieces = out.map(fixPiece); S.sel.clear(); markHand(); })) return;
  refreshAll();
  toast("Took out " + n + " pause" + (n > 1 ? "s" : "") + " (" + removed.toFixed(1) + " s, found in the " + r.from + "). Ctrl + Z brings them back.");
}
/** One tap: a clear voice (low cut, Clear voice tone, a little cleaning and Dynamics, Level light). */
function makeVoiceClear() {
  const preset = { tone: "voice", hp: 80, nr: 1, dyn: 1, even: 1 };
  if (stemsOn()) {
    if (trackLocked("voices") || trackLocked("sound")) { lockedNote("sound"); return; }
    S.sel.clear(); S.asel = new Map(); for (const p of kept()) aselSet(p, "voices", true);
    stemChange((c) => Object.assign(c, preset));
    refreshAll({ keepVideo: true });
    toast("Voices made clear: low cut, Clear voice, light cleaning, gentle Dynamics and Level. Each can be changed under Shape the sound.");
  } else {
    if (trackLocked("sound")) { lockedNote("sound"); return; }
    if (!change(() => { for (const p of kept()) Object.assign(p, preset); }, { sound: true })) return;
    refreshAll({ keepVideo: true });
    toast("The sound is made clearer for talking. Split the sound first for the best result: then only the voices change.");
  }
}
/** The song's own ending lands at the end of the video (it starts that far into the song), with a gentle fade. */
async function songEndsWithVideo(i) {
  const x = layers()[i]; if (!x) return;
  if (musicLocked(i)) { toast(musicLocked(i), true); return; }
  const m = musicPlayer(x.file);
  if (!m.duration) await new Promise((ok) => { m.addEventListener("loadedmetadata", ok, { once: true }); setTimeout(ok, 3000); });
  const D = m.duration, T = rawTotal();
  if (!D) { toast("The song is still loading. Try again in a moment.", true); return; }
  const start = Math.max(0, D - T);
  change(() => setLayer(i, { start: +start.toFixed(2), fade_out: Math.min(3, x.fade_out === undefined ? 1.5 : x.fade_out) }), { keepVideo: true });
  refreshAll({ keepVideo: true }); if (S.playing) musicPlay();
  toast(D >= T ? "The song now starts at " + fmtTime(start, 1) + ", so it ends with the video." : "The song is shorter than the video, so it starts from its beginning and plays again; its fade ends with the video.");
}
/** Cuts on the beat: each cut between sections moves (a little, never more than a quarter second, earlier or later) onto
 *  a beat of the song. */
async function cutsOnBeat(i) {
  const x = layers()[i]; if (!x) return;
  if (locked()) { lockedNote(); return; }
  let r; try { r = await api("/api/beats", { method: "POST", json: { input: x.file } }); } catch (e) { toast(errText(e), true); return; }
  if (!r.beats || !r.beats.length) { toast("No beat was found in this song.", true); return; }
  const off = +x.start || 0, D = r.duration || 1e9, beats = [];
  for (let k = 0; ; k++) { let any = false; for (const b of r.beats) { const t = b - off + k * D; if (t > rawTotal() + 1) break; if (t >= 0) beats.push(t); any = true; } if (!any || k > 50 || r.beats[0] - off + (k + 1) * D > rawTotal()) break; }
  let n = 0;
  if (!change(() => {
    for (let j = 0; j < kept().length - 1; j++) {
      const r1 = layout()[j], p = r1.p, cut = r1.out1;               // positions move as earlier cuts move
      const b = beats.reduce((best, t) => (Math.abs(t - cut) <= 0.26 && (best === null || Math.abs(t - cut) < Math.abs(best - cut)) ? t : best), null);
      if (b === null || Math.abs(cut - b) < 0.01) continue;
      const len = (b - r1.out0) * p.speed; if (len < 0.3) continue;
      if (p.reverse) { const st = p.end - len; if (st < 0) continue; p.start = +st.toFixed(4); }          // earlier: shorter; later: a little longer
      else { const en = p.start + len; if (en > S.info.duration) continue; p.end = +en.toFixed(4); }
      n++;
    }
    markHand();
  })) return;
  refreshAll();
  toast(n ? n + " cut" + (n > 1 ? "s" : "") + " moved onto the beat (" + Math.round(r.tempo || 0) + " BPM). Ctrl + Z undoes it." : "The cuts are already on the beat.");
}
/** Ask for a stretch of time ("0:10 - 0:25") and hand it on. */
async function chooseByTime(fn) {
  const v = await askText("Choose by time", fmtTime(S.t, 1) + " - " + fmtTime(Math.min(rawTotal(), S.t + 10), 1), "From – to, for example 0:10 - 0:25");
  if (v === null) return;
  const m = String(v).split(/\s*[-–to]+\s*/).filter(Boolean).map(parseTime);
  if (m.length !== 2 || m.some((x) => x === null || !isFinite(x)) || m[1] <= m[0]) { toast("Type two times, for example 0:10 - 0:25.", true); return; }
  fn(m[0], m[1]);
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
    toast(r.pull ? "Done: " + Layers.TITLE[r.pull] + " pulled out of " + Layers.TITLE[r.layer] + " and put on the " + Layers.TITLE[r.pull] + " track. Listen to what was taken out, or go back, under Separate again."
      : "Done. What was taken out is sorted onto the 'found again' tracks under Effects (voices, music, effects). Ctrl + Z goes back to the sound before.");
    renderInspector();
  } else if (r.state === "failed") toast(r.error || "Separating again failed.", true);
  if (n) n.textContent = r.state === "running" ? n.textContent : "";
}
// ---- Separate again, choosing what to pull out: it joins its own track, the chosen track keeps the rest
S.sepOpts = { quality: "balanced", strength: "gentle" };
async function startPull(n, pull, ranges, opts) {
  const o = Object.assign({}, S.sepOpts, opts || {});
  if (!ranges) {
    const list = aselList().filter((x) => x.n === n);
    const lockedOne = list.find(({ p, n: k }) => partLocked(p, k));
    if (lockedOne) { toast(partLocked(lockedOne.p, lockedOne.n), true); return; }
    ranges = list.map(({ p }) => [p.start, p.end]);
  }
  if (!ranges.length) { toast("Choose parts on the " + Layers.TITLE[n] + " track first.", true); return; }
  if (trackLocked(n) || trackLocked(pull) || trackLocked("sound")) { lockedNote("sound"); return; }
  try {
    await saved();
    S.resplitUndo = snapshot();
    const r = await api("/api/projects/" + S.id + "/resplit", { method: "POST", json: { layer: n, pull, ranges, quality: o.quality, strength: o.strength } });
    const note = $("resplitNote"); if (note) note.textContent = "Starting…";
    followResplit(r);
    toast("Pulling " + Layers.TITLE[pull].toLowerCase() + " out of the chosen " + Layers.TITLE[n] + " parts. It runs in the background (see Activity).");
    if (typeof Activity !== "undefined") Activity.refresh();
  } catch (e) { toast(errText(e), true); }
}
let REMOVED = null;
function listenRemoved(btnEl) {
  const sp = Layers.split(); if (!sp || !sp.removed) return;
  if (REMOVED && !REMOVED.paused) { REMOVED.pause(); btnEl.replaceChildren(icon("play", "s"), el("span", { text: "Listen to what was taken out" })); return; }
  if (S.playing) pause();
  REMOVED = REMOVED || new Audio();
  const src = "/media?split=" + encodeURIComponent(sp.id) + "&layer=removed&t=" + encodeURIComponent(TOKEN);
  if (REMOVED.dataset.src !== src) { REMOVED.src = src; REMOVED.dataset.src = src; }
  const rs = (sp.last && sp.last.ranges) || [[sp.start, sp.end]];
  const at = segAt(S.t), now = at ? at.s.p.start + (S.t - at.s.out0) * at.s.p.speed : rs[0][0];
  const from = rs.some(([a, b]) => now >= a && now < b) ? now : rs[0][0];
  const go = () => { REMOVED.currentTime = Math.max(0, from - sp.start); REMOVED.play().catch(() => {}); };
  if (REMOVED.readyState >= 1) go(); else REMOVED.addEventListener("loadedmetadata", go, { once: true });
  btnEl.replaceChildren(icon("pause", "s"), el("span", { text: "Stop" }));
  REMOVED.onended = () => btnEl.replaceChildren(icon("play", "s"), el("span", { text: "Listen to what was taken out" }));
}
function separateBox(n, lk) {
  const sp = Layers.split(), last = sp && sp.last, others = ["voices", "music", "effects"].filter((k) => k !== n);
  const qSeg = segmented([["fast", "Fast"], ["balanced", "Balanced"], ["thorough", "Thorough"]], S.sepOpts.quality, (v) => { S.sepOpts.quality = v; });
  const sSeg = segmented([["gentle", "Gentle"], ["aggressive", "Aggressive"]], S.sepOpts.strength, (v) => { S.sepOpts.strength = v; });
  const pulls = el("div", { class: "btns sep-pulls" }, ...others.map((k) => btn("Pull out " + Layers.TITLE[k].toLowerCase(), { icon: Layers.ICON[k], cls: k === "voices" ? "primary" : "",
    title: "Take the " + Layers.TITLE[k].toLowerCase() + " out of the chosen " + Layers.TITLE[n] + " parts and put it on the " + Layers.TITLE[k] + " track", onclick: () => startPull(n, k) })));
  if (lk) for (const b of pulls.children) b.disabled = true;
  const box = el("div", { class: "pad sep-box" },
    el("div", { class: "field" }, el("span", {}, el("b", { text: "Separate again" }), el("small", { class: "note", text: " what does not belong here goes to its own track" }))),
    pulls,
    el("div", { class: "field" }, el("span", { text: "Quality" }), qSeg),
    el("div", { class: "field" }, el("span", { text: "Strength" }), sSeg),
    el("p", { class: "note", text: "Voices use a model made only for voices. Aggressive goes over what is left once more; Thorough is slower but cleaner." }),
    el("span", { class: "note", id: "resplitNote" }));
  if (last && last.pull) {
    const lb = btn("Listen to what was taken out", { icon: "play", cls: "sm ghost", onclick: (e) => listenRemoved(e.currentTarget) });
    box.append(el("div", { class: "sep-last" },
      el("small", { class: "note", text: "Last: " + Layers.TITLE[last.pull] + " pulled out of " + Layers.TITLE[last.layer] + " (" + last.quality + ", " + last.strength + ")" }),
      el("div", { class: "btns" }, sp.removed ? lb : null,
        btn("Back to the version before", { icon: "undo", cls: "sm ghost", title: "Use the sound as it was before this Separate again (it was kept)", onclick: () => {
          change(() => { S.proj.settings.mix_split = last.from; }, { keepVideo: true }); S.stemFor = null; Layers.refresh(); toast("Back to the sound before. The newer one is kept too: Ctrl + Z goes to it again."); } }),
        btn("Again, stronger", { icon: "layers", cls: "sm ghost", title: "Go over the same parts once more (Thorough, Aggressive)", onclick: () => startPull(last.layer, last.pull, last.ranges, { quality: "thorough", strength: "aggressive" }) }))));
  }
  return box;
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
  const vol = el("input", { type: "range", class: "rng", min: "0", max: "500", step: "1", value: String(Math.round((vols.length === 1 ? vols[0] : 1) * 100)), "aria-label": "Loudness of the chosen parts" });
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
    el("div", { class: "field" }, el("span", {}, "Loudness ", val, el("small", { class: "note", text: " (up to 500%)" })), vol),
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
    shapeBox((k) => same(list.map(({ p, n }) => (p.mix && p.mix[n] && p.mix[n][k]) || (k === "tone" ? "" : 0))),
      (k, v) => stemChange((c) => { if (k === "__all") for (const x of TONE_KEYS) delete c[x]; else c[k] = v; }), lk, { nudge: true }),
    layersIn.length === 1 && !layersIn[0].startsWith("found") ? separateBox(layersIn[0], lk) : null,
    oneGroup ? el("div", { class: "grp-now" }, dotFor(oneGroup.id), el("span", { text: "Group: " + oneGroup.name }),
      btn(oneGroup.locked ? "Unlock" : "Lock", { icon: oneGroup.locked ? "unlock" : "lock", cls: "sm ghost", onclick: () => groupEdit(oneGroup.id, "lock") }))
      : btn("Group these parts", { icon: "combine", cls: "ghost wide", title: "Give the chosen parts a name, to choose, lock and change them together later", onclick: () => makeGroup() }),
    lockedN ? el("p", { class: "hint warn", text: lockedN + " of these parts " + (lockedN === 1 ? "is" : "are") + " locked (track or group): they stay as they are." }) : null,
    el("p", { class: "hint", text: "Click parts on the sound tracks (Ctrl + click for more, Shift + click for all in between), or a track's name for the whole track. Ctrl + click a second track's name to choose two tracks together. Cuts are shared with the video sections." }));
  R.append(pad);
  if (layersIn.length === 1 && !layersIn[0].startsWith("found")) R.append(stemDuckBox(layersIn[0], trackLocked(layersIn[0])));
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
  } else if (e.target.closest("#laneA") && S.mode === "final") {
    const at = segAt(t), sp = at && at.s.p;
    if (sp && !S.sel.has(sp)) { S.sel = new Set([sp]); S.anchor = sp; refreshAll({ keepVideo: true }); }
    const sel = selList(), slk = trackLocked("sound"), m = keyMuted("original"), so = keySolo("original");
    const onS = (fn) => { if (!change(() => { selList().forEach(fn); markHand(); }, { sound: true })) renderInspector(); };
    items = [[m ? "Turn the sound on" : "Mute the sound track", m ? "vol" : "mute", () => flipKey("mute", "original"), { off: slk }],
      [so ? "Stop solo" : "Solo the sound track", "target", () => flipKey("solo", "original")],
      "-",
      sel.length ? ["Loudness of " + (sel.length > 1 ? sel.length + " sections" : "this section"), "sliders", null, { off: slk, sub: loudnessItems((v) => onS((p) => { p.volume = v; p.mute = false; })) }] : null,
      ...(sel.length ? shapeMenuItems((k) => same(sel.map((p) => p[k] || 0)), (k, v) => onS((p) => { if (v) p[k] = v; else delete p[k]; }), slk, true) : []),
      ["Choose", "check", null, { sub: [
        ["All loud sections", "vol", () => chooseSections((d, mm) => d > -50 && d >= mm + 5, "loud")],
        ["All quiet sections", "vol", () => chooseSections((d, mm) => d > -50 && d <= mm - 6, "quiet")],
        ["All silent sections", "mute", () => chooseSections((d) => d <= -50, "silent")],
        ["The opposite (invert)", "swap", () => { S.sel = new Set(kept().filter((p) => !S.sel.has(p))); refreshAll({ keepVideo: true }); }],
        ["By time…", "clock", () => chooseByTime((a, b) => { S.sel = new Set(layout().filter((r) => r.out1 > a && r.out0 < b).map((r) => r.p)); refreshAll({ keepVideo: true }); })]] }],
      ["Volume line", "pulse", null, { sub: lineItems("original", t) }],
      ["Back", "restore", null, { sub: backItems(["Loudness", "Level and fades", "Shape the sound", "Volume lines", "Mute, solo and locks", "Cuts"]) }],
      "-", ["Split here", "split", () => { seek(t); splitAtPlayhead(); }, { key: "S", off: lk, why }]];
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
      ["Cut on the exact picture change near here", "scissors", () => cutExact(t), { off: lk, why }],
      ["Find more scene changes in this scene", "search", () => findCutsIn(p), { off: lk, why }],
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
      ["Cut on the exact picture change near here", "scissors", () => cutExact(t), { off: lk, why }],
      ["Find scene changes in this section", "search", () => findCutsIn(p), { off: lk, why }],
      S.mode === "final" && S.info.has_video ? ["Track something here…", "target", () => startTrack(p), { off: trackLocked("video") }] : null,
      S.mode === "final" && p.place && p.place.track ? ["Stop tracking", "x", () => stopTrack([p])] : null,
      "-",
      [n > 1 ? "Duplicate " + n + " sections" : "Duplicate", "copy", duplicateSelected, { key: "Ctrl+D", off: lk, why }],
      ["Select all", "grid", () => { S.sel = new Set(kept()); refreshAll({ keepVideo: true }); }, { key: "Ctrl+A" }],
      ["Back", "restore", null, { sub: backItems(["Cuts", "Picture", "Loudness", "Level and fades", "Shape the sound", "Words"]) }],
      "-",
      [n > 1 ? "Remove " + n + " sections" : "Remove this section", "trash", removeSelected, { danger: true, key: "Del", off: lk, why }]];
  } else {
    items = [["Move the playhead here", "target", () => seek(t)], ["Play from here", "play", () => { seek(t); play(); }],
      "-", ["Select all", "grid", () => { S.sel = new Set(kept()); refreshAll({ keepVideo: true }); }, { key: "Ctrl+A" }],
      ["Undo", "undo", undo, { key: "Ctrl+Z", off: !S.undo.length }], ["Redo", "redo", redo, { key: "Ctrl+Y", off: !S.redo.length }],
      ["Back", "restore", null, { sub: backItems() }],
      "-", ["Zoom in here", "zin", () => zoomTo(S.pps * 2, t)], ["Show the whole video", "widen", fitZoom]];
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
    const slider = el("input", { type: "range", class: "rng", min: "0", max: "500", step: "1", value: String(Math.round(x.volume * 100)), "aria-label": "Loudness of " + name });
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
  if (note) note.textContent = soloOn() ? "Solo is on: here you only hear the soloed music. It is only for listening: the export always has every track that is not muted." : "";
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
const SHAPE_CARDS = [["original", "Original", null], ["vertical", "Tall 9:16", 9 / 16], ["portrait", "Portrait 4:5", 4 / 5], ["square", "Square", 1]];
// ---- tracking: a tall, portrait or square shape that follows the most visible person or thing of each shot
S.subj = null;
function following() { const sh = S.proj.settings.shape || ""; return sh.endsWith("_follow") && !Frame.active(S.proj.settings.frame); }
/** Where the view is at a moment of a section: the crop slides along the section's path (0 = left edge, 1 = right edge). */
function followView(v, p) {
  if (!v || !p) return;
  if (!following() || !S.subj || !S.subj.paths) { if (v.style.objectPosition) v.style.objectPosition = ""; return; }
  const path = S.subj.paths[S.proj.pieces.indexOf(p)];
  if (!path || !path.length) { v.style.objectPosition = ""; return; }
  const va = S.info.width / S.info.height, cw = frameAspect() / va;
  if (cw >= 1) { v.style.objectPosition = ""; return; }
  const cx = lineAt(path, v.currentTime), off = clamp((cx - cw / 2) / (1 - cw), 0, 1);
  v.style.objectPosition = (off * 100).toFixed(2) + "% 50%";
}
async function startFollow(force) {
  if (!following()) return;
  try {
    await saved();
    const r = await api("/api/projects/" + S.id + "/subjects", { method: "POST", json: {} });
    S.subj = Object.assign(S.subj || {}, r); renderShape(); pollFollow();
  } catch (e) { toast(errText(e), true); }
}
function pollFollow() {
  clearTimeout(S.subjTimer);
  S.subjTimer = setTimeout(async () => {
    try {
      const r = await api("/api/projects/" + S.id + "/subjects");
      S.subj = r;
      if (r.state === "running") pollFollow();
      if (r.state === "done" || r.state === "failed") { renderShape(); if (!S.playing) { const v = active(); if (V.seg) followView(v, V.seg.p); } }
      else updateFollowNote();
    } catch (e) { pollFollow(); }
  }, 800);
}
function updateFollowNote() { const n = $("followNote"); if (n && S.subj && S.subj.state === "running") n.textContent = (S.subj.message || "Finding who to follow") + "… " + Math.round((S.subj.progress || 0) * 100) + "%"; }
/** Tracking with a frame (Picture panel, e.g. 9:16): every section follows the most visible person or thing of its shots,
 *  done for you (the same finder as the Tracking shapes); a section can still be tracked by hand with a box. */
function frameTrackBox() {
  const st = S.proj.settings, sj = S.subj || {};
  const f = Frame.full(st.frame), sh0 = pictureShare(f);
  const n = kept().filter((p) => p.place && p.place.track && p.place.track.auto).length;
  const set = (k, v) => { change(() => { st[k] = v; }, { keepVideo: true }); renderShape(); };
  return el("div", { class: "follow-box" },
    el("div", { class: "row between" }, el("b", { text: "Tracking" }), el("span", { class: "note num", text: n ? n + " of " + kept().length + " sections" : "off" })),
    el("p", { class: "note", text: "Each section follows whoever (or whatever) stands out most in its shots; when they leave, the next one." + (sh0.w <= 1.001 ? " The picture is zoomed to fill the frame first." : "") }),
    el("div", { class: "field" }, el("span", { text: "Follow" }), segmented([["auto", "Auto"], ["people", "People"], ["faces", "Faces"], ["biggest", "Biggest thing"]], st.follow_who || "auto", (v) => set("follow_who", v))),
    el("div", { class: "field" }, el("span", { text: "Feel" }), segmented([["steady", "Steady"], ["lively", "Lively"]], st.follow_feel || "steady", (v) => set("follow_feel", v))),
    el("div", { class: "field" }, el("span", { text: "Space in front" }), segmented([["0", "Off"], ["1", "On"]], st.follow_room ? "1" : "0", (v) => set("follow_room", v === "1"))),
    el("span", { class: "note", id: "followNote", text: sj.state === "running" ? (sj.message || "Finding who to follow") + "… " + Math.round((sj.progress || 0) * 100) + "%" : "" }),
    el("div", { class: "btns" },
      btn(n ? "Track again" : "Track every section", { icon: "target", cls: "sm primary", onclick: () => autoTrackFrame() }),
      n ? btn("Stop tracking", { icon: "x", cls: "sm ghost", onclick: () => stopTrack(kept().filter((p) => p.place && p.place.track)) }) : null));
}
/** The Tracking card of the Picture panel: with a tall (or narrower) frame, Track every section; else how to start. */
function renderTrackPanel() {
  const box = $("trackPanel"); if (!box || !S.proj || !S.info || !S.info.has_video) return;
  box.replaceChildren();
  const fr = Frame.full(S.proj.settings.frame);
  const RAT = { "9:16": 9 / 16, "16:9": 16 / 9, "4:3": 4 / 3, "3:4": 3 / 4, "1:1": 1, "4:5": 4 / 5, "2.35:1": 2.35, "2:1": 2, "1.85:1": 1.85, "5.8in": 9 / 19.5 };
  const va = S.info.width / S.info.height, ca = RAT[fr.ratio] || va;
  if (Frame.active(S.proj.settings.frame) && ca < va - 0.01) { box.append(frameTrackBox()); return; }
  if (following()) { box.append(el("p", { class: "hint", text: "Tracking is on in the shape below (" + (S.proj.settings.shape || "").split("_")[0] + ")." })); return; }
  box.append(el("p", { class: "hint", text: "Choose a tall shape above (for example 9:16). Then the picture can follow people and things here, by itself." }),
    btn("Make it 9:16 and track", { icon: "target", cls: "sm", onclick: async () => {
      if (typeof Frame.setRatio === "function") Frame.setRatio("9:16");
      else { change(() => { S.proj.settings.frame = Object.assign({}, S.proj.settings.frame || {}, { ratio: "9:16" }); }, { keepVideo: true }); Frame.refresh && Frame.refresh(); }
      sizeFrame(); renderTrackPanel(); autoTrackFrame();
    } }));
}
async function autoTrackFrame() {
  if (trackLocked("video")) { lockedNote("video"); return; }
  const f0 = Frame.full(S.proj.settings.frame);
  if (Math.abs(f0.rotate) > 0.5) { toast("Turn the picture back to straight (Rotate 0) first, then track.", true); return; }
  try {
    await saved();
    let r = await api("/api/projects/" + S.id + "/subjects", { method: "POST", json: {} });
    S.subj = r; renderShape();
    while (r.state === "running") { await new Promise((ok) => setTimeout(ok, 800)); r = await api("/api/projects/" + S.id + "/subjects"); S.subj = r; updateFollowNote(); }
    if (r.state !== "done") { toast(r.error || "Tracking could not look at the video.", true); renderShape(); return; }
    const RAT = { "9:16": 9 / 16, "16:9": 16 / 9, "4:3": 4 / 3, "3:4": 3 / 4, "1:1": 1, "4:5": 4 / 5, "2.35:1": 2.35, "2:1": 2, "1.85:1": 1.85, "5.8in": 9 / 19.5 };
    const va = S.info.width / S.info.height, ca = RAT[f0.ratio] || va;
    let zoomed = false, n = 0;
    change(() => {
      const base = Frame.full(S.proj.settings.frame);
      if (va > ca && base.scale < va / ca - 1e-3) { S.proj.settings.frame = Object.assign({}, S.proj.settings.frame, { scale: +(va / ca).toFixed(4) }); zoomed = true; }
      const fr = Frame.full(S.proj.settings.frame), sh = pictureShare(fr), lim = Math.max(0, sh.w - 1);
      S.proj.pieces.forEach((p, i) => {
        const path = r.paths[i];
        if (p.off || !path || !path.length) return;
        if (p.place && p.place.track && !p.place.track.auto) return;           // tracked by hand: kept
        const own = Object.assign({ x: fr.x, y: fr.y, scale: fr.scale, rotate: fr.rotate }, p.place || {});
        own.scale = fr.scale;
        const pts = path.map(([t, cx]) => [t, +clamp(-(cx - 0.5) * sh.w * 2 - own.x, -lim - own.x, lim - own.x).toFixed(5), 0]);
        own.track = { path: pts.length > 1 ? pts : pts.concat([[p.end, pts[0][1], 0]]), found: 1, axes: "x", auto: true };
        p.place = own; n++;
      });
    }, { keepVideo: true });
    Frame.refresh && Frame.refresh();
    renderShape(); if (typeof Frame.renderPanel === "function") Frame.renderPanel();
    toast(n ? "Tracking on in " + n + " section" + (n > 1 ? "s" : "") + (zoomed ? " (the picture was zoomed to fill the frame)" : "") + ". Play it to see. Sections tracked by hand were kept." : "Nothing to follow was found in these sections.", !n);
  } catch (e) { toast(errText(e), true); }
}
/** After an edit in a tracking shape: find what is missing (only new parts are looked at) and refresh the paths. */
function followChanged() { if (!following()) return; clearTimeout(S.subjAgain); S.subjAgain = setTimeout(() => startFollow(), 1200); }
function renderShape() {
  const sh = S.proj.settings.shape || "original", base = sh.split("_")[0], fill = sh.includes("_") ? sh.split("_")[1] : "middle";
  const box = $("shapeCards"); box.replaceChildren();
  for (const [k, name, a] of SHAPE_CARDS) {
    const ar = a || (S.info.width / S.info.height) || 16 / 9;
    const pic = el("i", { class: "shape-pic" }); pic.style.aspectRatio = String(ar);
    box.append(el("button", { type: "button", class: "mode" + (base === k ? " on" : ""), onclick: () => setShape(k, fill) }, el("span", { class: "pic-box" }, pic), el("b", { text: name })));
  }
  const fb = $("shapeFill"); fb.replaceChildren();
  renderTrackPanel();
  if (Frame.active(S.proj.settings.frame)) {
    fb.append(el("p", { class: "hint", text: "The Frame panel sets the shape now (" + Frame.full(S.proj.settings.frame).ratio + "). Reset the frame there to use these." }));
    return;
  }
  if (base !== "original") fb.append(segmented([["middle", "Crop"], ["blur", "Whole + blur"], ["follow", "Tracking"]], fill, (v) => setShape(base, v)));
  else fb.append(el("p", { class: "hint", text: "The original keeps the whole picture." }));
  if (base !== "original" && fill === "follow") {
    const st = S.proj.settings, set = (k, v) => { change(() => { st[k] = v; }, { keepVideo: true }); renderShape(); startFollow(); };
    const sj = S.subj || {};
    fb.append(el("div", { class: "follow-box" },
      el("p", { class: "note", text: "In every shot the frame follows whoever (or whatever) stands out most. When they leave, it moves on to the next one." }),
      el("div", { class: "field" }, el("span", { text: "Follow" }), segmented([["auto", "Auto"], ["people", "People"], ["faces", "Faces"], ["biggest", "Biggest thing"]], st.follow_who || "auto", (v) => set("follow_who", v))),
      el("div", { class: "field" }, el("span", { text: "Feel" }), segmented([["steady", "Steady"], ["lively", "Lively"]], st.follow_feel || "steady", (v) => set("follow_feel", v))),
      el("div", { class: "field" }, el("span", { text: "Space in front" }), segmented([["0", "Off"], ["1", "On"]], st.follow_room ? "1" : "0", (v) => set("follow_room", v === "1"))),
      el("p", { class: "note", id: "followNote", text: sj.state === "running" ? (sj.message || "Finding who to follow") + "… " + Math.round((sj.progress || 0) * 100) + "%"
        : sj.state === "done" ? "Ready: play to see the frame follow. Right-click a section → Track something here… to choose who to follow in it."
        : sj.state === "failed" ? "Could not look: " + (sj.error || "") : "" }),
      sj.state === "failed" ? btn("Try again", { icon: "restore", cls: "sm ghost", onclick: () => startFollow(true) }) : null));
    if (!sj.state || sj.state === "none") startFollow();
  }
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
  const vol = el("input", { type: "range", class: "rng", min: "0", max: "5", step: "0.01", value: String(sel[0].volume), "aria-label": "Loudness" });
  const onSound = (fn) => { if (!change(() => { selList().forEach(fn); markHand(); }, { sound: true })) renderInspector(); };
  vol.addEventListener("change", () => onSound((p) => { p.volume = parseFloat(vol.value); p.mute = false; }));
  const muteSw = el("input", { type: "checkbox", class: "sw" }); muteSw.checked = all((p) => p.mute);
  muteSw.addEventListener("change", () => onSound((p) => { p.mute = muteSw.checked; }));
  vol.disabled = muteSw.disabled = trackLocked("sound");
  const basics = el("div", { class: "pad" }, el("div", { class: "field" }, el("span", { text: "Speed" }), chipsBox));
  const volTxt = el("b", { class: "num", text: Math.round(sel[0].volume * 100) + "%" });
  vol.addEventListener("input", () => { volTxt.textContent = Math.round(vol.value * 100) + "%"; });
  if (S.mode === "final") basics.append(el("div", { class: "field" }, el("span", {}, "Loudness ", volTxt, el("small", { class: "note", text: " (up to 500%)" })), vol), el("label", { class: "swl" }, el("span", { text: "Mute" }), muteSw));
  if (S.mode === "final" && S.info.has_audio && !stemsOn()) basics.append(
    shapeBox((k) => same(sel.map((p) => p[k] || (k === "tone" ? "" : 0))),
      (k, v) => onSound((p) => { if (k === "__all") for (const x of TONE_KEYS) delete p[x]; else if (v) p[k] = v; else delete p[k]; }), trackLocked("sound"), { nudge: true }),
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
  const tb = trackBox(sel);
  if (tb) R.append(tb);
  else if (sel.length === 1 && S.info.has_video && Frame.active(S.proj.settings.frame)) R.append(el("div", { class: "pad track-box" },
    btn("Track something in this section", { icon: "target", cls: "wide ghost", title: "Draw a box around a face, a person or a car: the picture moves with it", onclick: () => startTrack(sel[0]) })));
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
    const r = el("input", { type: "range", class: "rng", min: String(min), max: String(max), step: String(step), value: String(c0[key] || 0), "aria-label": label });
    r.addEventListener("change", () => onSel((p) => { p.color = Object.assign({}, p.color, { [key]: parseFloat(r.value) }); }));
    return el("div", { class: "field" }, el("span", { text: label }), r);
  };
  const presets = el("div", { class: "looks color-presets" });
  for (const [name, c] of COLOR_PRESETS) {
    const on = all((p) => COLOR_KEYS.every((k) => Math.abs((p.color[k] || 0) - (c[k] === undefined ? COLOR_ZERO[k] : c[k])) < 1e-3));
    const sw = el("i", { class: "cp-sw" }); sw.style.filter = colorCss(Object.assign({}, COLOR_ZERO, c));
    presets.append(el("button", { type: "button", class: "btn" + (on ? " on" : ""), title: "Colour look: " + name, onclick: () => onSel((p) => { p.color = Object.assign({}, COLOR_ZERO, c); }) }, sw, el("span", { text: name })));
  }
  R.append(sec("Colour", "palette", open.has("Colour"), presets, slider("Brightness", "brightness", -0.5, 0.5, 0.05), slider("Contrast", "contrast", 0.5, 2, 0.05), slider("Colour strength", "saturation", 0, 2, 0.05),
    slider("Warm or cool", "warmth", -1, 1, 0.05),
    btn("Reset colour", { cls: "ghost", onclick: () => onSel((p) => { p.color = Object.assign({}, COLOR_ZERO); }) })));
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
    ...[["Space", "Play / pause"], ["S", "Split at the playhead"], ["Delete", "Remove selected"], ["Ctrl+Z / Ctrl+Y", "Undo / redo"], ["Ctrl+D", "Duplicate"], ["Ctrl+A", "Select all"], ["← →", "One frame (Shift: one second)"], ["+ / −", "Zoom the timeline (all the way in: every frame)"], ["[ / ]", "Previous / next scene change"]].concat(S.studio ? [[", / .", "One frame back / forward"], ["T", "Type a time to go to"],
      ["I / O", "In / Out point (then Remove closes the gap)"], ["M / Shift+M", "Add a marker / next marker"], ["J / K / L", "Back 1 s / pause / play"]] : [])
      .map(([k, v]) => el("div", { class: "row between" }, el("span", { class: "kbd", text: k }), el("span", { class: "note", text: v })))));
}

// ---- Scene changes: marks on the ruler, jump between them, find more inside a section, cut on the exact frame
S.cuts = null;                                     // scene changes of the video (source seconds), when found
async function loadCuts() {
  if (!S.info.has_video || S.cutsBusy) return;
  S.cutsBusy = true;
  try {
    const st = await api("/api/scenes?id=" + encodeURIComponent(S.proj.source));
    if (st.state === "ready") { S.cuts = st.scenes || []; renderTimeline(); }
  } catch (e) { /* no marks */ } finally { S.cutsBusy = false; }
}
/** Scene changes on the finished timeline (a change shows where its section plays it). */
function cutMarks() {
  if (!S.cuts || !S.cuts.length) return [];
  const out = [];
  for (const r of layout()) {
    const p = r.p;
    for (const c of S.cuts) {
      if (c <= p.start + 0.02 || c >= p.end - 0.02) continue;
      out.push(p.reverse ? r.out0 + (p.end - c) / p.speed : r.out0 + (c - p.start) / p.speed);
    }
  }
  for (const r of layout().slice(1)) out.push(r.out0);                 // every join is a possible change too
  return [...new Set(out.map((x) => +x.toFixed(4)))].sort((a, b) => a - b);
}
function jumpCut(dir) {
  const marks = cutMarks(), eps = 1e-3;
  const t = dir > 0 ? marks.find((x) => x > S.t + eps) : [...marks].reverse().find((x) => x < S.t - eps);
  if (t === undefined) { toast(dir > 0 ? "No scene change after this." : "No scene change before this."); return; }
  seek(t);
  const sc = $("tlScroll"), x = px(t);
  if (x < sc.scrollLeft + 40 || x > sc.scrollLeft + sc.clientWidth - 40) sc.scrollLeft = x - sc.clientWidth * 0.4;
}
/** Split one section at source times (in Scenes, each new part is its own scene). */
function splitAtSource(p, times) {
  const ts = times.filter((c) => c - p.start >= MIN_PIECE && p.end - c >= MIN_PIECE).sort((a, b) => a - b);
  if (!ts.length) return 0;
  change(() => {
    const parts = [], edges = [p.start, ...ts, p.end];
    for (let k = 0; k < edges.length - 1; k++) { const q = clone(p); q.start = +edges[k].toFixed(4); q.end = +edges[k + 1].toFixed(4); parts.push(q); }
    if (p.reverse) parts.reverse();
    const i = S.proj.pieces.indexOf(p);
    S.proj.pieces.splice(i, 1, ...parts); markHand();
    if (scenesOn() && p.unit !== undefined && p.unit !== null) {
      const K = kept(); let fresh = Math.max(...K.map((q) => (q.unit === undefined ? -1 : q.unit))) + 1;
      for (const q of parts.slice(1)) q.unit = fresh++;
      renumberScenes();
    }
    S.sel = new Set(parts); S.anchor = parts[0];
  });
  return ts.length;
}
/** Look harder for scene changes inside this section, and cut it there (each on its exact frame). */
async function findCutsIn(p) {
  if (locked()) { lockedNote(); return; }
  toast("Looking for scene changes in this section…");
  let r;
  try { r = await api("/api/scenes/inside", { method: "POST", json: { id: S.proj.source, start: p.start, end: p.end, sens: 1.8 } }); }
  catch (e) { toast(errText(e), true); return; }
  if (r.state === "waiting") { toast("The app is still looking at this video's pictures (" + Math.round((r.progress || 0) * 100) + "%). Try again in a moment.", true); return; }
  const n = splitAtSource(p, r.cuts);
  toast(n ? "Cut at " + n + " scene change" + (n > 1 ? "s" : "") + ", each on its exact frame." : "No other scene change was found in this section.");
  loadCuts();
}
/** Cut on the exact frame where the picture changes, near the given moment of the timeline. */
async function cutExact(t) {
  if (locked()) { lockedNote(); return; }
  const hit = segAt(t); if (!hit) return;
  const p = hit.s.p, src = p.reverse ? p.end - (t - hit.s.out0) * p.speed : p.start + (t - hit.s.out0) * p.speed;
  let r;
  try { r = await api("/api/scenes/exact", { method: "POST", json: { id: S.proj.source, t: src, radius: 0.6 } }); }
  catch (e) { toast(errText(e), true); return; }
  if (!r.found) { toast("No clear picture change near here. Zoom in and cut by hand (S)."); return; }
  if (!splitAtSource(p, [r.t])) { toast("The picture changes too close to the edge of this section to cut there."); return; }
  const at = layout().find((q) => q.p.start === +r.t.toFixed(4) || (p.reverse && q.p.end === +r.t.toFixed(4)));
  if (at) seek(at.out0);
  toast("Cut on the exact frame where the picture changes.");
}

// ---- Track: right-click a section (Final, with a frame) and draw a box around something: the picture moves with it
/** The tracked offset at source time t, kept inside the edges of the picture. */
function trackOffset(pl, t) {
  const tr = pl.track; if (!tr || !tr.path || tr.path.length < 2) return [0, 0];
  const P = tr.path; let lo = 0, hi = P.length - 1;
  if (t <= P[0][0]) return [P[0][1], tr.axes === "xy" ? P[0][2] : 0];
  if (t >= P[hi][0]) return [P[hi][1], tr.axes === "xy" ? P[hi][2] : 0];
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (P[m][0] <= t) lo = m; else hi = m; }
  const k = (t - P[lo][0]) / Math.max(1e-6, P[hi][0] - P[lo][0]);
  return [P[lo][1] + (P[hi][1] - P[lo][1]) * k, tr.axes === "xy" ? P[lo][2] + (P[hi][2] - P[lo][2]) * k : 0];
}
/** How big the picture is on the canvas, as a share of the canvas (wider than 1 = it reaches past the sides). */
function pictureShare(f) {
  const fr = Frame.full(S.proj.settings.frame), RAT = { "9:16": 9 / 16, "16:9": 16 / 9, "4:3": 4 / 3, "3:4": 3 / 4, "1:1": 1, "4:5": 4 / 5, "2.35:1": 2.35, "2:1": 2, "1.85:1": 1.85, "5.8in": 9 / 19.5 };
  const va = S.info.width / Math.max(1, S.info.height), ca = RAT[fr.ratio] || va;
  const fitW = va >= ca ? 1 : va / ca, fitH = va >= ca ? ca / va : 1;
  return { w: fitW * f.scale, h: fitH * f.scale };
}
function simplifyTrack(path) {
  if (path.length < 3) return path;
  const out = [path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    const a = out[out.length - 1], b = path[i + 1], q = path[i], k = (q[0] - a[0]) / Math.max(1e-6, b[0] - a[0]);
    const ex = a[1] + (b[1] - a[1]) * k, ey = a[2] + (b[2] - a[2]) * k;
    if (Math.abs(ex - q[1]) > 0.003 || Math.abs(ey - q[2]) > 0.003 || q[0] - a[0] > 2) out.push(q);
  }
  out.push(path[path.length - 1]);
  return out;
}
function startTrack(p) {
  if (S.mode !== "final" || !Frame.active(S.proj.settings.frame)) { toast("Track works with a frame (Picture panel, for example 9:16). Choose a shape there first.", true); return; }
  if (trackLocked("video")) { lockedNote("video"); return; }
  const f = Frame.full(effectiveFrame());
  if (Math.abs(f.rotate) > 0.5) { toast("Turn this section back to straight (Rotate 0) first, then track.", true); return; }
  pause();
  const r0 = layout().find((q) => q.p === p); if (!r0) return;
  if (!(S.t >= r0.out0 && S.t < r0.out1)) seek(r0.out0 + Math.min(0.2, (r0.out1 - r0.out0) / 2));
  S.sel = new Set([p]); refreshAll({ keepVideo: true });
  const layer = $("drawLayer"), bx = $("drawBox");
  layer.hidden = false;
  toast("Drag a box tightly around the thing to track (a face, a person, a car).");
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
    // canvas box -> picture (source) fractions: undo the frame's move and size
    const cv = $("frame").querySelector("canvas.frame-cv"), cb = ((cv && cv.parentElement) || $("frame")).getBoundingClientRect();   // the canvas the frame is drawn on
    if (cb.width < 4 || cb.height < 4) { toast("The picture is not showing. Open the Picture panel once, then try again.", true); return; }
    const sh = pictureShare(f), cw = cb.width, ch = cb.height;
    const pw = sh.w * cw, ph = sh.h * ch, pl = cb.left + cw / 2 + f.x * cw / 2 - pw / 2, ptop = cb.top + ch / 2 + f.y * ch / 2 - ph / 2;
    const box = { x: clamp((r.x - pl) / pw, 0, 1), y: clamp((r.y - ptop) / ph, 0, 1), w: r.w / pw, h: r.h / ph };
    const hit = segAt(S.t), srcT = p.reverse ? p.end - (S.t - hit.s.out0) * p.speed : p.start + (S.t - hit.s.out0) * p.speed;
    const ox0 = box.x + box.w / 2, oy0 = box.y + box.h / 2;
    toast("Tracking it through this section…");
    try {
      const res = await api("/api/track", { method: "POST", json: { input: S.proj.source, at: clamp(srcT, p.start, p.end), box, start: p.start, end: p.end } });
      // the picture moves the other way to how the thing moves, so the thing stays where it was on the canvas
      const path = simplifyTrack(res.path.map(([t, ox, oy]) => [t, +(-(ox - ox0) * sh.w * 2).toFixed(5), +(-(oy - oy0) * sh.h * 2).toFixed(5)]));
      change(() => {
        const base = Frame.full(S.proj.settings.frame);
        const own = Object.assign({ x: base.x, y: base.y, scale: base.scale, rotate: base.rotate }, p.place || {});
        own.track = { path, found: res.found, axes: (p.place && p.place.track && p.place.track.axes) || "x" };
        p.place = own;
      }, { keepVideo: true });
      Frame.refresh && Frame.refresh();
      toast("Tracked: found it " + Math.round(res.found * 100) + "% of the time" + (res.found < 0.7 ? ". Try a tighter box around something with a clear shape." : ". Play it to see."), res.found < 0.7);
    } catch (e) { toast(errText(e), true); }
  };
  layer.addEventListener("pointerdown", down); layer.addEventListener("pointermove", move); layer.addEventListener("pointerup", up);
}
function stopTrack(ps) {
  change(() => { for (const p of ps) if (p.place && p.place.track) { const o = Object.assign({}, p.place); delete o.track; p.place = o; } }, { keepVideo: true });
  Frame.refresh && Frame.refresh();
  toast("Tracking removed.");
}
function trackBox(ps) {
  const tr = ps.map((p) => p.place && p.place.track).filter(Boolean);
  if (!tr.length || S.mode !== "final") return null;
  const axes = tr.every((t) => t.axes === "xy") ? "xy" : tr.every((t) => t.axes !== "xy") ? "x" : "";
  const found = Math.round(Math.min(...tr.map((t) => t.found)) * 100);
  return el("div", { class: "pad track-box" },
    el("div", { class: "row between" }, el("b", { text: "Tracking" }), el("span", { class: "note num", text: "found " + found + "%" })),
    el("div", { class: "field" }, el("span", { text: "Follow" }), segmented([["x", "Left–right"], ["xy", "Left–right and up–down"]], axes, (v) => {
      change(() => { for (const p of ps) if (p.place && p.place.track) p.place = Object.assign({}, p.place, { track: Object.assign({}, p.place.track, { axes: v }) }); }, { keepVideo: true });
      Frame.refresh && Frame.refresh();
    })),
    el("p", { class: "hint", text: "The picture moves so the tracked thing stays where you saw it. Drag the picture to place it; it keeps tracking." }),
    el("div", { class: "btns" }, ps.length === 1 ? btn("Track again", { icon: "target", cls: "sm", onclick: () => startTrack(ps[0]) }) : null,
      btn("Stop tracking", { icon: "x", cls: "sm ghost", onclick: () => stopTrack(ps) })));
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
  let quality = S.proj.settings.quality || "best", esize = S.proj.settings.export_size || "4k";
  let loud = +S.proj.settings.loudness_step || 0;
  const pickLoud = (v) => {                        // heard at once in the player (it plays from the playhead): nothing is made
    loud = +v; loudTxt.textContent = loudNote(loud);
    change(() => { S.proj.settings.loudness_step = loud; }, { keepVideo: true });
    if (MCTX && MCTX.state === "suspended") MCTX.resume();
    applyMaster();
    if (!S.playing) play();
    listen.replaceChildren(icon("pause", "s"), el("span", { text: "Stop listening" }));
  };
  const esc = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } };
  const close = () => { scrim.remove(); dlg.remove(); document.removeEventListener("keydown", esc, true); };
  document.addEventListener("keydown", esc, true);                 // Esc closes it, like every other window in the app
  const scrim = el("div", { class: "scrim", onclick: close });
  const sh = S.proj.settings.shape || "original", fr = S.proj.settings.frame;
  const RAT = { "16:9": 16 / 9, "4:3": 4 / 3, "2.35:1": 2.35, "2:1": 2, "1.85:1": 1.85, "9:16": 9 / 16, "3:4": 3 / 4, "1:1": 1, "4:5": 4 / 5, "5.8in": 9 / 19.5 };
  const aspect = fr ? (RAT[fr.ratio] || S.info.width / Math.max(1, S.info.height)) : sh.startsWith("vertical") ? 9 / 16 : sh.startsWith("square") ? 1 : S.info.width / Math.max(1, S.info.height);
  const sizeOf = (v) => { const L = { "4k": 3840, "1440": 2560, "1080": 1920 }[v] || Math.max(S.info.width, S.info.height); const w = aspect >= 1 ? L : L * aspect, h = aspect >= 1 ? L / aspect : L; return Math.round(w / 2) * 2 + "×" + Math.round(h / 2) * 2; };
  const sizeTxt = el("span", { class: "num", text: sizeOf(esize) });
  const MF = { youtube: ["YouTube", -14], tiktok: ["TikTok", -14], instagram: ["Instagram", -14], podcast: ["Podcast", -16], tv: ["TV", -23] };
  let made = S.proj.settings.made_for || "youtube";
  const loudNote = (k) => { const [name, base] = MF[made];
    return (k === 0 ? "The whole video at the " + name + " standard (" + String(base).replace("-", "−") + " LUFS)." :
      "The whole video " + (Math.abs(k) * 1.5).toFixed(1) + " dB " + (k < 0 ? "quieter" : "louder") + " than the " + name + " standard (" + (base + k * 1.5).toFixed(1).replace("-", "−") + " LUFS).") +
      (k > 0 && made !== "tv" ? " " + name + " turns videos louder than its standard down again, so this mostly makes the sound denser." : ""); };
  const pickMade = (v) => { made = v; change(() => { S.proj.settings.made_for = v; }, { keepVideo: true }); loudTxt.textContent = loudNote(loud); };
  const loudTxt = el("p", { class: "hint", text: loudNote(loud) });
  const listen = btn(S.playing ? "Stop listening" : "Listen", { icon: S.playing ? "pause" : "play", cls: "sm ghost", title: "Play the video here with this loudness (nothing is made)",
    onclick: () => { if (S.playing) { pause(); listen.replaceChildren(icon("play", "s"), el("span", { text: "Listen" })); } else { if (MCTX && MCTX.state === "suspended") MCTX.resume(); applyMaster(); play(); listen.replaceChildren(icon("pause", "s"), el("span", { text: "Stop listening" })); } } });
  const go = async (preview) => {
    try {
      if (quality !== S.proj.settings.quality) { S.proj.settings.quality = quality; }
      S.proj.settings.export_size = esize;
      S.proj.settings.loudness_step = loud;
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
        el("div", { class: "stat" }, el("span", { class: "lbl", text: "Size" }), sizeTxt),
        el("div", { class: "stat" }, el("span", { class: "lbl", text: "Pieces" }), el("span", { class: "num", text: String(kept().length) }))),
      el("div", { class: "field" }, el("span", { text: "Picture size" }), segmented([["4k", "4K"], ["1440", "1440p"], ["1080", "1080p"], ["source", "As the video"]], esize, (v) => { esize = v; sizeTxt.textContent = sizeOf(v); })),
      el("div", { class: "field" }, el("span", { text: "Quality" }), segmented([["best", "Best"], ["high", "High"], ["small", "Smaller file"]], quality, (v) => { quality = v; })),
      el("div", { class: "field" }, el("span", { text: "Made for" }), segmented(Object.entries(MF).map(([k, [l]]) => [k, l]), made, pickMade)),
      el("div", { class: "field" }, el("span", { text: "Overall loudness" }),
        segmented([[-3, "−3"], [-2, "−2"], [-1, "−1"], [0, "Standard"], [1, "+1"], [2, "+2"], [3, "+3"]], loud, pickLoud)),
      el("div", { class: "row loud-row" }, listen, loudTxt),
      el("p", { class: "hint", text: "4K + Best gives the sharpest result on YouTube (it streams 4K uploads at a higher quality, also to 1080p viewers). The file is big and takes longer." }),
      el("div", { class: "btns" }, btn("Quick preview file", { icon: "eye", title: "Makes a small, fast video file of the whole mix (shows in Exports). To only hear the loudness, use Listen.", onclick: () => go(true) }), el("span", { class: "grow" }), btn("Export", { icon: "export", cls: "primary big", onclick: () => go(false) }))));
  document.body.append(scrim, dlg);
}

// ================================================================== other projects (Media panel)
function projItem(p, cur) {
  const tag = p.version ? p.version.charAt(0).toUpperCase() + p.version.slice(1) + " · " : "";
  return el("div", { class: "item" + (cur ? " on" : ""), onclick: () => { location.href = "/" + (p.stage === "final" || p.stage === "studio" ? p.stage : "edit") + "?p=" + p.id; } },
    icon("layers"), el("div", { class: "t" }, el("b", { text: p.name }), el("small", { text: tag + fmtTime(p.length, 0) + " · " + p.pieces + " sections" })), icon("chevr", "s"));
}

// ================================================================== open a project
async function openProject() {
  let r;
  try { r = await api("/api/projects/" + S.id); }
  catch (e) { location.replace("/?msg=" + encodeURIComponent(errText(e))); return; }
  S.proj = r.project; S.info = r.info;
  loadHistory();
  const stage = S.proj.stage === "final" || S.proj.stage === "studio" ? S.proj.stage : "edit";
  const here = S.studio ? "studio" : S.mode;
  if (stage !== here) { location.replace("/" + stage + "?p=" + S.id); return; }       // the project belongs to the other stage
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
  loadPeaks(); loadCuts();
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
  setTimeout(loadCuts, 300);
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
  for (const n of document.querySelectorAll("[data-stage]")) n.hidden = n.dataset.stage === "studio" ? !S.studio : n.dataset.stage !== S.mode;
  document.body.classList.toggle("stage-final", S.mode === "final");
  document.body.classList.toggle("stage-studio", !!S.studio);
  document.body.classList.toggle("stage-edit", S.mode === "edit");
  $("suite").classList.add(S.mode === "final" ? "final" : "edit");
}


// ================================================================== Studio: precision tools (only on /studio)
/** Read a typed time: 1:23.40, 1:02:03, 83.4, 83.4s, or a frame number like 2075f. Returns seconds or null. */
function parseTime(txt) {
  const t = String(txt || "").trim().toLowerCase().replace(",", ".");
  if (!t) return null;
  let m = t.match(/^(\d+)\s*f$/);
  if (m) return +m[1] / (S.info.fps_float || 25);
  m = t.match(/^(\d+(?:\.\d+)?)\s*s?$/);
  if (m) return +m[1];
  m = t.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
  if (m) return +m[1] * 60 + +m[2];
  m = t.match(/^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3];
  return null;
}
const Studio = {
  inT: null, outT: null,
  marks() { return S.proj.settings.markers || (S.proj.settings.markers = []); },
  wire() {
    if (!S.studio) return;
    const box = $("stTime");
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); const t = parseTime(box.value); if (t === null) { toast("Type a time like 1:23.40, 83.4 or 2075f.", true); return; } seek(t); box.blur(); }
      else if (e.key === "Escape") { box.value = ""; box.blur(); }
    });
    box.addEventListener("focus", () => { if (!box.value) box.value = fmtTime(S.t, 2); box.select(); });
    $("stCutAt").addEventListener("click", () => {
      const t = parseTime(box.value);
      if (box.value.trim() && t === null) { toast("Type a time like 1:23.40, 83.4 or 2075f.", true); return; }
      if (t !== null) seek(t);
      splitAtPlayhead();
    });
    $("stIn").addEventListener("click", () => this.setIn());
    $("stOut").addEventListener("click", () => this.setOut());
    $("stRipple").addEventListener("click", () => this.ripple());
    $("stMarks").addEventListener("click", (e) => { const r = e.currentTarget.getBoundingClientRect(); ctxMenu(this.markItems(), r.left, r.bottom + 4); });
    this.paint();
  },
  setIn() { this.inT = +S.t.toFixed(3); if (this.outT !== null && this.outT <= this.inT) this.outT = null; this.paint(); toast("In point at " + fmtTime(this.inT, 2) + (this.outT === null ? ". Now go to the end and press O." : ".")); },
  setOut() { this.outT = +S.t.toFixed(3); if (this.inT !== null && this.inT >= this.outT) this.inT = null; this.paint(); toast("Out point at " + fmtTime(this.outT, 2) + (this.inT === null ? ". Now go to the start and press I." : ".")); },
  clearInOut() { this.inT = this.outT = null; this.paint(); },
  /** Take out everything between In and Out and close the gap (pieces are trimmed, split or taken away). */
  ripple() {
    if (this.inT === null || this.outT === null) { toast("Set an In point (I) and an Out point (O) first.", true); return; }
    if (locked()) { lockedNote(); return; }
    const a = this.inT, b = this.outT, src = (r, t) => (r.p.reverse ? r.p.end - (t - r.out0) * r.p.speed : r.p.start + (t - r.out0) * r.p.speed);
    const L = layout().filter((r) => r.out1 > a + 1e-6 && r.out0 < b - 1e-6);
    if (!L.length) { toast("Nothing between In and Out."); return; }
    change(() => {
      for (const r of L) {
        const p = r.p, i = S.proj.pieces.indexOf(p);
        const keepA = r.out0 < a - 1e-6, keepB = r.out1 > b + 1e-6;
        if (!keepA && !keepB) { p.off = true; continue; }
        const cA = keepA ? +src(r, a).toFixed(4) : null, cB = keepB ? +src(r, b).toFixed(4) : null;
        const front = clone(p), back = clone(p);              // front: the part before In; back: the part after Out
        if (p.reverse) { if (keepA) { front.start = cA; } if (keepB) { back.end = cB; } }
        else { if (keepA) { front.end = cA; } if (keepB) { back.start = cB; } }
        const parts = [];
        if (keepA && front.end - front.start >= MIN_PIECE) parts.push(front);
        if (keepB && back.end - back.start >= MIN_PIECE) parts.push(back);
        if (!parts.length) { p.off = true; continue; }
        S.proj.pieces.splice(i, 1, ...parts);
      }
      S.sel.clear(); markHand();
      // markers after the gap move up with the video; markers inside it go
      const gone = b - a;
      S.proj.settings.markers = this.marks().filter((m) => m.t < a || m.t >= b).map((m) => (m.t >= b ? { t: +(m.t - gone).toFixed(3), note: m.note } : m));
    });
    this.inT = this.outT = null; seek(a); this.paint();
    toast("Removed " + fmtTime(b - a, 2) + " and closed the gap · video now " + fmtTime(finalTotal()) + ". Ctrl + Z brings it back.");
  },
  addMark() {
    const t = +S.t.toFixed(3), list = this.marks();
    if (list.some((m) => Math.abs(m.t - t) < 0.02)) { toast("There is already a marker here."); return; }
    if (list.length >= 200) { toast("200 markers is the most.", true); return; }
    change(() => { S.proj.settings.markers = list.concat([{ t, note: "" }]).sort((x, y) => x.t - y.t); }, { keepVideo: true });
    this.paint(); toast("Marker at " + fmtTime(t, 2) + ". Jump to it from the Markers button.");
  },
  async noteMark(m) {
    const v = await askText("Marker note", m.note, "What happens here");
    if (v === null || v === undefined) return;
    change(() => { const x = this.marks().find((q) => q.t === m.t); if (x) x.note = String(v).slice(0, 80); }, { keepVideo: true });
  },
  dropMark(m) { change(() => { S.proj.settings.markers = this.marks().filter((q) => q.t !== m.t); }, { keepVideo: true }); this.paint(); },
  jumpMark(dir) {
    const list = this.marks(), t = S.t;
    const m = dir > 0 ? list.find((q) => q.t > t + 0.01) : list.slice().reverse().find((q) => q.t < t - 0.01);
    if (m) seek(m.t); else toast(dir > 0 ? "No marker after the playhead." : "No marker before the playhead.");
  },
  markItems() {
    const list = this.marks(), out = [["Add a marker here", "bookmark", () => this.addMark(), { key: "M" }]];
    if (list.length) out.push(["Next marker", "chevr", () => this.jumpMark(1), { key: "Shift M" }],
      ["Clear all markers", "trash", () => { change(() => { S.proj.settings.markers = []; }, { keepVideo: true }); this.paint(); }, { danger: true }], "-");
    const near = list.length > 14 ? list.filter((m) => m.t >= S.t - 0.01).slice(0, 14) : list;   // a long list: the next 14 from the playhead
    for (const m of near) out.push([fmtTime(m.t, 2) + (m.note ? "  " + m.note : ""), "mark", null,
      { sub: [["Go there", "play", () => seek(m.t)], ["Add a note", "edit", () => this.noteMark(m)], "-", ["Remove marker", "trash", () => this.dropMark(m), { danger: true }]] }]);
    if (list.length > near.length) out.push([(list.length - near.length) + " more on the timeline ruler", "info", null, { off: true, why: "Click a marker on the ruler, or press Shift + M to jump to the next one." }]);
    return out;
  },
  paint() {
    if (!S.studio) return;
    $("stMarksN").textContent = String(this.marks().length);
    const ok = this.inT !== null && this.outT !== null;
    $("stRipple").hidden = !ok;
    if (ok) $("stRippleT").textContent = "Remove " + fmtTime(this.outT - this.inT, 2);
    $("stIn").classList.toggle("on", this.inT !== null); $("stOut").classList.toggle("on", this.outT !== null);
    renderRuler(rawTotal());
  },
  ruler(r) {
    if (this.inT !== null || this.outT !== null) {
      const a = this.inT === null ? this.outT : this.inT, b = this.outT === null ? a : this.outT;
      const band = el("div", { class: "st-range" + (this.inT !== null && this.outT !== null ? "" : " half") });
      band.style.left = px(a) + "px"; band.style.width = Math.max(2, px(b) - px(a)) + "px"; r.append(band);
    }
    for (const m of this.marks()) {
      const d = el("button", { type: "button", class: "st-mark", title: fmtTime(m.t, 2) + (m.note ? ": " + m.note : "") + " (click to go there, right-click for more)",
        onclick: (e) => { e.stopPropagation(); seek(m.t); },
        oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); ctxMenu([["Add a note", "edit", () => this.noteMark(m)], ["Remove marker", "trash", () => this.dropMark(m), { danger: true }]], e.clientX, e.clientY); } });
      d.style.left = px(m.t) + "px"; r.append(d);
    }
  },
  /** Studio keys. Returns true when the key was used. */
  key(e) {
    if (!S.studio) return false;
    const k = e.key, mod = e.ctrlKey || e.metaKey;
    if (mod || e.altKey) return false;
    const f = 1 / (S.info.fps_float || 25);
    if (k === ",") { seek(S.t - f); return true; }
    if (k === ".") { seek(S.t + f); return true; }
    if (k === "i" || k === "I") { this.setIn(); return true; }
    if (k === "o" || k === "O") { this.setOut(); return true; }
    if (k === "m") { this.addMark(); return true; }
    if (k === "M") { this.jumpMark(1); return true; }
    if (k === "j" || k === "J") { seek(S.t - 1); return true; }
    if (k === "k" || k === "K") { pause(); return true; }
    if (k === "l" || k === "L") { if (!S.playing) play(); return true; }
    if (k === "t" || k === "T") { $("stTime").focus(); return true; }
    if (k === "Escape" && (this.inT !== null || this.outT !== null)) { this.clearInOut(); return false; }
    return false;
  },
};

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
    change(() => { S.proj.settings.layers = layers().concat([{ file: d.id, volume: 0.2, mute: false, solo: false, auto: 1, duck: { on: true, by: { voices: 0.35 } }, fade_in: 3, fade_out: 3 }]); }, { keepVideo: true });
    renderMusicLayers(); if (S.playing) musicPlay();
    autoSongLevel(d.id);
  }));
  $("checkMix").addEventListener("click", soundCheck);
  $("qVoice").addEventListener("click", makeVoiceClear);
  $("qSilence").addEventListener("click", removeSilenceDialog);
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
  $("soloChip").addEventListener("click", stopSolo);
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
  $("bBack").addEventListener("click", backMenu);
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
    if (Studio.key(e)) { e.preventDefault(); return; }
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
    else if ((k === "Delete" || k === "Backspace") && S.msel && S.msel.ks.size) { e.preventDefault(); deleteMusicParts(e.shiftKey); }
    else if ((k === "Delete" || k === "Backspace") && aselList().length) { e.preventDefault(); stemChange((c) => { c.mute = true; }); }
    else if (k === "Delete" || k === "Backspace") { e.preventDefault(); removeSelected(); }
    else if (k === "Escape") { S.sel.clear(); S.asel = new Map(); S.msel = null; refreshAll({ keepVideo: true }); }
    else if (k === "ArrowLeft") { e.preventDefault(); seek(S.t - (e.shiftKey ? 1 : frame())); }
    else if (k === "ArrowRight") { e.preventDefault(); seek(S.t + (e.shiftKey ? 1 : frame())); }
    else if (k === "Home") seek(0); else if (k === "End") seek(rawTotal());
    else if (k === "+" || k === "=") zoomTo(S.pps * 1.5); else if (k === "-") zoomTo(S.pps / 1.5);
    else if (k === "]" && !mod) { e.preventDefault(); jumpCut(1); } else if (k === "[" && !mod) { e.preventDefault(); jumpCut(-1); }
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
  topBar(S.studio ? "/studio" : "/" + S.mode, [el("div", { class: "lenpill", title: "Length of the video" }, icon("clock", "s"), el("span", { text: "Video" }), el("b", { id: "topLen", text: "0:00.0" })),
    Object.assign(btn("Preview", { icon: "eye", title: "See the finished video before it is made: full window, with the frame, words and music (P)", onclick: () => startPreview() }), { id: "previewBtn" }),
    S.mode === "final" ? btn("Export", { icon: "export", cls: "primary", onclick: () => exportDialog() }) : null].filter(Boolean));
  paintIcons(); enhanceAll();
  if (!S.id) { location.replace("/?phase=" + (S.studio ? "studio" : S.mode)); return; }
  wire(); await openProject();
  if (S.proj && S.studio) Studio.wire();
})();
