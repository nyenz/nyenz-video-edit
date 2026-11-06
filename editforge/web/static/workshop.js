"use strict";
// Clips page (stage 1): one movie, many clips. This page does ONE job: cut clips out of a long movie.
// A clip can have several parts from different places in the movie. Parts and clips can be joined, split, nudged, copied.
// "Save & make clips" turns every clip into a small video file; after that the big movie is no longer needed ("Free up the movie").
// Looks and sound are not here: they belong to the next stage (Edit / Final).
// The project is saved in the app (not in this browser), a moment after every change. Every change can be undone.

const C = {
  id: "", cs: null, info: null, states: {}, sel: "", selPart: 0,   // sel: the chosen clip's id; selPart: the chosen part of it
  start: null, end: null, queue: null, stopAt: null,              // queue: parts still to play (Play clip / Play all)
  pps: 10, usingLight: false, scenes: [], sceneState: "none",
  saveTimer: 0, saving: null, pollTimer: 0, tab: "parts", step: 1,
  undo: [], redo: [],
  multi: new Set(), anchor: "",                                    // multi: clips chosen together (Ctrl / Shift + click)
};
const CONTEXT = 3;                                                  // seconds shown before and after for "With context"
const video = $("player");
const dur = () => (C.info ? C.info.duration : 0);
const frameLen = () => (C.info && C.info.fps_float ? 1 / C.info.fps_float : 0.04);
const clampT = (t) => clamp(t, 0, dur());
const clips = () => (C.cs ? C.cs.clips : []);
const selClip = () => clips().find((c) => c.id === C.sel) || null;
const selPartObj = () => { const c = selClip(); return c && c.parts.length ? c.parts[clamp(C.selPart, 0, c.parts.length - 1)] : null; };
const clipLen = (c) => c.parts.reduce((a, p) => a + p.end - p.start, 0) / (c.speed || 1);
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");
const canEdit = () => !!C.info;
const r3 = (v) => Math.round(v * 1000) / 1000;
const MIN_PART = 0.1;                                               // the smallest part the buttons will make (the server accepts 0.04)
const MAX_PARTS = 60;

// ------------------------------------------------------------------ saving (a moment after each change)
function changed() {
  clearTimeout(C.saveTimer);
  C.saveTimer = setTimeout(save, 600);
  renderClips();
}
async function save() {
  clearTimeout(C.saveTimer); C.saveTimer = 0;
  if (!C.cs) return;
  const body = { name: C.cs.name, clips: C.cs.clips };
  const run = (async () => {
    try {
      const v = await api("/api/clipsets/" + C.id, { method: "PUT", json: body });
      // keep what the person typed since; take the app's states (made / out of date)
      C.states = v.states;
      for (const c of v.clipset.clips) { const mine = clips().find((x) => x.id === c.id); if (mine) mine.made = c.made; }
      $("makeNote").textContent = "";
      renderClips();
    } catch (e) { $("makeNote").textContent = "Not saved: " + errText(e); }
  })();
  C.saving = run;
  await run;
}
async function flush() { if (C.saveTimer) { await save(); } else if (C.saving) await C.saving; }
// Leaving the page right after a change: send it anyway (keepalive lets the request finish after the page is gone).
window.addEventListener("pagehide", () => {
  if (!C.saveTimer || !C.cs) return;
  clearTimeout(C.saveTimer); C.saveTimer = 0;
  try {
    fetch("/api/clipsets/" + C.id, { method: "PUT", keepalive: true, headers: { "X-EditForge-Token": TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ name: C.cs.name, clips: C.cs.clips }) });
  } catch (e) { /* nothing more to do */ }
});

// ------------------------------------------------------------------ undo / redo (every change to the clips)
const snap = () => JSON.stringify({ clips: C.cs.clips, sel: C.sel, part: C.selPart });
function pushUndo(before) { C.undo.push(before); if (C.undo.length > 200) C.undo.shift(); C.redo = []; renderUndo(); }
/** Run a change to the clips; it can be undone afterwards. Return false from fn when nothing was changed. */
function commit(fn) {
  if (!C.cs || !canEdit()) return false;
  const before = snap();
  if (fn() === false) return false;
  pushUndo(before);
  fixSel(); changed(); renderAll();
  return true;
}
function restore(text) {
  const d = JSON.parse(text), made = new Map(clips().map((c) => [c.id, c.made]));
  C.cs.clips = d.clips.map((c) => Object.assign(c, { made: made.has(c.id) ? made.get(c.id) : c.made }));
  C.sel = d.sel; C.selPart = d.part;
  C.queue = null; C.stopAt = null;
  fixSel(); changed(); renderAll(); renderUndo();
}
function undo() { if (!C.undo.length || !canEdit()) return; C.redo.push(snap()); restore(C.undo.pop()); }
function redo() { if (!C.redo.length || !canEdit()) return; C.undo.push(snap()); restore(C.redo.pop()); }
function renderUndo() { $("bUndo").disabled = !C.undo.length || !canEdit(); $("bRedo").disabled = !C.redo.length || !canEdit(); }
function fixSel() {
  if (!clips().some((c) => c.id === C.sel)) C.sel = clips()[0] ? clips()[0].id : "";
  const c = selClip();
  C.selPart = c ? clamp(C.selPart, 0, c.parts.length - 1) : 0;
  for (const id of [...C.multi]) if (!clips().some((x) => x.id === id)) C.multi.delete(id);
}

// ------------------------------------------------------------------ opening the project
function banner(text, k) {
  const b = $("banner"); if (!text) { b.hidden = true; return; }
  b.hidden = false; $("bannerText").textContent = text; $("bannerBar").style.width = Math.round((k || 0) * 100) + "%";
}
function emptyView(title, hint, buttons) {
  $("empty").hidden = false; $("emptyTitle").textContent = title; $("emptyHint").textContent = hint || "";
  $("emptyBtns").replaceChildren(...(buttons || []));
}
async function openClipset(id) {
  C.id = id;
  let v;
  try { v = await api("/api/clipsets/" + id); } catch (e) { emptyView("This clip project could not be opened.", errText(e), [el("a", { class: "btn", href: "/" }, icon("home", "s"), el("span", { text: "Home" }))]); return; }
  C.cs = v.clipset; C.info = v.info; C.states = v.states;
  document.title = C.cs.name + " · Clips · Nyenz Edit";
  $("csName").value = C.cs.name;
  if (C.cs.clips.length) C.sel = C.cs.clips[0].id;
  if (!C.info) {
    $("suite").classList.add("no-movie");
    requestAnimationFrame(sizeFrame);
    emptyView(C.cs.freed ? "The movie was freed to save space." : "The movie of this project is not where it was.",
      C.cs.freed ? "Your made clips are on the left: watch them, or open one in Edit." : "It was moved or deleted. Your made clips still work.", []);
  } else {
    $("empty").hidden = true;
    const i = C.info;
    $("tTotal").textContent = fmtTime(i.duration); $("iLen").textContent = fmtTime(i.duration, 0);
    sizeFrame();
    if (i.preview && i.preview.state === "ready") useLight();
    else {
      if (i.plays_in_browser) video.src = mediaUrl(C.cs.source, false);
      let quick = false;
      if (i.has_video) ensurePreview(C.cs.source, i, (st) => {
        if (st.state === "running" && !i.plays_in_browser) banner(quick ? "Playing a quick copy. Making a lighter one for smoother jumping… " + Math.round(st.progress * 100) + "%"
          : "This movie's sound or picture cannot play in a browser (" + i.playback_note + "). Making a copy you can watch… " + Math.round(st.progress * 100) + "%", st.progress);
        if (st.state === "failed") banner("A light copy could not be made: " + st.error, 0);
      }, !i.plays_in_browser, () => { if (!i.plays_in_browser) { quick = true; useQuick(); } }).then((ok) => { if (ok) { banner(null); useLight(); } });
    }
    sceneStatus(false);
  }
  for (const b of ["setStart", "setEnd", "startIn", "endIn", "addNew", "addPart", "playSel", "sceneBtn", "playClip", "playCtx", "playAll", "newClip",
    "nSa", "nSb", "nEa", "nEb", "tSplit", "tCutOut", "tJoin", "tDup", "clipName", "tCutB", "tCutA", "tlSplit", "tlCutB", "tlCutA"]) $(b).disabled = !canEdit();
  fitZoom(); renderAll(); renderUndo(); poll();
}
function useQuick() {
  const at = video.currentTime || 0;
  video.src = mediaUrl(C.cs.source, "q");
  video.addEventListener("loadedmetadata", () => { video.currentTime = Math.min(at, dur()); }, { once: true });
}
function useLight() {
  const at = video.currentTime || 0;
  C.usingLight = true;
  video.src = mediaUrl(C.cs.source, true);
  video.addEventListener("loadedmetadata", () => { video.currentTime = Math.min(at, dur()); }, { once: true });
}
video.addEventListener("error", () => {
  if (!C.info || !video.getAttribute("src")) return;
  if (C.usingLight && C.info.plays_in_browser) { C.usingLight = false; video.src = mediaUrl(C.cs.source, false); return; }
  if (!C.usingLight) banner("This browser cannot play this movie directly. Making a light copy…", 0);
});
function sizeFrame() {
  const st = $("stage"), f = $("frame");
  const a = C.info && C.info.width && C.info.height ? C.info.width / C.info.height : 16 / 9;
  const W = st.clientWidth - 36, H = st.clientHeight - 20;
  let w = W, h = W / a; if (h > H) { h = H; w = H * a; }
  f.style.width = Math.max(40, Math.floor(w)) + "px"; f.style.height = Math.max(40, Math.floor(h)) + "px";
}

// ------------------------------------------------------------------ no project yet: the list of clip projects
async function chooser() {
  emptyView("Clip projects", "Open one, or start a new one from a movie.", []);
  let list = [];
  try { list = (await api("/api/clipsets")).clipsets.filter((p) => !p.trashed); } catch (e) { /* shown below */ }
  const box = $("clips"); box.replaceChildren();
  $("csName").closest(".field").hidden = true; $("newClip").hidden = true; $("makeBox").hidden = true;
  box.append(btn("New clip project", { icon: "plus", cls: "primary wide", onclick: newProject }));
  for (const p of list) box.append(el("div", { class: "item", onclick: () => { location.href = "/clips?c=" + p.id; } },
    el("div", { class: "t" }, el("b", { text: p.name }), el("small", { class: "num", text: p.clips + " clips · " + p.made + " made" }))));
}
async function newProject(fileId) {
  try {
    const d = typeof fileId === "string" ? { id: fileId } : await chooseFile("video");
    if (!d) return;
    const r = await api("/api/clipsets", { method: "POST", json: { source: d.id } });
    location.href = "/clips?c=" + r.clipset.id;
  } catch (e) { toast(errText(e), true); }
}

// ------------------------------------------------------------------ playing
function seek(t) { if (C.info) { C.stopAt = null; C.queue = null; video.currentTime = clampT(t); renderHead(); } }
/** Like seek, but at most once per screen refresh (for dragging). */
let seekPending = null;
function seekSoft(t) {
  if (!C.info) return;
  C.stopAt = null; C.queue = null;
  if (seekPending === null) requestAnimationFrame(() => { video.currentTime = clampT(seekPending); seekPending = null; renderHead(); });
  seekPending = t;
}
const playNow = () => { const p = video.play(); if (p && p.catch) p.catch(() => {}); };
function togglePlay() { if (!C.info) return; C.stopAt = null; C.queue = null; if (video.paused) playNow(); else video.pause(); }
function playRange(a, b) { if (!C.info) return; C.queue = null; video.currentTime = clampT(a); C.stopAt = clampT(b); playNow(); }
/** Play a list of {a, b, clip} one after the other. A part that starts where the last one ended continues without a jump. */
function playItems(items) {
  if (!items.length) return;
  C.queue = items.slice(1);
  startItem(items[0], true);
}
function startItem(it, jump) {
  showClip(it.clip);
  if (jump) video.currentTime = clampT(it.a);
  C.stopAt = clampT(it.b);
  if (video.paused) playNow();
}
function showClip(id) {
  if (!id || id === C.sel) return;
  C.sel = id; C.selPart = 0; renderClips(); renderSide(); renderLane();
}
function advance() {
  if (C.queue && C.queue.length) {
    const nx = C.queue.shift();
    startItem(nx, Math.abs(nx.a - C.stopAt) > 0.08);
  } else { video.pause(); if (C.stopAt !== null) video.currentTime = Math.min(C.stopAt, dur()); C.stopAt = null; C.queue = null; }
}
/** Play the chosen clip: its parts one after the other. */
function playClip() {
  const c = selClip();
  if (!c || !c.parts.length) { say("Choose a clip on the left first."); return; }
  playItems(c.parts.map((p) => ({ a: p.start, b: p.end, clip: c.id })));
}
/** Play the chosen part with a few seconds before and after it, so you see where it sits in the movie. */
function playContext() {
  const p = selPartObj();
  if (!p) { say("Choose a clip on the left first."); return; }
  playRange(Math.max(0, p.start - CONTEXT), Math.min(dur(), p.end + CONTEXT));
}
/** Play every clip, in the order of the list. */
function playAllClips() {
  const items = [];
  for (const c of clips()) for (const p of c.parts) items.push({ a: p.start, b: p.end, clip: c.id });
  if (!items.length) { say("There are no clips yet."); return; }
  playItems(items);
}
video.addEventListener("play", () => $("tPlay").replaceChildren(icon("pause")));
video.addEventListener("pause", () => $("tPlay").replaceChildren(icon("play")));
video.addEventListener("ended", () => { if (C.stopAt !== null) advance(); });       // a part that ends where the movie ends
video.addEventListener("timeupdate", () => { if (C.stopAt !== null && !video.paused && video.currentTime >= C.stopAt) advance(); });
function loop() {
  if (C.stopAt !== null && !video.paused && video.currentTime >= C.stopAt - 0.001) advance();
  if (!video.paused) { renderHead(); followHead(); }
  requestAnimationFrame(loop);
}
function renderHead() {
  const t = video.currentTime || 0;
  $("tNow").textContent = fmtTime(t);
  $("playhead").style.left = px(t) + "px";
  if (C.start !== null && C.end === null && t > C.start) $("selLen").textContent = fmtTime(t - C.start) + " so far";
}
function followHead() {
  if (dragging) return;
  const sc = $("tlScroll"), x = px(video.currentTime);
  if (x > sc.scrollLeft + sc.clientWidth - 30 || x < sc.scrollLeft) sc.scrollLeft = Math.max(0, x - 60);
}
function applyLive() { video.muted = $("tMute").dataset.off === "1"; }

// ------------------------------------------------------------------ marks and scenes
/** A short message under the mark bar. It goes away by itself after a few seconds. */
function say(m) {
  const n = $("markNote"); n.textContent = m; delete n.dataset.order;
  clearTimeout(C.noteTimer); C.noteTimer = setTimeout(() => { if (n.textContent === m) n.textContent = ""; }, 6000);
}
function selOk() { return C.start !== null && C.end !== null && C.end > C.start; }
function snapT(t) {
  if (!$("snap").checked || !C.scenes.length) return t;
  const tol = Math.min(3, 8 / C.pps);                       // about 8 screen pixels, so it never fights a precise mark when zoomed in
  let best = t, bd = tol;
  for (const s of [0, ...C.scenes, dur()]) { const d = Math.abs(s - t); if (d < bd) { bd = d; best = s; } }
  return best;
}
function renderMarks() {
  const s = C.start, e = C.end, ok = selOk(), c = selClip();
  if (document.activeElement !== $("startIn")) $("startIn").value = s === null ? "" : fmtTime(s, 2);
  if (document.activeElement !== $("endIn")) $("endIn").value = e === null ? "" : fmtTime(e, 2);
  const len = ok ? fmtTime(e - s, 2) : "–";
  $("selLen").textContent = len;
  $("iSel").textContent = ok ? "Marked " + len : "";
  $("playSel").disabled = !ok; $("addNew").disabled = !ok || !canEdit();
  $("addPart").disabled = !ok || !c || !canEdit();
  $("tCutOut").disabled = !ok || !c || !canEdit();
  $("addPartLabel").textContent = "Add to clip"; $("addPart").title = c ? "Add the marked part to " + c.name + " (A)" : "Choose a clip on the left first";
  const bad = s !== null && e !== null && e <= s, mn = $("markNote");      // only clear the note this function wrote
  if (bad) { mn.textContent = "The end must come after the start."; mn.dataset.order = "1"; }
  else if (mn.dataset.order) { mn.textContent = ""; delete mn.dataset.order; }
  const m = $("markSel");
  m.hidden = s === null;
  if (s !== null) {
    const b = e !== null && e > s ? e : Math.max(s, video.currentTime || s);
    m.style.left = px(s) + "px"; m.style.width = Math.max(2, px(b) - px(s)) + "px";
    $("markLen").textContent = ok ? len : "";
  }
  const bd = $("selBadge"); bd.hidden = !ok; if (ok) bd.replaceChildren(icon("mark", "s"), el("span", { text: "Marked " + len }));
}
function setStart(t) { C.start = snapT(clampT(t)); if (C.end !== null && C.end <= C.start) C.end = null; renderMarks(); }
function setEnd(t) { C.end = snapT(clampT(t)); if (C.start === null) C.start = 0; renderMarks(); }
function typed(input, which) {
  if (!input.value.trim()) { C[which] = null; renderMarks(); return; }
  const t = parseTime(input.value);
  if (t === null) { say("'" + input.value + "' is not a time. Write it like 1:23 or 1:02:03.5 or 75."); return; }
  if (which === "start") { C.start = clampT(t); if (C.end !== null && C.end <= C.start) C.end = null; } else { C.end = clampT(t); if (C.start === null) C.start = 0; }
  renderMarks();
}
function takeMarks() { const p = { start: r3(C.start), end: r3(C.end) }; C.start = C.end = null; return p; }
function clearMarks() { C.start = C.end = null; renderMarks(); }

// ------------------------------------------------------------------ names: "Movie name - Clip 01", "Clip 02", ...
function nameBase() { const b = (C.cs.name || "Clips").trim(); return b.length > 46 ? b.slice(0, 46).trim() : b; }
function autoName() {
  const base = nameBase(), re = new RegExp("^" + base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " - Clip (\\d+)$");
  let n = 0;
  for (const c of clips()) { const m = re.exec(c.name); if (m) n = Math.max(n, +m[1]); }
  return base + " - Clip " + String(n + 1).padStart(2, "0");
}
function projectQuality() { const c = clips()[0]; return c && c.settings && c.settings.quality ? c.settings.quality : "best"; }
function blankClip(parts) {
  return { id: newId(), name: autoName(), parts, color: { brightness: 0, contrast: 1, saturation: 1 }, speed: 1, volume: 1, mute: false,
    settings: { shape: "original", fade_in: 0, fade_out: 0, noise: "off", voice_boost: false, compress: false, bass: 0, treble: 0, quality: projectQuality() }, made: null };
}
const copyOf = (o) => JSON.parse(JSON.stringify(o));

// ------------------------------------------------------------------ the changes (each one can be undone)
function addNewClip() {
  if (!selOk()) { say("Mark a start and an end first."); return; }
  if (clips().length >= 300) { toast("A clip project can have at most 300 clips. Start a second project for the rest.", true); return; }
  commit(() => { const c = blankClip([takeMarks()]); C.cs.clips.push(c); C.sel = c.id; C.selPart = 0; });
  toast("Added: " + selClip().name + " · " + fmtTime(clipLen(selClip()), 1));
}
function addPartTo() {
  const c = selClip();
  if (!c) { addNewClip(); return; }
  if (!selOk()) { say("Mark a start and an end first."); return; }
  if (c.parts.length >= MAX_PARTS) { toast("A clip can have at most " + MAX_PARTS + " parts.", true); return; }
  commit(() => { c.parts.push(takeMarks()); C.selPart = c.parts.length - 1; });
  toast(c.name + ": " + c.parts.length + " parts · " + fmtTime(clipLen(c), 1));
}
/** Move one edge of the chosen part by the chosen step. which: "start" or "end"; dir: -1 earlier, +1 later. */
function nudge(which, dir) {
  const c = selClip(), p = selPartObj();
  if (!c || !p) { $("nNote").textContent = "Choose a clip first."; return; }
  const step = C.step;
  let moved = false, why = "";
  commit(() => {
    if (which === "start") {
      const v = r3(clamp(p.start + dir * step, 0, p.end - MIN_PART)); moved = v !== p.start; p.start = v;
      if (!moved) why = dir < 0 ? "That is already the start of the movie." : "That would leave too little of the part.";
    } else {
      const v = r3(clamp(p.end + dir * step, p.start + MIN_PART, dur())); moved = v !== p.end; p.end = v;
      if (!moved) why = dir > 0 ? "That is already the end of the movie." : "That would leave too little of the part.";
    }
    return moved;
  });
  $("nNote").textContent = why;
  if (moved) { video.pause(); video.currentTime = clampT(which === "start" ? p.start : Math.max(p.start, p.end - frameLen())); renderHead(); }
}
/** Split the chosen clip into two clips where the playhead is. */
function splitAtPlayhead() {
  const t = r3(video.currentTime || 0);
  const inside = (p) => t > p.start + MIN_PART / 2 && t < p.end - MIN_PART / 2;
  let c = selClip();
  if (!c || !c.parts.some(inside)) c = clips().find((x) => x.parts.some(inside)) || null;   // the clip under the playhead
  if (!c) { toast("Put the playhead inside a clip first: click on a clip on the timeline where you want to split.", true); return; }
  C.sel = c.id;
  const i = c.parts.findIndex(inside);
  if (clips().length >= 300) { toast("A clip project can have at most 300 clips.", true); return; }
  let made2 = null;
  commit(() => {
    const p = c.parts[i];
    const second = blankClip([{ start: t, end: p.end }, ...c.parts.slice(i + 1).map(copyOf)]);
    Object.assign(second, { color: copyOf(c.color), speed: c.speed, volume: c.volume, mute: c.mute, settings: copyOf(c.settings) });
    c.parts = [...c.parts.slice(0, i), { start: p.start, end: t }];
    C.cs.clips.splice(clips().indexOf(c) + 1, 0, second);
    C.selPart = c.parts.length - 1; made2 = second;
  });
  if (made2) toast("Split into two clips: " + c.name + " and " + made2.name + ".");
}
/** Cut before / Cut after (like CapCut's "delete left / delete right"): the part under the playhead loses what comes
 *  before (or after) the playhead. The chosen clip comes first; otherwise the marked range; otherwise any clip there. */
function cutSide(side, at) {
  const t = r3(clampT(at === undefined ? video.currentTime || 0 : at));
  const note = (m, bad) => { $("toolNote").textContent = m; say(m); if (bad) toast(m, true); };
  const inside = (p) => t > p.start + 0.02 && t < p.end - 0.02;
  const chosen = selClip();
  let c = null, i = -1;
  if (chosen) {
    if (chosen.parts[C.selPart] && inside(chosen.parts[C.selPart])) { c = chosen; i = C.selPart; }
    else { i = chosen.parts.findIndex(inside); if (i >= 0) c = chosen; }
  }
  if (!c && selOk() && t > C.start && t < C.end) {                 // only a marked range here: shorten the marks
    if (side === "before") C.start = t; else C.end = t;
    renderMarks(); note(side === "before" ? "The marked part now starts here." : "The marked part now ends here.");
    return;
  }
  if (!c) for (const x of clips()) { const j = x.parts.findIndex(inside); if (j >= 0) { c = x; i = j; break; } }
  if (!c) { note("Put the playhead inside a clip first: click on a clip on the timeline where you want to cut.", true); return; }
  const p = c.parts[i];
  if (side === "before" ? p.end - t < MIN_PART : t - p.start < MIN_PART) { note("That would leave too little of the clip.", true); return; }
  const gone = side === "before" ? t - p.start : p.end - t;
  commit(() => { if (side === "before") p.start = t; else p.end = t; C.sel = c.id; C.selPart = i; });
  video.pause(); video.currentTime = side === "before" ? t : Math.max(p.start, t - frameLen()); renderHead();
  note((side === "before" ? "Cut " : "Cut ") + fmtTime(gone, 1) + (side === "before" ? " before the playhead from " : " after the playhead from ") + c.name + ". It is now " + fmtTime(clipLen(c), 1) + ".");
}
/** Take the part between the marks out of the chosen clip (the rest stays, in two pieces when the cut is in the middle). */
function cutOutMarked() {
  const c = selClip();
  if (!c) { $("toolNote").textContent = "Choose a clip first."; return; }
  if (!selOk()) { $("toolNote").textContent = "Mark the part to take out first."; return; }
  const a = C.start, b = C.end, out = [];
  for (const p of c.parts) {
    if (b <= p.start || a >= p.end) { out.push(p); continue; }
    if (a - p.start >= MIN_PART) out.push({ start: p.start, end: r3(a) });
    if (p.end - b >= MIN_PART) out.push({ start: r3(b), end: p.end });
  }
  const touched = JSON.stringify(out) !== JSON.stringify(c.parts);
  if (!touched) { $("toolNote").textContent = "The marked part is not inside this clip."; return; }
  if (!out.length) { $("toolNote").textContent = "That would take out the whole clip. Delete the clip instead."; return; }
  if (out.length > MAX_PARTS) { $("toolNote").textContent = "That would make more than " + MAX_PARTS + " parts."; return; }
  commit(() => { c.parts = out; C.selPart = 0; clearMarks(); });
  $("toolNote").textContent = "Taken out. " + c.name + " is now " + fmtTime(clipLen(c), 1) + ".";
}
async function joinClip() {
  const c = selClip(); if (!c) { $("toolNote").textContent = "Choose a clip first."; return; }
  const others = clips().filter((x) => x.id !== c.id);
  if (!others.length) { $("toolNote").textContent = "There is no other clip to join yet."; return; }
  const next = clips()[clips().indexOf(c) + 1];
  const pick = await dialogBox("Join which clip to " + c.name + "?", [
    el("p", { class: "hint", text: "Its parts are added after the parts of " + c.name + ". The clip you pick is then gone from the list." }),
    el("div", { class: "list pick-list" }, ...others.map((o) => el("div", { class: "item" + (next && o.id === next.id ? " on" : ""), "data-id": o.id, tabindex: "0" },
      el("div", { class: "t" }, el("b", { text: o.name }), el("small", { class: "num", text: fmtTime(clipLen(o), 1) + " · " + o.parts.length + " part" + (o.parts.length > 1 ? "s" : "") })))))],
  [["Cancel", null, "ghost"]], (done, dlg) => {
    for (const it of dlg.querySelectorAll(".pick-list .item")) {
      it.addEventListener("click", () => done(it.dataset.id));
      it.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); done(it.dataset.id); } });
    }
  });
  if (!pick) return;
  const o = clips().find((x) => x.id === pick); if (!o) return;
  if (c.parts.length + o.parts.length > MAX_PARTS) { $("toolNote").textContent = "That would make more than " + MAX_PARTS + " parts."; return; }
  commit(() => { c.parts = [...c.parts, ...o.parts.map(copyOf)]; C.cs.clips = clips().filter((x) => x.id !== o.id); C.sel = c.id; C.selPart = 0; });
  $("toolNote").textContent = "Joined. " + c.name + " now has " + c.parts.length + " parts · " + fmtTime(clipLen(c), 1) + ".";
}
function duplicateClip() {
  const c = selClip(); if (!c) { $("toolNote").textContent = "Choose a clip first."; return; }
  if (clips().length >= 300) { toast("A clip project can have at most 300 clips.", true); return; }
  commit(() => {
    const d = Object.assign(copyOf(c), { id: newId(), name: autoName(), made: null });
    C.cs.clips.splice(clips().indexOf(c) + 1, 0, d); C.sel = d.id; C.selPart = 0;
  });
  $("toolNote").textContent = "Copied as " + selClip().name + ".";
}
async function deleteClip(c, ask) {
  const st = stateOf(c);
  if (ask && !(await askYes("Delete the clip '" + c.name + "'?" + (st.file ? " Its made file stays in Exports." : ""), "Delete", true))) return;
  commit(() => { C.cs.clips = clips().filter((x) => x.id !== c.id); });
}
async function renameClip(c) {
  const n = await askText("Name of the clip", c.name, "Clip name");
  if (n && n !== c.name) commit(() => { c.name = n.slice(0, 60); });
}

async function sceneStatus(start) {
  if (!C.info || !C.info.has_video) { $("sceneBtn").hidden = true; return; }
  try {
    const st = start ? await api("/api/scenes", { method: "POST", json: { id: C.cs.source } }) : await api("/api/scenes?id=" + encodeURIComponent(C.cs.source));
    C.sceneState = st.state;
    if (st.state === "ready") { C.scenes = st.scenes; $("sceneLabel").textContent = st.scenes.length + 1 + " scenes"; $("sceneBtn").disabled = true; renderLane(); }
    else if (st.state === "running" || st.state === "queued") {
      $("sceneLabel").textContent = st.state === "queued" ? "Waiting (" + (st.place || 1) + " in line)…" : "Finding scenes… " + Math.round(st.progress * 100) + "%";
      $("sceneBtn").disabled = true; setTimeout(() => sceneStatus(false), 1000);
    }
    else if (st.state === "failed") { $("sceneLabel").textContent = "Find scenes"; $("sceneBtn").disabled = false; toast("Scenes could not be found: " + st.error, true); }
    else { $("sceneLabel").textContent = "Find scenes"; $("sceneBtn").disabled = false; }
  } catch (e) { toast(errText(e), true); }
}

// ------------------------------------------------------------------ the clips list (left)
const STATE_TEXT = { none: "Not made", queued: "Waiting", running: "Making", done: "Made", failed: "Failed", old: "Changed: make again" };
function stateOf(c) { return C.states[c.id] || { state: "none", file: "", progress: 0 }; }
function renderClips() {
  const box = $("clips"); box.replaceChildren();
  if (!clips().length) box.append(el("p", { class: "hint", text: canEdit() ? "No clips yet. Drag on the strip below to mark a part of the movie, then press Add as new clip." : "This project has no clips." }));
  clips().forEach((c, i) => {
    const st = stateOf(c);
    const chip = el("span", { class: "st-chip " + st.state, text: STATE_TEXT[st.state] + (st.state === "running" ? " " + Math.round(st.progress * 100) + "%" : "") });
    const acts = el("div", { class: "acts" });
    if (st.file && (st.state === "done" || st.state === "old")) {
      acts.append(btn("", { icon: "eye", cls: "ghost icon sm", title: "Watch the made clip", onclick: (e) => { e.stopPropagation(); watch(c, st.file); } }),
        btn("", { icon: "layers", cls: "ghost icon sm", title: "Edit this clip (next stage)", onclick: async (e) => { e.stopPropagation(); await flush(); openInEditor(st.file, 2); } }));
    }
    if (canEdit()) {
      acts.append(btn("", { icon: "up", cls: "ghost icon sm", title: "Move up", onclick: (e) => { e.stopPropagation(); move(i, -1); } }),
        btn("", { icon: "trash", cls: "ghost icon sm", title: "Delete this clip", onclick: (e) => { e.stopPropagation(); deleteClip(c, true); } }));
    }
    const pic = el("div", { class: "cthumb" });
    const src = st.file && !C.info ? thumbUrl(st.file, 0.3) : C.info && C.info.has_video ? thumbUrl(C.cs.source, Math.floor((c.parts[0].start + 0.3) * 2) / 2) : "";
    if (src) pic.append(el("img", { alt: "", loading: "lazy", src }));
    const nm = el("b", { text: shortName(c), title: c.name + (canEdit() ? " · double-click to rename" : "") });
    const row = el("div", { class: "item clip-row" + (c.id === C.sel ? " on" : "") + (C.multi.size > 1 && C.multi.has(c.id) ? " picked" : ""), "data-id": c.id, onclick: (e) => pick(c.id, e), ondblclick: (e) => { if (canEdit() && !e.ctrlKey && !e.shiftKey) renameClip(c); } },
      pic, el("div", { class: "t" }, nm, el("small", { class: "num", text: fmtTime(clipLen(c), 1) + " · " + c.parts.length + " part" + (c.parts.length > 1 ? "s" : "") }), chip), acts);
    row.title = canEdit() ? "Click to choose · Ctrl + click to choose more · drag to move · right-click for more" : "";
    onRightClick(row, () => clipItems(c));
    box.append(row);
  });
  dragSort(box, ".clip-row", (a, b) => commit(() => { const [x] = C.cs.clips.splice(a, 1); C.cs.clips.splice(b, 0, x); }), canEdit);
  renderMake();
  $("iCount").textContent = String(clips().length);
}
/** The right-click menu of a clip (in the list and on the timeline). at: the time under the mouse, if any. */
function clipItems(c, at, part) {
  const st = stateOf(c), ed = !canEdit(), i = clips().indexOf(c), here = at !== undefined;
  const group = chosen();
  if (group.length > 1 && group.includes(c)) {
    return [
      ["Combine " + group.length + " clips into one", "combine", combineChosen, { key: "Ctrl+J", off: ed }],
      ["Play them one after another", "play", () => playItems(group.flatMap((x) => x.parts.map((p) => ({ a: p.start, b: p.end, clip: x.id }))))],
      "-",
      ["Choose only this clip", "check", () => { C.multi.clear(); select(c.id); }],
      ["Clear the choice", "x", () => { C.multi.clear(); renderAll(); }, { key: "Esc" }],
      "-",
      ["Delete " + group.length + " clips", "trash", deleteChosen, { danger: true, key: "Del", off: ed }],
    ];
  }
  const choose = () => { if (C.sel !== c.id) { C.sel = c.id; C.selPart = part || 0; renderAll(); } else if (part !== undefined) { C.selPart = part; renderAll(); } };
  const made = st.file && (st.state === "done" || st.state === "old");
  return [
    ["Play this clip", "play", () => { choose(); playClip(); }, { key: "P" }],
    part !== undefined ? ["Play this part", "play", () => { const p = c.parts[part]; if (p) playRange(p.start, p.end); }] : null,
    made ? ["Watch the made clip", "eye", () => watch(c, st.file)] : null,
    made ? ["Edit it (next stage)", "layers", async () => { await flush(); openInEditor(st.file, 2); }] : null,
    "-",
    here ? ["Cut before here", "cutb", () => { choose(); cutSide("before", at); }, { key: "Q", off: ed }] : ["Cut before the playhead", "cutb", () => { choose(); cutSide("before"); }, { key: "Q", off: ed }],
    here ? ["Cut after here", "cuta", () => { choose(); cutSide("after", at); }, { key: "W", off: ed }] : ["Cut after the playhead", "cuta", () => { choose(); cutSide("after"); }, { key: "W", off: ed }],
    ["Split here", "scissors", () => { choose(); if (here) { video.pause(); video.currentTime = clampT(at); } setTimeout(splitAtPlayhead, here ? 60 : 0); }, { key: "S", off: ed }],
    part !== undefined && c.parts.length > 1 ? ["Remove this part", "x", () => commit(() => { c.parts.splice(part, 1); C.sel = c.id; C.selPart = 0; }), { off: ed }] : null,
    "-",
    ["Rename", "edit", () => renameClip(c), { off: ed }],
    ["Duplicate", "copy", () => { choose(); duplicateClip(); }, { key: "D", off: ed }],
    ["Choose more clips (Ctrl + click)", "check", () => { C.multi = new Set([C.sel || c.id, c.id].filter(Boolean)); C.sel = c.id; renderAll(); toast("Now hold Ctrl and click the other clips you want."); }],
    ["Join another clip to it", "combine", () => { choose(); joinClip(); }, { off: ed || clips().length < 2 }],
    ["Move up", "up", () => move(i, -1), { off: ed || i <= 0 }],
    ["Move down", "down", () => move(i, 1), { off: ed || i >= clips().length - 1 }],
    "-",
    ["Delete this clip", "trash", () => deleteClip(c, true), { danger: true, key: "Del", off: ed }],
  ];
}
function move(i, d) { const j = i + d; if (j < 0 || j >= clips().length) return; commit(() => { [C.cs.clips[i], C.cs.clips[j]] = [C.cs.clips[j], C.cs.clips[i]]; }); }
/** The short name shown in lists and on the timeline: "Clip 02" instead of "Movie.2007.1080p.BluRay - Clip 02". */
function shortName(c) {
  const base = nameBase() + " - ";
  return c.name.startsWith(base) && c.name.length > base.length ? c.name.slice(base.length) : c.name;
}
/** The chosen clips, in list order (one, or more with Ctrl / Shift + click). */
function chosen() { return C.multi.size > 1 ? clips().filter((c) => C.multi.has(c.id)) : clips().filter((c) => c.id === C.sel); }
/** Click on a clip. Ctrl + click adds it to (or takes it out of) the chosen clips; Shift + click chooses every clip in between. */
function pick(id, e) {
  if (e && (e.ctrlKey || e.metaKey)) {
    if (C.multi.size < 2) { C.multi = new Set(C.sel ? [C.sel] : []); }
    if (C.multi.has(id) && C.multi.size > 1) { C.multi.delete(id); if (C.sel === id) C.sel = [...C.multi][C.multi.size - 1]; }
    else { C.multi.add(id); C.sel = id; C.selPart = 0; }
    C.anchor = id; renderAll(); return;
  }
  if (e && e.shiftKey && (C.anchor || C.sel)) {
    const ids = clips().map((c) => c.id), a = ids.indexOf(C.anchor || C.sel), b = ids.indexOf(id);
    if (a >= 0 && b >= 0) { C.multi = new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1)); C.sel = id; C.selPart = 0; renderAll(); return; }
  }
  C.multi.clear(); C.anchor = id; select(id);
}
/** Put the chosen clips together into one clip (parts after each other, in list order). */
function combineChosen() {
  const list = chosen();
  if (list.length < 2) { toast("Hold Ctrl and click two or more clips first (in the list or on the timeline). Then Combine.", true); return; }
  const n = list.reduce((a, c) => a + c.parts.length, 0);
  if (n > MAX_PARTS) { toast("Together they have " + n + " parts. A clip can have at most " + MAX_PARTS + ".", true); return; }
  const first = list[0], gone = new Set(list.slice(1).map((c) => c.id));
  commit(() => {
    first.parts = list.flatMap((c) => c.parts.map(copyOf));
    C.cs.clips = clips().filter((c) => !gone.has(c.id));
    C.sel = first.id; C.selPart = 0; C.multi.clear();
  });
  toast("Combined " + list.length + " clips into " + shortName(first) + " · " + first.parts.length + " parts · " + fmtTime(clipLen(first), 1) + ". Ctrl + Z undoes it.");
}
async function deleteChosen() {
  const list = chosen(); if (!list.length) return;
  if (list.length === 1) { deleteClip(list[0], true); return; }
  if (!(await askYes("Delete these " + list.length + " clips? Made files stay in Made clips.", "Delete " + list.length, true))) return;
  const gone = new Set(list.map((c) => c.id));
  commit(() => { C.cs.clips = clips().filter((c) => !gone.has(c.id)); C.multi.clear(); });
}
function select(id) { C.sel = id; C.selPart = 0; C.queue = null; renderAll(); const c = selClip(); if (c && C.info) seek(c.parts[0].start); }
function watch(c, file) {
  dialogBox(c.name, [el("div", { class: "watch" }, miniPlayer(mediaUrl(file, false)))], [["Close", null, "ghost"]], (done, dlg) => dlg.classList.add("wide"));
}
function renderMake() {
  const list = clips(), states = list.map((c) => stateOf(c).state);
  const made = states.filter((s) => s === "done").length, busy = states.filter((s) => s === "queued" || s === "running").length;
  const todo = list.length - made - busy;
  $("clipTotals").textContent = list.length ? list.length + " · " + fmtTime(list.reduce((a, c) => a + clipLen(c), 0)) : "";
  $("makeWhat").textContent = !list.length ? "No clips yet" : made === list.length ? "All " + list.length + " made" : made + " of " + list.length + " made";
  const size = list.reduce((a, c) => a + (["done", "old"].includes(stateOf(c).state) ? stateOf(c).size || 0 : 0), 0);
  $("makeLen").textContent = busy ? "making " + busy : size ? fmtSize(size) : "";
  const bar = $("makeProg");
  bar.hidden = !busy;
  if (busy) {
    const p = list.reduce((a, c) => { const s = stateOf(c); return a + (s.state === "done" ? 1 : s.state === "running" ? s.progress : 0); }, 0) / Math.max(1, made + busy);
    bar.firstChild.style.width = Math.round(p * 100) + "%";
  }
  $("makeBtn").disabled = !canEdit() || !list.length || todo === 0;
  $("makeLabel").textContent = todo > 0 && made + busy > 0 ? "Save & make " + todo + " more" : "Save & make clips";
  $("freeBtn").hidden = !(list.length && made === list.length && C.info && !C.cs.freed);
  $("makeBox").hidden = !C.cs;
  $("qualBox").hidden = !canEdit();
  if (Qual) Qual.set(projectQuality());
}
async function makeClips() {
  $("makeNote").textContent = "Starting…";
  try {
    await flush();
    const v = await api("/api/clipsets/" + C.id + "/make", { method: "POST", json: {} });
    C.states = v.states;
    $("makeNote").textContent = v.started.length ? "Making " + v.started.length + " clip" + (v.started.length > 1 ? "s" : "") + ". You can keep working." : "Nothing new to make.";
    renderClips(); poll();
  } catch (e) { $("makeNote").textContent = errText(e); }
}
async function freeMovie() {
  try {
    await flush();
    let r = await api("/api/clipsets/" + C.id + "/free", { method: "POST", json: {} });
    if (r.ask) {
      const ok = await askYes("All clips are made. Delete the movie file from your computer to free " + fmtSize(r.size) + "?\n\n" + r.path +
        "\n\nThis cannot be undone. Your made clips are kept.", "Delete the movie", true);
      if (!ok) return;
      r = await api("/api/clipsets/" + C.id + "/free", { method: "POST", json: { delete_original: true } });
    }
    toast("Freed " + fmtSize(r.freed || 0) + ". Your clips are kept.");
    location.reload();
  } catch (e) { toast(errText(e), true); }
}
/** While clips are being made, ask for their state every second or so. */
async function poll() {
  clearTimeout(C.pollTimer);
  if (!C.cs) return;
  const busy = () => clips().some((c) => ["queued", "running"].includes(stateOf(c).state));
  if (!busy()) return;
  C.pollTimer = setTimeout(async () => {
    try {
      const v = await api("/api/clipsets/" + C.id);
      C.states = v.states;
      for (const c of v.clipset.clips) { const mine = clips().find((x) => x.id === c.id); if (mine) mine.made = c.made; }
      renderClips();
      if (!busy()) toast("All clips are made. Find them in Exports, or press the layers button to edit one.");
    } catch (e) { /* try again */ }
    poll();
  }, 1200);
}
/** The size of the made files: Best, Good or Small. It is the same for every clip of the project. */
const Qual = (() => { const n = segmented([["best", "Best"], ["high", "Good"], ["small", "Small"]], "best", (v) => setQuality(v)); $("mQual").append(n); return n; })();
function setQuality(v) {
  if (!canEdit() || !clips().length) { Qual.set(v); return; }
  commit(() => { for (const c of clips()) c.settings.quality = v; });
}

// ------------------------------------------------------------------ the chosen clip (right)
function renderTabs() {
  const tabs = $("clipTabs"); if (!tabs) return;             // the clip panel has no tabs any more: everything is on one page
  tabs.replaceChildren();
  for (const [k, label] of [["parts", "Parts"], ["tools", "Tools"]]) {
    tabs.append(el("button", { class: "tab" + (C.tab === k ? " on" : ""), type: "button", role: "tab", onclick: () => { C.tab = k; renderSide(); } }, el("span", { text: label })));
  }
  for (const p of document.querySelectorAll("[data-tab]")) p.hidden = p.dataset.tab !== C.tab;
}
function renderSide() {
  renderTabs();
  const many = chosen().length > 1;
  $("multiBox").hidden = !many;
  if (many) {
    const list = chosen();
    $("clipHead").textContent = list.length + " clips chosen";
    $("clipLen").textContent = fmtTime(list.reduce((a, x) => a + clipLen(x), 0), 1);
    $("multiList").replaceChildren(...list.map((x) => el("div", { class: "item" }, el("div", { class: "t" }, el("b", { text: shortName(x) }),
      el("small", { class: "num", text: fmtTime(clipLen(x), 1) + " · " + x.parts.length + " part" + (x.parts.length > 1 ? "s" : "") })))));
    $("mCombine").querySelector("span").textContent = "Combine into one clip";
    $("mDelete").querySelector("span").textContent = "Delete " + list.length + " clips";
    $("mCombine").disabled = $("mDelete").disabled = !canEdit();
    for (const id of ["noClipT", "clipNameBox", "partsBox", "toolsBox"]) $(id).hidden = true;
    return;
  }
  const c = selClip();
  $("clipHead").textContent = c ? c.name : "Mark a part";
  $("clipLen").textContent = c ? fmtTime(clipLen(c), 1) : "";
  $("clipNameBox").hidden = !c;
  if (c && document.activeElement !== $("clipName")) $("clipName").value = c.name;
  // parts
  const box = $("parts"); box.replaceChildren();
  $("partsBox").hidden = !c;
  if (c) c.parts.forEach((p, i) => {
    const mv = (d, ic, title) => dis(btn("", { icon: ic, cls: "ghost icon sm", title, onclick: (e) => {
      e.stopPropagation();
      const j = i + d; if (j < 0 || j >= c.parts.length) return;
      commit(() => { [c.parts[i], c.parts[j]] = [c.parts[j], c.parts[i]]; C.selPart = j; }); } }), !canEdit());
    const prow = el("div", { class: "item part-row" + (i === C.selPart ? " on" : ""), onclick: () => selectPart(i), ondblclick: () => playRange(p.start, p.end), title: "Click to go there · double-click to play · drag to change the order" },
      el("span", { class: "part-n num", text: String(i + 1) }),
      el("div", { class: "t" }, el("b", { class: "num", text: fmtTime(p.start) + " – " + fmtTime(p.end) }), el("small", { class: "num", text: fmtTime(p.end - p.start, 2) })),
      el("div", { class: "acts" },
        btn("", { icon: "play", cls: "ghost icon sm", title: "Play this part", onclick: (e) => { e.stopPropagation(); playRange(p.start, p.end); } }),
        mv(-1, "up", "Earlier in the clip"), mv(1, "down", "Later in the clip"),
        dis(btn("", { icon: "mark", cls: "ghost icon sm", title: "Change it: put it back in the marks", onclick: (e) => {
          e.stopPropagation();
          commit(() => { c.parts.splice(i, 1); C.start = p.start; C.end = p.end; if (!c.parts.length) C.cs.clips = clips().filter((x) => x !== c); });
          renderMarks(); seek(p.start); } }), !canEdit()),
        dis(btn("", { icon: "trash", cls: "ghost icon sm", title: "Remove this part", onclick: (e) => { e.stopPropagation(); commit(() => { c.parts.splice(i, 1); }); } }), !canEdit() || c.parts.length < 2)));
    onRightClick(prow, () => clipItems(c, undefined, i));
    box.append(prow);
  });
  if (c) dragSort(box, ".part-row", (a, b) => { const cc = selClip(); if (cc) commit(() => { const [x] = cc.parts.splice(a, 1); cc.parts.splice(b, 0, x); C.selPart = b; }); }, canEdit);
  // tools
  $("noClipT").hidden = !!c; $("toolsBox").hidden = !c;
  $("tJoin").disabled = !canEdit() || clips().length < 2;
  Step.set(String(C.step));
  const p = selPartObj();
  if (p && c) $("nStep").title = "Part " + (clamp(C.selPart, 0, c.parts.length - 1) + 1) + " of " + c.name;
  $("clipName").disabled = !canEdit();
  applyLive();
}
function selectPart(i) { C.selPart = i; const p = selPartObj(); renderSide(); renderLane(); if (p) seek(p.start); }
const dis = (b, off) => { b.disabled = !!off; return b; };
const Step = segmented([["0.1", "0.1 s"], ["1", "1 s"], ["5", "5 s"]], "1", (v) => { C.step = +v; });
$("nStep").append(Step);

// ------------------------------------------------------------------ timeline (the whole movie)
function px(t) { return Math.round(t * C.pps) + 16; }
function timeAt(x) { return (x - 16) / C.pps; }
function setZoom(pps, anchor) {
  const sc = $("tlScroll"), t = anchor === undefined ? video.currentTime || 0 : anchor, before = px(t) - sc.scrollLeft;
  C.pps = clamp(pps, 0.02, 200);
  $("zoom").value = String(clamp(Math.log(C.pps / 0.02) / Math.log(10000) * 100, 0, 100)); paintRange($("zoom"));
  renderLane(); sc.scrollLeft = Math.max(0, px(t) - before);
}
function fitZoom() { if (!C.info) return; setZoom(Math.max(0.02, ($("tlScroll").clientWidth - 84) / Math.max(1, dur())), 0); $("tlScroll").scrollLeft = 0; }
function renderRuler() {
  const r = $("ruler"); r.replaceChildren();
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const major = steps.find((s) => s * C.pps >= 90) || 3600;
  const minor = steps.slice().reverse().find((s) => s < major && s * C.pps >= 12 && (major / s) % 1 === 0) || major;
  const sc = $("tlScroll"), a = Math.max(0, timeAt(sc.scrollLeft) - major), b = Math.min(dur(), timeAt(sc.scrollLeft + sc.clientWidth) + major);
  for (let t = Math.floor(a / minor) * minor; t <= b + 1e-6; t += minor) {
    const maj = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    const tk = el("i", { class: maj ? "maj" : "" }); tk.style.left = px(t) + "px"; r.append(tk);
    if (maj) { const s = el("span", { text: fmtTime(t, 0) }); s.style.left = px(t) + "px"; r.append(s); }
  }
}
/** The picture strip: only the pictures on screen, and the ones already there stay (so scrolling does not flicker). */
function renderStrip() {
  const sc = $("tlScroll"), strip = $("stripAll");
  if (!C.info || !C.info.has_video) { strip.replaceChildren(); return; }
  const h = 64, ar = C.info.width / C.info.height || 16 / 9, w = Math.max(20, Math.round(h * ar));
  strip.style.left = px(0) + "px"; strip.style.width = (px(dur()) - px(0)) + "px";
  const key = C.pps + "|" + w;
  if (strip.dataset.key !== key) { strip.replaceChildren(); strip.dataset.key = key; }
  const first = Math.max(0, Math.floor((sc.scrollLeft - 16) / w) - 1), last = Math.ceil((sc.scrollLeft + sc.clientWidth) / w) + 1;
  const have = new Map();
  for (const img of Array.from(strip.children)) {
    const k = +img.dataset.k;
    if (k < first || k > last) img.remove(); else have.set(k, img);
  }
  for (let k = first; k <= last; k++) {
    const t0 = k * w / C.pps; if (t0 >= dur() || have.has(k)) continue;
    const at = Math.min(dur() - 0.05, t0 + w / C.pps / 2);
    const img = lazyThumb(thumbUrl(C.cs.source, Math.max(0, Math.floor(at))));
    img.dataset.k = String(k);
    img.style.left = (k * w) + "px"; img.style.width = w + "px"; strip.append(img);
  }
}
function renderLane() {
  const sc = $("tlScroll");
  $("tlInner").style.width = Math.max(sc.clientWidth, px(dur()) + 60) + "px";
  renderRuler();
  renderStrip();
  // scenes lane: one block per scene (only what is on screen)
  const ls = $("laneS"); ls.replaceChildren();
  if (C.scenes.length) {
    const edges = [0, ...C.scenes, dur()], a = timeAt(sc.scrollLeft), b = timeAt(sc.scrollLeft + sc.clientWidth);
    for (let i = 0; i < edges.length - 1; i++) {
      if (edges[i + 1] < a || edges[i] > b) continue;
      const d = el("div", { class: "scene" + (i % 2 ? " odd" : ""), "data-a": String(edges[i]), "data-b": String(edges[i + 1]),
        title: "Scene " + (i + 1) + " · " + fmtTime(edges[i + 1] - edges[i], 1) + " · click to mark it, double-click to add it" }, el("span", { text: String(i + 1) }));
      d.style.left = px(edges[i]) + "px"; d.style.width = Math.max(2, px(edges[i + 1]) - px(edges[i]) - 1) + "px"; ls.append(d);
    }
  } else ls.append(el("span", { class: "lane-note", text: C.sceneState === "running" ? "Finding scenes…" : "Scenes: press Find scenes" }));
  // parts lane: every clip's parts; the chosen clip's are bright and numbered, the chosen part has a frame
  // clips that cover the same minutes of the movie go on separate rows, so they never lie on top of each other
  const lc = $("laneC"); lc.replaceChildren();
  const items = [];
  clips().forEach((c) => c.parts.forEach((p, pi) => items.push({ c, p, pi })));
  items.sort((x, y) => x.p.start - y.p.start || x.p.end - y.p.end);
  const rowEnd = [];
  for (const it of items) {
    const x0 = px(it.p.start), x1 = Math.max(x0 + 6, px(it.p.end));
    let r = rowEnd.findIndex((e) => e <= x0 - 2);
    if (r < 0) { r = rowEnd.length; rowEnd.push(0); }
    rowEnd[r] = x1; it.row = r; it.x0 = x0; it.x1 = x1;
  }
  const ROW = 30, picked = C.multi.size > 1;
  lc.style.height = Math.max(1, rowEnd.length) * ROW + "px";
  for (const { c, p, pi, row, x0, x1 } of items) {
    const on = c.id === C.sel, cur = on && pi === C.selPart, pk = picked && C.multi.has(c.id);
    const label = shortName(c) + (c.parts.length > 1 ? " · " + (pi + 1) + "/" + c.parts.length : "");
    const d = el("div", { class: "lane-item cliptag" + (on ? " on" : "") + (cur ? " cur" : "") + (pk ? " picked" : ""), "data-c": c.id, "data-p": String(pi),
      title: c.name + " · part " + (pi + 1) + " · " + fmtTime(p.end - p.start, 2) + "\nClick: playhead here · drag: move · Ctrl + click: choose more · right-click: more" },
      on && canEdit() ? el("div", { class: "h l", "data-edge": "s" }) : null, el("span", { text: label }),
      on && canEdit() ? el("div", { class: "h r", "data-edge": "e" }) : null);
    d.style.left = x0 + "px"; d.style.width = x1 - x0 + "px"; d.style.top = row * ROW + "px"; d.style.height = ROW - 4 + "px"; lc.append(d);
  }
  renderMarks(); renderHead();
}
function renderAll() { renderClips(); renderSide(); renderLane(); }

let dragging = false;
function onTimelineDown(e) {
  if (!C.info || e.button !== 0) return;
  const sc = $("tlScroll"), rect = sc.getBoundingClientRect();
  const tAt = (ev) => clampT(timeAt(ev.clientX - rect.left + sc.scrollLeft));
  sc.setPointerCapture(e.pointerId);
  const t0 = tAt(e);
  let drag;
  const edge = e.target.dataset && e.target.dataset.edge;
  const tag = e.target.closest(".cliptag"), scene = e.target.closest(".scene");
  if (e.target.closest("#ruler")) drag = { kind: "seek" };
  else if (scene) drag = { kind: "scene", a: +scene.dataset.a, b: +scene.dataset.b };
  else if (tag) {
    const c = clips().find((x) => x.id === tag.dataset.c), p = c.parts[+tag.dataset.p];
    drag = edge ? { kind: "partEdge", c, p, edge, before: snap() } : { kind: "part", c, p, before: snap(), off: t0 - p.start, len: p.end - p.start };
  } else if (edge && e.target.closest("#markSel")) drag = { kind: "markEdge", edge };
  else if (e.target.closest("#laneV")) drag = { kind: "mark", from: snapT(t0) };
  else drag = { kind: "seek" };
  drag.moved = false;
  if (drag.kind === "seek") seek(t0);
  const tip = (text, ev) => { let t = $("tlTip"); if (!t) { t = el("div", { class: "tip", id: "tlTip" }); document.body.append(t); } t.hidden = false; t.textContent = text; t.style.left = (ev.clientX + 14) + "px"; t.style.top = (ev.clientY - 34) + "px"; };
  let last = e;
  const move = (ev) => {
    last = ev;
    const t = tAt(ev);
    if (!drag.moved && Math.abs(ev.clientX - e.clientX) < 3) return;
    drag.moved = true; dragging = true;
    if (drag.kind === "seek") seekSoft(t);
    else if (drag.kind === "mark") { const s = snapT(t); C.start = Math.min(drag.from, s); C.end = Math.max(drag.from, s); renderMarks(); tip("Marked " + fmtTime(C.end - C.start, 2), ev); seekSoft(t); }
    else if (drag.kind === "markEdge") {
      const s = snapT(t);
      if (drag.edge === "s") C.start = Math.max(0, Math.min(s, (C.end === null ? dur() : C.end) - 0.05)); else C.end = Math.min(dur(), Math.max(s, C.start + 0.05));
      renderMarks(); seekSoft(t); tip((drag.edge === "s" ? "Start " : "End ") + fmtTime(s, 2) + (selOk() ? " · " + fmtTime(C.end - C.start, 2) : ""), ev);
    } else if (drag.kind === "partEdge") {
      const p = drag.p, s = snapT(t);
      if (drag.edge === "s") p.start = r3(clamp(Math.min(s, p.end - MIN_PART), 0, dur())); else p.end = r3(clamp(Math.max(s, p.start + MIN_PART), 0, dur()));
      renderLane(); seekSoft(t); tip(drag.c.name + " · part " + (drag.c.parts.indexOf(p) + 1) + " · " + fmtTime(p.end - p.start, 2), ev);
    } else if (drag.kind === "part" && canEdit()) {
      // move the whole part: same length, it starts somewhere else in the movie (snaps its start or its end to a scene)
      const p = drag.p, L = drag.len;
      let a = clamp(t - drag.off, 0, Math.max(0, dur() - L));
      const sa = snapT(a), se = snapT(a + L) - L;
      if (sa !== a) a = sa; else if (Math.abs(se - a) > 1e-6) a = se;
      a = clamp(a, 0, Math.max(0, dur() - L));
      p.start = r3(a); p.end = r3(Math.min(dur(), a + L));
      $("tlScroll").classList.add("grabbing");
      renderLane(); seekSoft(p.start); tip(drag.c.name + " · starts at " + fmtTime(p.start, 2), ev);
    }
  };
  // while dragging near the left or right edge of the timeline, it scrolls by itself
  const auto = setInterval(() => {
    if (!drag.moved || drag.kind === "scene") return;
    const r = sc.getBoundingClientRect(), x = last.clientX;
    const d = x < r.left + 36 ? -(r.left + 36 - x) : x > r.right - 36 ? x - (r.right - 36) : 0;
    if (d) { sc.scrollLeft += Math.sign(d) * Math.min(40, 4 + Math.abs(d) / 3); move(last); renderRuler(); }
  }, 30);
  const up = (ev) => {
    clearInterval(auto); dragging = false;
    sc.removeEventListener("pointermove", move); sc.removeEventListener("pointerup", up); sc.removeEventListener("pointercancel", up);
    const t = $("tlTip"); if (t) t.hidden = true;
    if (drag.kind === "partEdge" && drag.moved) { pushUndo(drag.before); C.sel = drag.c.id; C.selPart = drag.c.parts.indexOf(drag.p); changed(); renderAll(); }
    $("tlScroll").classList.remove("grabbing");
    if (drag.kind === "part" && drag.moved && canEdit()) { pushUndo(drag.before); C.sel = drag.c.id; C.selPart = drag.c.parts.indexOf(drag.p); changed(); renderAll(); }
    if (drag.kind === "part" && !drag.moved) {
      if (ev.ctrlKey || ev.metaKey || ev.shiftKey) { pick(drag.c.id, ev); return; }
      C.multi.clear(); C.anchor = drag.c.id; C.sel = drag.c.id; C.selPart = drag.c.parts.indexOf(drag.p); renderAll(); seek(tAt(ev));
    }
    if (drag.kind === "mark" && !drag.moved) seek(tAt(ev));
    if (drag.kind === "scene" && !drag.moved) { C.start = drag.a; C.end = drag.b; renderMarks(); seek(drag.a); }
  };
  sc.addEventListener("pointermove", move); sc.addEventListener("pointerup", up); sc.addEventListener("pointercancel", up);
}

// ------------------------------------------------------------------ right-click menus
function markItems(t) {
  const ok = selOk(), c = selClip(), ed = !canEdit();
  return [
    ["Mark the start here", "inp", () => setStart(t), { key: "I" }],
    ["Mark the end here", "outp", () => setEnd(t), { key: "O" }],
    ok ? ["Play the marked part", "play", () => playRange(C.start, C.end)] : null,
    ok ? "-" : null,
    ok ? ["Add as new clip", "plus", addNewClip, { key: "Enter", off: ed }] : null,
    ok && c ? ["Add to " + c.name, "split", addPartTo, { key: "A", off: ed }] : null,
    ok && c ? ["Cut it out of " + c.name, "trash", cutOutMarked, { key: "X", off: ed }] : null,
    C.start !== null ? ["Clear the marks", "x", clearMarks, { key: "Esc" }] : null,
  ];
}
function timelineMenu(e) {
  if (!C.info) return;
  e.preventDefault();
  const sc = $("tlScroll"), r = sc.getBoundingClientRect(), t = clampT(timeAt(e.clientX - r.left + sc.scrollLeft));
  const tag = e.target.closest(".cliptag"), scene = e.target.closest(".scene"), marked = e.target.closest("#markSel");
  let items;
  if (tag) {
    const c = clips().find((x) => x.id === tag.dataset.c);
    items = c ? clipItems(c, t, +tag.dataset.p) : [];
  } else if (scene) {
    const a = +scene.dataset.a, b = +scene.dataset.b, c = selClip(), ed = !canEdit();
    items = [
      ["Play this scene", "play", () => playRange(a, b)],
      ["Mark this scene", "mark", () => { C.start = a; C.end = b; renderMarks(); seek(a); }],
      "-",
      ["Add it as a new clip", "plus", () => { C.start = a; C.end = b; addNewClip(); }, { off: ed }],
      c ? ["Add it to " + c.name, "split", () => { C.start = a; C.end = b; addPartTo(); }, { off: ed }] : null,
    ];
  } else if (marked) items = markItems(t);
  else {
    items = [["Move the playhead here", "target", () => seek(t)], "-", ...markItems(t), "-",
      ["Zoom in here", "zin", () => setZoom(C.pps * 2, t)], ["Show the whole movie", "fit", fitZoom]];
  }
  ctxMenu(items, e.clientX, e.clientY);
}
function pictureItems() {
  const t = video.currentTime || 0;
  return [[video.paused ? "Play" : "Pause", video.paused ? "play" : "pause", togglePlay, { key: "Space" }], "-", ...markItems(t), "-",
    ["Cut before the playhead", "cutb", () => cutSide("before"), { key: "Q", off: !canEdit() }],
    ["Cut after the playhead", "cuta", () => cutSide("after"), { key: "W", off: !canEdit() }],
    ["Split here", "scissors", splitAtPlayhead, { key: "S", off: !canEdit() }]];
}

// ------------------------------------------------------------------ the keys
const KEYS = [
  ["Space", "Play or pause"], ["I / O", "Mark the start / the end here"], ["Enter", "Add the marked part as a new clip"], ["A", "Add the marked part to the chosen clip"],
  ["P", "Play the chosen clip"], ["C", "Play the chosen part with 3 seconds around it"], ["Shift + P", "Play all clips"],
  ["S", "Split the chosen clip at the playhead"], ["Q", "Cut before: remove what comes before the playhead"], ["W", "Cut after: remove what comes after the playhead"], ["X", "Cut the marked part out of the chosen clip"], ["D", "Duplicate the chosen clip"],
  ["Delete", "Delete the chosen clip(s)"], ["Ctrl + click", "Choose more clips (Shift + click: all in between)"],
  ["Ctrl + A", "Choose all clips"], ["Ctrl + J", "Combine the chosen clips into one"], ["Esc", "Clear the marks"], ["Ctrl + Z", "Undo"], ["Ctrl + Y", "Redo"],
  ["Left / Right", "Back / forward 1 second"], [", and .", "Back / forward one picture"], ["Home / End", "Go to the start / the end"], ["+ and -", "Zoom the timeline"],
];
function showKeys() {
  dialogBox("Keys", [el("div", { class: "keys" }, ...KEYS.map(([k, t]) => el("div", { class: "krow" }, el("kbd", { text: k }), el("span", { text: t }))))], [["Close", null, "primary"]]);
}

// ------------------------------------------------------------------ wiring
function wire() {
  $("tPlay").addEventListener("click", togglePlay);
  $("frame").addEventListener("click", (e) => { if (!e.target.closest(".empty")) togglePlay(); });
  $("tBack").addEventListener("click", () => { video.pause(); seek(video.currentTime - frameLen()); });
  $("tFwd").addEventListener("click", () => { video.pause(); seek(video.currentTime + frameLen()); });
  $("tBack10").addEventListener("click", () => seek(video.currentTime - 10));
  $("tFwd10").addEventListener("click", () => seek(video.currentTime + 10));
  $("tMute").addEventListener("click", () => { const off = $("tMute").dataset.off === "1"; $("tMute").dataset.off = off ? "0" : "1"; $("tMute").replaceChildren(icon(off ? "vol" : "mute")); applyLive(); });
  $("playClip").addEventListener("click", playClip);
  $("playCtx").addEventListener("click", playContext);
  $("playAll").addEventListener("click", playAllClips);
  $("setStart").addEventListener("click", () => setStart(video.currentTime));
  $("setEnd").addEventListener("click", () => setEnd(video.currentTime));
  $("startIn").addEventListener("change", () => typed($("startIn"), "start"));
  $("endIn").addEventListener("change", () => typed($("endIn"), "end"));
  $("playSel").addEventListener("click", () => playRange(C.start, C.end));
  $("addNew").addEventListener("click", addNewClip);
  $("addPart").addEventListener("click", addPartTo);
  $("newClip").addEventListener("click", () => { C.sel = ""; C.start = C.end = null; C.tab = "parts"; renderAll(); say("Mark the first part of the new clip, then press Add as new clip."); });
  $("makeBtn").addEventListener("click", makeClips);
  $("freeBtn").addEventListener("click", freeMovie);
  $("sceneBtn").addEventListener("click", () => sceneStatus(true));
  $("csName").addEventListener("change", () => { const n = $("csName").value.trim(); if (n && C.cs) { C.cs.name = n; changed(); } });
  $("clipName").addEventListener("change", () => { const c = selClip(); if (!c) return; const n = $("clipName").value.trim().slice(0, 60); if (n && n !== c.name) commit(() => { c.name = n; }); else $("clipName").value = c.name; });
  $("bUndo").addEventListener("click", undo); $("bRedo").addEventListener("click", redo); $("bKeys").addEventListener("click", showKeys);
  // tools
  $("nSa").addEventListener("click", () => nudge("start", -1)); $("nSb").addEventListener("click", () => nudge("start", 1));
  $("nEa").addEventListener("click", () => nudge("end", -1)); $("nEb").addEventListener("click", () => nudge("end", 1));
  $("tSplit").addEventListener("click", splitAtPlayhead); $("tCutOut").addEventListener("click", cutOutMarked);
  $("tJoin").addEventListener("click", joinClip); $("tDup").addEventListener("click", duplicateClip);
  $("tCutB").addEventListener("click", () => cutSide("before")); $("tCutA").addEventListener("click", () => cutSide("after"));
  $("tlCutB").addEventListener("click", () => cutSide("before")); $("tlCutA").addEventListener("click", () => cutSide("after"));
  $("tlSplit").addEventListener("click", splitAtPlayhead);
  $("mCombine").addEventListener("click", combineChosen); $("mDelete").addEventListener("click", deleteChosen);
  $("mClear").addEventListener("click", () => { C.multi.clear(); renderAll(); });
  $("tlScroll").addEventListener("contextmenu", timelineMenu);
  $("frame").addEventListener("contextmenu", (e) => { if (!C.info) return; e.preventDefault(); ctxMenu(pictureItems(), e.clientX, e.clientY); });
  enhanceAll($("suite"));
  // After a click with the mouse, a button or slider must not keep the keyboard: the keys (Space, I, O ...) keep working
  document.addEventListener("click", (e) => { const b = e.target.closest && e.target.closest("button"); if (b && e.detail > 0 && !b.closest(".dialog")) setTimeout(() => b.blur(), 0); });
  document.addEventListener("pointerup", () => { const a = document.activeElement; if (a && a.tagName === "INPUT" && ["range", "checkbox"].includes(a.type)) setTimeout(() => a.blur(), 0); });
  video.addEventListener("seeked", renderHead);
  $("tlScroll").addEventListener("pointerdown", onTimelineDown);
  $("tlScroll").addEventListener("dblclick", (e) => {
    const tg = e.target.closest(".cliptag");
    if (tg && !e.target.dataset.edge) { const c = clips().find((x) => x.id === tg.dataset.c), p = c && c.parts[+tg.dataset.p]; if (p) playRange(p.start, p.end); return; }
    const s = e.target.closest(".scene"); if (!s || !canEdit()) return;
    C.start = +s.dataset.a; C.end = +s.dataset.b; if (selClip()) addPartTo(); else addNewClip();
  });
  let raf = 0; $("tlScroll").addEventListener("scroll", () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(renderLane); });
  $("tlScroll").addEventListener("wheel", (e) => {
    const sc = $("tlScroll");
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); const r = sc.getBoundingClientRect(); setZoom(C.pps * (e.deltaY < 0 ? 1.25 : 0.8), timeAt(e.clientX - r.left + sc.scrollLeft)); }
    else if (e.shiftKey || (Math.abs(e.deltaY) > Math.abs(e.deltaX) && sc.scrollHeight <= sc.clientHeight + 1)) { e.preventDefault(); sc.scrollLeft += e.deltaY || e.deltaX; }
  }, { passive: false });
  $("zoom").addEventListener("input", () => setZoom(0.02 * Math.pow(10000, parseFloat($("zoom").value) / 100)));
  $("bZoomIn").addEventListener("click", () => setZoom(C.pps * 1.6));
  $("bZoomOut").addEventListener("click", () => setZoom(C.pps / 1.6));
  $("bFit").addEventListener("click", fitZoom);
  $("tlResize").addEventListener("pointerdown", (e) => {
    const h0 = $("tl").offsetHeight, y0 = e.clientY; e.target.setPointerCapture(e.pointerId);
    const mv = (ev) => document.documentElement.style.setProperty("--tl", clamp(h0 - (ev.clientY - y0), 150, window.innerHeight * 0.6) + "px");
    const up = () => { e.target.removeEventListener("pointermove", mv); e.target.removeEventListener("pointerup", up); };
    e.target.addEventListener("pointermove", mv); e.target.addEventListener("pointerup", up);
  });
  new ResizeObserver(() => { if (C.info) { sizeFrame(); renderLane(); } }).observe($("stage"));
  document.addEventListener("keydown", (e) => {
    if (!C.info || document.querySelector(".dialog")) return;
    const tag = (e.target.tagName || "").toLowerCase();
    const typing = tag === "input" || tag === "textarea";
    const k = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey) {
      if (typing) return;
      if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); } else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); redo(); }
      else if (k === "a" && clips().length) { e.preventDefault(); C.multi = new Set(clips().map((c) => c.id)); if (!C.sel) C.sel = clips()[0].id; renderAll(); }
      else if (k === "j") { e.preventDefault(); combineChosen(); }
      return;
    }
    if (e.altKey || typing) return;
    if ((tag === "button" || tag === "a" || tag === "summary") && (k === " " || k === "enter")) return;   // those press the button
    if (k === " ") { e.preventDefault(); togglePlay(); }
    else if (k === "i") setStart(video.currentTime);
    else if (k === "o") setEnd(video.currentTime);
    else if (k === "enter") addNewClip();
    else if (k === "a") addPartTo();
    else if (k === "p") { if (e.shiftKey) playAllClips(); else playClip(); }
    else if (k === "c") playContext();
    else if (k === "s") splitAtPlayhead();
    else if (k === "q") cutSide("before");
    else if (k === "w") cutSide("after");
    else if (k === "x") cutOutMarked();
    else if (k === "d") duplicateClip();
    else if (k === "delete" || k === "backspace") { e.preventDefault(); if (chosen().length > 1) deleteChosen(); else { const c = selClip(); if (c) deleteClip(c, true); } }
    else if (k === "escape") { if (C.multi.size > 1) { C.multi.clear(); renderAll(); } else clearMarks(); }
    else if (k === "?") showKeys();
    else if (k === "home") { e.preventDefault(); seek(0); $("tlScroll").scrollLeft = 0; }
    else if (k === "end") { e.preventDefault(); seek(dur()); }
    else if (k === "arrowleft") { e.preventDefault(); seek(video.currentTime - 1); }
    else if (k === "arrowright") { e.preventDefault(); seek(video.currentTime + 1); }
    else if (k === ",") { video.pause(); seek(video.currentTime - frameLen()); }
    else if (k === ".") { video.pause(); seek(video.currentTime + frameLen()); }
    else if (k === "+" || k === "=") setZoom(C.pps * 1.6); else if (k === "-") setZoom(C.pps / 1.6);
  });
}

(async function init() {
  topBar("/clips");
  paintIcons(); wire();
  requestAnimationFrame(loop);
  const params = new URLSearchParams(location.search);
  const id = params.get("c"), open = params.get("open");
  if (id) await openClipset(id);
  else if (open) await newProject(open);           // "cut clips from this video" (from Exports)
  else { renderTabs(); await chooser(); }
  window.__clips = { C, video };                    // for the tests
})();
