"use strict";
// Home: the three phases of the work, each with its own projects.
//   1 Clips: take many clips out of a movie.   2 Edit: cut, patterns, sound, look.   3 Final: finished videos.
const PHASES = [
  ["clips", "Clips", "scissors", "Take clips out of a movie"],
  ["edit", "Edit", "layers", "Versions, sections and scenes"],
  ["final", "Final", "check", "Sound, picture and export"],
];
const H = { phase: "clips", clipsets: [], projects: [], final: [], library: [], trash: false, view: "grid", q: "", sub: "projects", lib: "all",
  pick: new Set(), anchor: "" };                // pick: cards chosen together (Ctrl / Shift + click)
try {
  if (localStorage.getItem("ef.home.sub") === "made") H.sub = "made";
  H.view = localStorage.getItem("ef.home.view") === "list" ? "list" : "grid";
  const ph = localStorage.getItem("ef.home.phase");
  if (PHASES.some((p) => p[0] === ph)) H.phase = ph;
} catch (e) { /* storage may be off */ }

// ------------------------------------------------------------------ loading
async function loadAll() {
  try {
    const [a, b, c, d] = await Promise.all([api("/api/clipsets"), api("/api/projects"), api("/api/final"), api("/api/clips/library")]);
    H.clipsets = a.clipsets; H.projects = b.projects; H.final = c.videos; H.library = d.clips;
  } catch (e) { toast(errText(e), true); return; }
  render();
}
const loadProjects = loadAll;                // older name, used by the actions below
const stageOf = (p) => (p.stage === "final" ? "final" : "edit");
const pageOf = (p) => "/" + stageOf(p) + "?p=" + p.id;
/** Edit: the edit projects. Final: the final projects, then the videos they made (their results). */
function itemsOf(phase) {
  return phase === "clips" ? H.clipsets : phase === "edit" ? H.projects.filter((p) => stageOf(p) === "edit")
    : H.projects.filter((p) => stageOf(p) === "final").concat(H.final);
}
const madeView = () => H.phase === "clips" && H.sub === "made";
function shownMade() {
  const q = H.q.toLowerCase();
  return H.library.filter((c) => (H.lib === "all" || (H.lib === "used" ? c.in_use : !c.in_use)) &&
    (!q || c.name.toLowerCase().includes(q) || c.movie.toLowerCase().includes(q) || c.used_by.some((u) => u.name.toLowerCase().includes(q))));
}
function shown() {
  if (madeView()) return shownMade();
  const q = H.q.toLowerCase();
  const list = itemsOf(H.phase);
  return list.filter((p) => (p.job ? !H.trash : !!p.trashed === H.trash) &&
    (!q || (p.name || "").toLowerCase().includes(q) || (p.source_name || p.project_name || "").toLowerCase().includes(q)));
}

// ------------------------------------------------------------------ drawing
function renderPhases() {
  const box = $("phases"); box.replaceChildren();
  PHASES.forEach(([key, name, ic, line], i) => {
    const n = itemsOf(key).filter((p) => !p.trashed).length;
    const b = el("button", { class: "phase" + (H.phase === key ? " on" : ""), type: "button", role: "tab", "aria-selected": String(H.phase === key),
      onclick: () => { H.phase = key; H.trash = false; try { localStorage.setItem("ef.home.phase", key); } catch (e) { /* off */ } render(); } },
      el("span", { class: "phase-n", text: String(i + 1) }), el("span", { class: "phase-ic" }, icon(ic)),
      el("span", { class: "t" }, el("b", { text: name }), el("small", { text: line })), el("span", { class: "count num", text: String(n) }));
    box.append(b);
  });
}
function renderSub() {
  const box = $("subTabs"), on = H.phase === "clips";
  box.hidden = !on; $("projTitle").hidden = on;
  if (!on) return;
  box.replaceChildren();
  const projects = H.clipsets.filter((p) => !p.trashed).length;
  for (const [k, label, n] of [["projects", "Clip projects", projects], ["made", "Made clips", H.library.length]]) {
    box.append(el("button", { class: "subtab" + (H.sub === k ? " on" : ""), type: "button", role: "tab", "aria-selected": String(H.sub === k),
      onclick: () => { H.sub = k; H.trash = false; try { localStorage.setItem("ef.home.sub", k); } catch (e) { /* off */ } render(); } },
      el("span", { text: label }), el("span", { class: "count num", text: String(n) })));
  }
}
function render() {
  const view = H.phase + H.sub + H.trash;
  if (H.pickView !== view) { H.pick.clear(); H.pickView = view; }
  $("pickBar").hidden = true;
  renderPhases();
  renderSub();
  const final = H.phase === "final", made = madeView();
  $("libFilter").hidden = !made;
  $("createRow").hidden = final || made;
  const hasTrash = true;
  $("createTitle").textContent = H.phase === "clips" ? "New clip project" : "New edit project";
  $("createLine").textContent = H.phase === "clips" ? "Choose a movie, then mark as many clips as you like. Nothing is copied."
    : "Choose a video to cut into pieces. It is used where it is, nothing is copied.";
  $("fromClip").hidden = H.phase !== "edit";
  const list = shown(), grid = $("grid"), all = itemsOf(H.phase), trashN = all.filter((p) => p.trashed && !p.job).length;
  $("projTitle").textContent = H.trash ? "Trash" : { clips: "Clip projects", edit: "Edit projects", final: "Finished videos" }[H.phase];
  $("projCount").textContent = list.length ? String(list.length) : "";
  $("trashBtn").hidden = !hasTrash || made;
  $("trashCount").textContent = String(trashN); $("trashCount").hidden = !trashN || H.trash;
  $("trashBtn").classList.toggle("on", H.trash);
  $("trashLabel").textContent = H.trash ? "Back to projects" : "Trash";
  $("emptyTrash").hidden = !(H.trash && trashN) || made;
  if (made) $("projCount").textContent = "";
  grid.className = "proj-grid" + (H.view === "list" ? " as-list" : "");
  grid.replaceChildren();
  if (made && !list.length) {
    grid.append(el("div", { class: "proj-empty" }, icon("film", "l"),
      el("b", { text: H.q ? "Nothing matches '" + H.q + "'." : H.library.length ? "No clips here." : "No made clips yet." }),
      el("span", { class: "hint", text: H.library.length ? "" : "Open a clip project and press Save & make clips. Made clips stay here, also after you delete their clip project." })));
    return;
  }
  if (made) { for (const c of list) grid.append(madeCard(c)); return; }
  if (!list.length) {
    const hint = H.trash || H.q ? "" : { clips: "Press New clip project and choose a movie.", edit: "Press New edit project, or open a made clip.",
      final: "Press 'Send to Final' in an Edit project. Videos you export from a Final project appear here too." }[H.phase];
    grid.append(el("div", { class: "proj-empty" }, icon(H.trash ? "trash" : final ? "check" : "film", "l"),
      el("b", { text: H.q ? "Nothing matches '" + H.q + "'." : H.trash ? "The trash is empty." : final ? "Nothing in Final yet." : "No projects yet." }),
      el("span", { class: "hint", text: hint })));
    return;
  }
  for (const p of list) grid.append(H.phase === "clips" ? clipCard(p) : p.job ? finalCard(p) : card(p));
  const ids = new Set(list.map((x) => x.id));
  for (const id of [...H.pick]) if (!ids.has(id)) H.pick.delete(id);
  paintPicks();
}
function thumbBox(missing, extraCls) { return el("div", { class: "pthumb" + (missing ? " missing" : "") + (extraCls ? " " + extraCls : "") }); }
function addImg(pic, url) {
  const img = el("img", { alt: "", loading: "lazy", decoding: "async", src: url, draggable: "false" });
  img.addEventListener("error", () => img.remove());
  pic.append(img);
}
function cardShell(p, pic, lines, open, title, items) {
  const list = items || (() => menuItems(p));
  const more = btn("", { icon: "more", cls: "ghost more", title: "More (or right-click the card)", onclick: (e) => { e.stopPropagation(); menuAt(more, list()); } });
  pic.append(more);
  const pickable = !p.job && !madeView();
  const node = el("div", { class: "pcard" + (p.missing && !p.freed ? " is-missing" : "") + (H.pick.has(p.id) ? " picked" : ""), tabindex: "0", role: "button",
    title: (title || "") + (pickable ? "\nCtrl + click: choose more than one" : ""), "aria-label": p.name, "data-id": p.id || "" },
    pic, el("div", { class: "pinfo" }, el("b", { class: "ellip", text: p.name }), ...lines));
  if (pickable) pic.append(el("span", { class: "pick-box", "aria-hidden": "true" }, icon("check", "s")));
  node.addEventListener("click", (e) => {
    if (pickable && (e.ctrlKey || e.metaKey || e.shiftKey || (H.pick.size && e.target.closest(".pick-box")))) { e.preventDefault(); pickCard(p, e); return; }
    if (pickable && e.target.closest(".pick-box")) { pickCard(p, { ctrlKey: true }); return; }
    open();
  });
  node.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) { e.preventDefault(); menuAt(more, list()); } });
  onRightClick(node, list);
  return node;
}
// ------------------------------------------------------------------ choosing several cards (Ctrl / Shift + click)
function pickCard(p, e) {
  if (e.shiftKey && H.anchor) {
    const ids = shown().map((x) => x.id), a = ids.indexOf(H.anchor), b = ids.indexOf(p.id);
    if (a >= 0 && b >= 0) { for (let k = Math.min(a, b); k <= Math.max(a, b); k++) H.pick.add(ids[k]); paintPicks(); return; }
  }
  if (H.pick.has(p.id)) H.pick.delete(p.id); else H.pick.add(p.id);
  H.anchor = p.id; paintPicks();
}
function picked() { return shown().filter((x) => H.pick.has(x.id)); }
function paintPicks() {
  for (const n of document.querySelectorAll("#grid .pcard")) n.classList.toggle("picked", H.pick.has(n.dataset.id));
  const bar = $("pickBar"), list = picked();
  bar.hidden = !list.length;
  if (!list.length) return;
  bar.replaceChildren(el("b", { class: "num", text: list.length + " chosen" }));
  const edit = H.phase === "edit" && !H.trash;
  if (edit) bar.append(btn("Separate scenes", { icon: "layers", cls: "primary", title: "Find and separate the scenes of every chosen project. They wait in line and go on while you work.", onclick: () => scenesFor(list) }));
  if (H.trash) bar.append(btn("Restore", { icon: "restore", onclick: () => manyDo(list, "restore") }));
  else bar.append(btn("Move to trash", { icon: "trash", onclick: () => manyDo(list, "trash") }));
  bar.append(btn("Clear", { icon: "x", cls: "ghost", title: "Esc", onclick: () => { H.pick.clear(); paintPicks(); } }));
}
async function manyDo(list, what) {
  const base = H.phase === "clips" ? "/api/clipsets/" : "/api/projects/";
  for (const p of list) await api(base + p.id + "/" + what, { method: "POST", json: {} }).catch((e) => toast(errText(e), true));
  toast((what === "trash" ? "Moved " : "Brought back ") + list.length + " project" + (list.length > 1 ? "s" : "") + (what === "trash" ? " to the trash." : "."));
  H.pick.clear(); loadAll();
}
/** Separate scenes in one or more Edit projects. The app does them one after another; you can open other projects meanwhile. */
async function scenesFor(list) {
  let ok = 0;
  for (const p of list) {
    try { await api("/api/projects/" + p.id + "/scenes", { method: "POST", json: {} }); ok++; } catch (e) { toast(p.name + ": " + errText(e), true); }
  }
  if (ok) toast(ok === 1 ? "Separating the scenes of '" + list[0].name + "'. See Activity (top right) for how far it is." : "Separating the scenes of " + ok + " projects, one after another. See Activity (top right).");
  H.pick.clear(); await loadAll(); Activity.refresh();
}
/** A project's background work, on its card: a bar while it runs, a tag when it is done. */
function taskBadge(t) {
  if (!t || t.state === "none") return null;
  const box = el("div", { class: "ptask " + t.state });
  const pct = Math.round((t.progress || 0) * 100);
  const text = t.state === "running" ? "Separating scenes " + pct + "%" : t.state === "queued" ? "Waiting to separate scenes" + (t.place ? " · " + t.place + " in line" : "")
    : t.state === "done" ? (t.seen ? "" : t.scenes + " scenes separated") : "Scenes failed";
  if (!text) return null;
  box.append(el("span", { text }));
  if (t.state === "running" || t.state === "queued") { const bar = el("div", { class: "prog" + (t.state === "queued" ? " wait" : "") }, el("i")); bar.firstChild.style.width = (t.state === "queued" ? 0 : pct) + "%"; box.append(bar); }
  return box;
}
/** The Activity list changed: move the bars on the cards, and load again when one finished. */
let lastTaskSig = "";
document.addEventListener("activity", (e) => {
  const items = e.detail.items.filter((i) => i.kind === "scenes" && i.project);
  const sig = items.map((i) => i.project + i.state).join();
  if (lastTaskSig && sig !== lastTaskSig) { lastTaskSig = sig; loadAll(); return; }
  lastTaskSig = sig;
  for (const i of items) {
    const p = H.projects.find((x) => x.id === i.project);
    if (!p || !p.task || (i.state !== "running" && i.state !== "queued")) continue;
    p.task.progress = i.progress; p.task.state = i.state;
    const node = document.querySelector('#grid .pcard[data-id="' + i.project + '"] .ptask');
    if (node) node.replaceWith(taskBadge(p.task));
  }
});

/** Stage 1 result: one made clip. It stays here when its clip project is deleted. */
function madeCard(c) {
  const pic = thumbBox(false);
  addImg(pic, thumbUrl(c.file, Math.min(0.5, (c.length || 1) / 2), true));
  pic.append(el("span", { class: "chip-tag", text: fmtTime(c.length, 0) }));
  pic.append(el("span", { class: "chip-tag top" + (c.in_use ? " good" : " plain"), text: c.in_use ? "In use" : "Not used" }));
  const uses = c.used_by.filter((u) => !u.trashed);
  const where = uses.length ? "Used in " + uses.map((u) => u.name).join(", ") : "Not used in Edit or Final";
  const from = c.clipset && !c.clipset_trashed ? "From " + (c.clipset_name || c.movie) : "From " + (c.movie || "a movie") + " · project deleted";
  return cardShell(c, pic, [el("small", { class: "num ellip", text: fmtShort(c.size) + " | " + (uses.length ? uses.length === 1 ? uses[0].name : uses.length + " projects" : from) }),
    H.view === "list" ? el("small", { class: "num when", text: from + " · " + where }) : null], () => watchClip(c), c.name + "\n" + from + "\n" + where, () => madeItems(c));
}
function watchClip(c) { watch({ id: c.file, name: c.name }); }
function madeItems(c) {
  const uses = c.used_by;
  const blocked = uses.length ? "It is used by " + uses.map((u) => "'" + u.name + "'" + (u.trashed ? " (in the trash)" : "")).join(", ") + ". Delete that project first." : "";
  return [
    ["Watch", "play", () => watchClip(c)],
    ["New edit project from it", "layers", () => openInEditor(c.file, 2)],
    ...uses.filter((u) => !u.trashed).slice(0, 4).map((u) => ["Open '" + u.name + "'", u.stage === "final" ? "check" : "layers", () => { location.href = "/" + u.stage + "?p=" + u.id; }]),
    c.clipset && !c.clipset_trashed ? ["Open its clip project", "scissors", () => { location.href = "/clips?c=" + c.clipset; }] : null,
    ["Save a copy", "download", () => { location.href = "/download/" + c.job + "?t=" + encodeURIComponent(TOKEN); }],
    "-",
    ["Remove this clip", "trash", async () => {
      if (!(await askYes("Remove the made clip '" + c.name + "'? Its file is deleted from the app (copies you saved are kept).", "Remove", true))) return;
      try { await api("/api/jobs/" + c.job, { method: "DELETE" }); toast("Removed '" + c.name + "'."); } catch (e) { toast(errText(e), true); }
      loadAll();
    }, { danger: true, off: !!uses.length, why: blocked }],
  ];
}

/** Phase 1 card: a movie and its clips. */
function clipCard(p) {
  const pic = thumbBox(p.missing && !p.freed && !p.thumb_file);
  if (p.missing && !p.freed && !p.thumb_file) {
    pic.append(el("span", { class: "miss-t", text: "Movie not found" }));
  } else if (p.thumb_file) addImg(pic, thumbUrl(p.thumb_file, 0.5, true));
  else if (p.has_video) addImg(pic, thumbUrl(p.source, p.thumb_at, true));
  else pic.append(icon("music", "l"));
  pic.append(el("span", { class: "chip-tag" + (p.made && p.made === p.clips ? " good" : ""), text: p.clips ? p.made + " / " + p.clips + " made" : "No clips yet" }));
  if (p.freed) pic.append(el("span", { class: "chip-tag top", text: "Movie freed" }));
  const meta = p.clips + " clip" + (p.clips === 1 ? "" : "s") + " | " + fmtTime(p.length, 0);
  const open = () => { if (!H.trash) location.href = "/clips?c=" + p.id; };
  const f = p.done || {};
  const ticks = stageOf(p) === "edit" ? el("span", { class: "vsteps", title: "Edit steps done on this version" },
    ...[[1, f.versions || f.made_versions, "Odd / Even versions"], [2, f.thin, "Remove every 4th second"], [3, f.scenes, "Separate scenes"]]
      .map(([n, on, what]) => el("i", { class: on ? "done" : "", title: what + (on ? ": done" : ": not yet"), text: String(n) }))) : null;
  return cardShell(p, pic, [el("small", { class: "num", text: meta }), ticks,
    H.view === "list" ? el("small", { class: "num when", text: "From " + p.source_name + " · opened " + ago(p.opened) }) : null], open, "From " + p.source_name);
}
/** Phase 2 card: an edit project. */
function card(p) {
  const meta = fmtShort(p.size) + " | " + fmtTime(p.duration, 0);
  const pic = thumbBox(p.missing);
  if (p.missing) {
    pic.append(el("span", { class: "miss-t", text: "Video not found" }),
      p.trashed ? null : btn("Find it again", { icon: "link", cls: "sm", onclick: (e) => { e.stopPropagation(); relink(p); } }));
  } else if (p.has_video) addImg(pic, thumbUrl(p.source, p.thumb_at, true));
  else pic.append(icon("music", "l"));
  if (p.version) pic.append(el("span", { class: "chip-tag top", text: p.version.charAt(0).toUpperCase() + p.version.slice(1) }));
  if (p.steps) pic.append(el("span", { class: "chip-tag", text: (p.steps + 1) + " steps" }));
  const tb = taskBadge(p.task);
  if (tb) pic.append(tb);
  const edited = "Edited: " + fmtTime(p.length, 0) + " · " + p.pieces + " pieces" + (p.where ? "\n" + (p.linked ? "Used where it is: " : "Copy: ") + p.where : "");
  const open = () => { if (H.trash) return; if (p.missing) relink(p); else location.href = pageOf(p); };
  const f = p.done || {};
  const ticks = stageOf(p) === "edit" ? el("span", { class: "vsteps", title: "Edit steps done on this version" },
    ...[[1, f.versions || f.made_versions, "Odd / Even versions"], [2, f.thin, "Remove every 4th second"], [3, f.scenes, "Separate scenes"]]
      .map(([n, on, what]) => el("i", { class: on ? "done" : "", title: what + (on ? ": done" : ": not yet"), text: String(n) }))) : null;
  return cardShell(p, pic, [el("small", { class: "num", text: meta }), ticks,
    H.view === "list" ? el("small", { class: "num when", text: "Edited " + fmtTime(p.length, 0) + " · opened " + ago(p.opened) }) : null], open, edited);
}
/** Phase 3 card: a finished video. */
function finalCard(v) {
  const pic = thumbBox(false);
  addImg(pic, thumbUrl(v.id, Math.min(1, (v.duration || 2) / 2), true));
  pic.append(el("span", { class: "chip-tag", text: fmtTime(v.duration, 0) }));
  if (v.loudness) pic.append(el("span", { class: "chip-tag top" + (v.loudness.ok ? " good" : ""), text: v.loudness.lufs.toFixed(1) + " LUFS" }));
  const open = () => watch(v);
  return cardShell(v, pic, [el("small", { class: "num", text: fmtShort(v.size) + " | " + (v.project_name ? "from " + v.project_name : "made " + ago(v.when)) })], open, v.name);
}
function watch(v) {
  const box = el("div", { class: "watch" }, miniPlayer(mediaUrl(v.id, false), { meter: !!v.loudness, loudness: v.loudness }));
  dialogBox(v.name, [box], [["Close", null, "ghost"]], (done, dlg) => dlg.classList.add("wide"));
}
function ago(t) {
  const s = Date.now() / 1000 - t;
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  if (s < 86400 * 30) return Math.round(s / 86400) + " days ago";
  return new Date(t * 1000).toLocaleDateString();
}

// ------------------------------------------------------------------ the card menu
function menuItems(p) {
  if (p.job) {
    return [["Watch", "play", () => watch(p)],
      ["Save a copy", "download", () => { location.href = "/download/" + p.job + "?t=" + encodeURIComponent(TOKEN); }],
      p.project_id ? ["Open its project", "layers", () => { location.href = "/final?p=" + p.project_id; }] : null,
      ["Edit it again", "edit", () => openInEditor(p.id)],
      ["Remove", "trash", async () => {
        if (!(await askYes("Remove '" + p.name + "'? The file is deleted from the app (copies you saved are kept).", "Remove", true))) return;
        await api("/api/jobs/" + p.job, { method: "DELETE" }).catch((e) => toast(errText(e), true)); loadAll();
      }]].filter(Boolean);
  }
  const base = H.phase === "clips" ? "/api/clipsets/" : "/api/projects/";
  if (H.trash) return [["Restore", "restore", () => act(base, p, "restore")], ["Delete forever", "trash", () => forget(base, p)]];
  if (H.phase === "clips") {
    return [["Open", "scissors", () => { location.href = "/clips?c=" + p.id; }], ["Rename", "edit", () => rename(base, p)],
      ["Move to trash", "trash", () => act(base, p, "trash")]];
  }
  const group = picked();
  if (group.length > 1 && H.pick.has(p.id)) {
    return [stageOf(p) === "edit" ? ["Separate scenes in " + group.length + " projects", "layers", () => scenesFor(group)] : null,
      ["Move " + group.length + " to the trash", "trash", () => manyDo(group, "trash")], "-",
      ["Clear the choice", "x", () => { H.pick.clear(); paintPicks(); }, { key: "Esc" }]];
  }
  const busy = p.task && (p.task.state === "running" || p.task.state === "queued");
  return [["Open", "layers", () => { if (p.missing) relink(p); else location.href = pageOf(p); }],
    stageOf(p) === "edit" && !p.missing ? (busy ? ["Stop separating scenes", "x", async () => { await api("/api/projects/" + p.id + "/scenes-stop", { method: "POST", json: {} }); loadAll(); Activity.refresh(); }]
      : ["Separate scenes", "layers", () => scenesFor([p])]) : null,
    ["Choose more (Ctrl + click)", "check", () => { H.pick.add(p.id); H.anchor = p.id; paintPicks(); }],
    "-", ["Rename", "edit", () => rename(base, p)],
    ["Duplicate", "copy", () => act(base, p, "duplicate")], ["Move to trash", "trash", () => act(base, p, "trash")]];
}
async function act(base, p, what) {
  try {
    await api(base + p.id + "/" + what, { method: "POST", json: {} });
    if (what === "trash") toast("Moved '" + p.name + "' to the trash. Open Trash to bring it back." + (base.includes("clipsets") && p.made ? " Its made clips stay in Made clips." : ""));
    await loadAll();
  } catch (e) { toast(errText(e), true); }
}
async function rename(base, p) {
  const name = await askText("Rename project", p.name);
  if (!name || name === p.name) return;
  try { await api(base + p.id + "/rename", { method: "POST", json: { name } }); await loadAll(); } catch (e) { toast(errText(e), true); }
}
async function forget(base, p) {
  const extra = H.phase === "clips" ? (p.made ? " Its " + p.made + " made clip" + (p.made === 1 ? "" : "s") + " stay in Made clips, and Edit projects that use them keep working." : "") : " Exported videos are kept.";
  if (!(await askYes("Delete '" + p.name + "' for good? Your video file itself is not touched. The app's own copies of it " +
    "(light copy, pictures) are deleted too, to free space." + extra, "Delete", true))) return;
  try { const r = await api(base + p.id, { method: "DELETE" }); toast("Deleted '" + p.name + "'." + freedText(r.freed)); } catch (e) { toast(errText(e), true); }
  loadAll();
}
function freedText(b) { return b > 1e6 ? " Freed " + (b >= 1e9 ? (b / 1e9).toFixed(1) + " GB" : Math.round(b / 1e6) + " MB") + "." : ""; }
/** "Find it again": choose the moved video; the project keeps all its pieces and steps. */
async function relink(p) {
  try {
    let r = await api("/api/projects/" + p.id + "/relink", { method: "POST", json: {} });
    if (r.cancelled) return;
    if (r.no_dialog) {
      const d = await chooseFile("video"); if (!d) return;
      r = await api("/api/projects/" + p.id + "/relink", { method: "POST", json: { file: d.id } });
    }
    if (r.note) toast(r.note, true); else toast("Found. '" + p.name + "' uses " + (r.project.src.path || r.project.src.name) + " now.");
    await loadAll();
  } catch (e) { toast(errText(e), true); }
}

// ------------------------------------------------------------------ create
async function createProject(dropped) {
  const bar = $("createProg");
  const prog = (k) => { bar.hidden = false; bar.firstChild.style.width = Math.round(k * 100) + "%"; };
  try {
    const d = dropped ? await uploadFile(dropped, prog) : await chooseFile("video", prog);
    if (!d) return;
    if (!d.has_video && !d.has_audio) { toast("That file has no picture or sound to edit.", true); return; }
    if (H.phase === "clips") {
      const r = await api("/api/clipsets", { method: "POST", json: { source: d.id } });
      location.href = "/clips?c=" + r.clipset.id;
    } else await openInEditor(d.id, 2);
  } catch (e) { toast(errText(e), true); }
  finally { bar.hidden = true; }
}
/** Edit a clip made in phase 1. */
async function fromClip() {
  let clips;
  try { clips = (await api("/api/clips/made")).clips; } catch (e) { toast(errText(e), true); return; }
  const list = el("div", { class: "list pick-list" });
  if (!clips.length) list.append(el("p", { class: "hint", text: "No made clips yet. Open a clip project and press Make clips." }));
  for (const c of clips) {
    list.append(el("div", { class: "item", onclick: () => list.dispatchEvent(new CustomEvent("pick", { detail: c.file })) },
      el("img", { class: "thumb", alt: "", src: thumbUrl(c.file, 0.5), loading: "lazy" }),
      el("div", { class: "t" }, el("b", { text: c.name }), el("small", { class: "num", text: fmtTime(c.length, 1) + " · " + (c.clipset_name || c.movie) + (c.in_use ? " · in use" : "") }))));
  }
  const file = await dialogBox("Edit a made clip", [list], [["Cancel", null, "ghost"]], (done) => list.addEventListener("pick", (e) => done(e.detail)));
  if (file) openInEditor(file, 2);
}

// ------------------------------------------------------------------ storage
async function storagePanel() {
  if ($("storageDrawer")) return;
  const close = () => { scrim.remove(); drawer.remove(); };
  const scrim = el("div", { class: "scrim", onclick: close });
  const body = el("div", { class: "body" });
  const drawer = el("aside", { class: "drawer", id: "storageDrawer", "aria-label": "Storage" },
    el("div", { class: "side-h" }, el("h2", { text: "Storage" }), btn("", { icon: "x", cls: "ghost", title: "Close", onclick: close })), body);
  document.body.append(scrim, drawer);
  const fill = (st) => {
    body.replaceChildren();
    const z = st.sizes;
    body.append(el("div", { class: "box" },
      el("div", { class: "stat" }, el("span", { class: "lbl", text: "Used by the app" }), el("b", { class: "num", text: fmtSize(st.total) })),
      el("div", { class: "stat" }, el("span", { class: "lbl", text: "Free on this disk" }), el("span", { class: "num", text: fmtSize(st.free) }))),
      el("p", { class: "hint", text: st.linked + " video" + (st.linked === 1 ? " is" : "s are") + " used where " + (st.linked === 1 ? "it is" : "they are") + " (linked, no copy)." }));
    const row = (title, hint, bytes, what, sure) => body.append(el("div", { class: "store-row" },
      el("div", { class: "t" }, el("b", { text: title }), el("small", { text: hint })), el("span", { class: "num", text: fmtSize(bytes) }),
      what ? btn("Free up", { cls: "sm", onclick: async () => {
        if (sure && !(await askYes(sure, "Free up", true))) return;
        try { const r = await api("/api/storage/clean", { method: "POST", json: { what } }); toast("Freed. " + r.removed + " removed."); fill(r.storage); }
        catch (e) { toast(errText(e), true); }
      } }) : btn("Open", { cls: "sm", onclick: () => { close(); Exports.show(); } })));
    row("Light copies", "Small copies for smooth playing. Made again when needed.", z.previews, "previews");
    row("Pictures", "Small pictures for timelines and cards. Made again when needed.", z.thumbs, "thumbs");
    row("Sent-in copies", "Videos added by dragging, that no project uses (" + fmtSize(st.loose_uploads) + "). All copies: " + fmtSize(z.uploads) + ".", st.loose_uploads, "uploads",
      "Delete the copies of videos you added by dragging, that no project uses? Your own files are not touched.");
    row("Sound layers", "Voices, music and effects split from videos. Made again when needed.", z.stems || 0, "stems");
    row("Work folders", "Left over from making videos.", z.work, "work");
    row("Exports", "Your made clips and finished videos. Remove them one by one in Exports.", z.exports, "");
    body.append(el("p", { class: "hint", text: "Tip: after all clips of a movie are made, open the clip project and press Free up the movie. Everything is in " + st.home }));
  };
  try { fill(await api("/api/storage")); } catch (e) { body.append(el("p", { class: "hint", text: errText(e) })); }
}

// ------------------------------------------------------------------ start
(function init() {
  const nav = $("homeNav");
  for (const [href, name, ic] of PAGES) {
    nav.append(el("a", { href, class: "home-link" + (href === "/" ? " on" : "") }, icon(ic), el("span", { text: name })));
    if (href === "/clips") nav.append(el("a", { href: "/?phase=made", class: "home-link sub", title: "Every clip you made, also after its clip project is deleted",
      onclick: (e) => { e.preventDefault(); H.phase = "clips"; H.sub = "made"; H.trash = false; try { localStorage.setItem("ef.home.phase", "clips"); localStorage.setItem("ef.home.sub", "made"); } catch (er) { /* off */ } render(); } },
      icon("film"), el("span", { text: "Made clips" })));
  }
  $("homeTop").append(el("span", { class: "grow" }), Update.pill(), activityButton(), exportsButton());
  Exports.start(); Activity.start();
  Exports.onFiles = () => loadAll();
  paintIcons();
  document.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || document.querySelector(".dialog")) return;
    if (e.key === "Escape" && H.pick.size) { H.pick.clear(); paintPicks(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && !madeView()) {
      e.preventDefault(); for (const x of shown()) if (!x.job) H.pick.add(x.id); paintPicks();
    }
  });
  const create = $("create");
  create.addEventListener("click", () => createProject());
  create.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); createProject(); } });
  dropTarget(create, (f) => createProject(f));
  $("fromClip").addEventListener("click", fromClip);
  $("search").addEventListener("input", () => { H.q = $("search").value.trim(); render(); });
  $("viewToggle").append(segmented([["grid", "Grid"], ["list", "List"]], H.view, (v) => { H.view = v; try { localStorage.setItem("ef.home.view", v); } catch (e) { /* off */ } render(); }));
  $("trashBtn").addEventListener("click", () => { H.trash = !H.trash; render(); });
  $("libFilter").append(segmented([["all", "All"], ["used", "In use"], ["free", "Not used"]], H.lib, (v) => { H.lib = v; render(); }));
  $("emptyTrash").addEventListener("click", async () => {
    if (!(await askYes("Delete everything in this trash for good? Video files themselves are not touched.", "Empty trash", true))) return;
    let freed = 0;
    if (H.phase === "clips") {
      for (const p of H.clipsets.filter((x) => x.trashed)) freed += await api("/api/clipsets/" + p.id, { method: "DELETE" }).then((r) => r.freed || 0).catch(() => 0);
    } else freed = await api("/api/trash/empty", { method: "POST", json: {} }).then((r) => r.freed || 0).catch((e) => { toast(errText(e), true); return 0; });
    toast("The trash is empty." + freedText(freed));
    loadAll();
  });
  $("storageBtn").addEventListener("click", storagePanel);
  const params = new URLSearchParams(location.search);
  const msg = params.get("msg"), ph = params.get("phase");
  if (ph === "made") { H.phase = "clips"; H.sub = "made"; } else if (PHASES.some((p) => p[0] === ph)) H.phase = ph;
  if (msg) toast(msg, true);
  if (msg || ph) history.replaceState(null, "", "/");
  render();
  loadAll();
})();
