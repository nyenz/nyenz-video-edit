"use strict";
// The three sound layers of a video (voices, music, effects): the Split button, the three sliders, and the live sound
// while you play. Used by the Editor (editor.js calls Layers.init / open / play / pause / follow / apply).
const Layers = (() => {
  const BASE = ["voices", "music", "effects"];
  const NAMES = BASE.slice();                      // + "found" once Separate again pulled something out of chosen parts
  const TITLE = { voices: "Voices", music: "Music", effects: "Effects", found: "Found again", found_voices: "Voices found again", found_music: "Music found again", found_effects: "Effects found again" };
  const WHAT = { voices: "People talking", music: "Songs and score", effects: "Gunshots, fights, cars, steps", found: "What Separate again pulled out", found_voices: "Voices hiding in other parts", found_music: "Music hiding in other parts", found_effects: "Effects hiding in other parts" };
  const ICON = { voices: "face", music: "music", effects: "sparkles", found: "search", found_voices: "face", found_music: "music", found_effects: "sparkles" };
  /** The tracks of the attached split: the three, plus 'found' when it has one. */
  function setNames(sp) {
    const want = BASE.concat(["found", "found_voices", "found_music", "found_effects"].filter((k) => sp && (sp.layers || []).includes(k)));
    if (want.join() === NAMES.join()) return false;
    NAMES.splice(0, NAMES.length, ...want);
    const from = (sp && sp.found_from) || [];
    TITLE.found = "Found again" + (from.length ? " (from " + from.map((n) => TITLE[n]).join(" + ") + ")" : "");
    return true;
  }
  const PAD = 3;                                   // seconds of margin around the part you use, so cuts can still grow a little
  const PRESETS = [["Everything", [1, 1, 1]], ["Voices only", [1, 0, 0]], ["No voices", [0, 1, 1]], ["No music", [1, 0, 1]], ["Effects only", [0, 0, 1]]];
  const L = { info: null, poll: null, ctx: null, els: null, gains: null, loaded: "", last: 0, rows: {}, busy: false };

  const st = () => S.proj.settings;
  const gainOf = (n) => { const v = st()["mix_" + n]; return v === undefined ? 1 : +v; };
  /** A piece's own loudness of a layer (1 = as the slider says; 0 = muted). */
  const ownGain = (p, n) => { const m = p && p.mix && p.mix[n]; return m ? (m.mute ? 0 : +m.volume) : 1; };
  const changed = () => NAMES.some((n) => Math.abs(gainOf(n) - 1) > 0.001) || (S.proj && S.proj.pieces.some((p) => !p.off && p.mix && Object.keys(p.mix).length)) ||
    (S.proj && Object.keys(st().ducks || {}).length > 0);

  /** The part of the video to split: what the pieces use (plus a little margin), or everything. */
  function range() {
    const d = S.info.duration;
    if ($("lyPart").value === "all") return [0, d];
    const ps = S.proj.pieces.filter((p) => !p.off);
    if (!ps.length) return [0, d];
    return [Math.max(0, Math.min(...ps.map((p) => p.start)) - PAD), Math.min(d, Math.max(...ps.map((p) => p.end)) + PAD)];
  }
  function used() {
    const ps = S.proj.pieces.filter((p) => !p.off);
    return ps.length ? [Math.min(...ps.map((p) => p.start)), Math.max(...ps.map((p) => p.end))] : [0, 0];
  }
  const pct = (g) => Math.round(g * 100) + "%";
  function span(s) {
    if (s < 50) return "under a minute";
    const m = Math.round(s / 60);
    return m < 90 ? "about " + m + " min" : "about " + (m / 60).toFixed(1) + " hours";
  }

  // ---------------------------------------------------------------- the panel
  function build() {
    const box = $("lyRows"); box.replaceChildren();
    for (const n of NAMES) {
      const slider = el("input", { type: "range", class: "rng", min: "0", max: "200", step: "1", "aria-label": TITLE[n] + " loudness" });
      const val = el("b", { class: "num ly-val", text: "100%" });
      const mute = el("button", { class: "ly-mute", type: "button", title: "Turn " + TITLE[n].toLowerCase() + " off or on", "aria-label": "Mute " + TITLE[n].toLowerCase() }, icon("vol", "s"));
      const row = el("div", { class: "ly-row", "data-layer": n },
        el("span", { class: "ly-ic" }, icon(ICON[n])),
        el("div", { class: "ly-main" },
          el("div", { class: "ly-top" }, el("b", { text: TITLE[n] }), el("span", { class: "note", text: WHAT[n] })),
          el("div", { class: "ly-ctl" }, slider, val)),
        mute);
      slider.addEventListener("input", () => { val.textContent = pct(slider.value / 100); paintRange(slider); setGain(n, slider.value / 100); paintMute(n); });
      slider.addEventListener("change", () => commit(n, slider.value / 100));
      mute.addEventListener("click", () => {
        const now = gainOf(n);
        if (now > 0) { mute.dataset.was = String(now); commit(n, 0); } else commit(n, +mute.dataset.was > 0 ? +mute.dataset.was : 1);
      });
      L.rows[n] = { row, slider, val, mute };
      box.append(row);
    }
    const chips = $("lyPresets"); chips.replaceChildren();
    for (const [label, g] of PRESETS) {
      const c = el("button", { class: "chip", type: "button", text: label, onclick: () => { change(() => { BASE.forEach((n, i) => { st()["mix_" + n] = g[i]; }); }, { keepVideo: true }); paint(); apply(); } });
      chips.append(c);
    }
  }
  function commit(n, v) {
    change(() => { st()["mix_" + n] = Math.round(v * 100) / 100; }, { keepVideo: true });
    paint(); apply();
  }
  function paintMute(n) {
    const r = L.rows[n], g = r ? +r.slider.value / 100 : gainOf(n);
    if (!r) return;
    r.mute.classList.toggle("on", g === 0);
    r.mute.replaceChildren(icon(g === 0 ? "mute" : "vol", "s"));
    r.row.classList.toggle("off", g === 0);
  }
  /** An honest report of how clean the split is: how the sound is shared, how well the layers add back, and what an AI split cannot promise. */
  function paintQuality(info) {
    const box = $("lyQuality"); box.replaceChildren();
    if (!info) return;
    const q = info.split && info.split.quality;
    box.append(el("b", { text: "How clean is this split?" }));
    if (q) {
      const rate = q.rebuild_db >= 20 ? ["good", "The three layers add back to the original very closely."]
        : q.rebuild_db >= 12 ? ["ok", "The layers add back to the original, with small differences."]
          : ["warn", "The layers do not add back cleanly. Listen to each one before you use it."];
      box.append(el("div", { class: "ly-share" }, ...BASE.map((n) => el("span", { class: "ly-chip" }, el("i", { class: "ly-" + n }), el("small", { text: TITLE[n] + " " + Math.round(q.share[n]) + "%" })))));
      box.append(el("p", { class: "note " + rate[0], text: rate[1] + " (" + q.rebuild_db.toFixed(0) + " dB)" }));
      const tiny = BASE.filter((n) => q.share[n] < 3);
      if (tiny.length) box.append(el("p", { class: "note", text: tiny.map((n) => TITLE[n]).join(" and ") + (tiny.length > 1 ? " hold" : " holds") + " almost nothing: there probably was none in this part." }));
    } else box.append(el("p", { class: "note", text: "This split was made before the check existed. Press Split again to get the report." }));
    box.append(el("p", { class: "note", text: info.quality_note || "" }));
  }
  function paint() {
    if (!S.proj) return;
    const ready = !!(L.info && L.info.split);
    const running = L.info && L.info.job && ["downloading", "running"].includes(L.info.job.state);
    $("lySplit").hidden = ready || running;
    $("lyProg").hidden = !running;
    $("lyMix").hidden = !ready;
    for (const n of NAMES) {
      const r = L.rows[n]; if (!r) continue;
      r.slider.value = String(Math.round(gainOf(n) * 100)); r.val.textContent = pct(gainOf(n)); paintRange(r.slider); paintMute(n);
    }
    paintQuality(ready ? L.info : null);
    const g = BASE.map(gainOf);
    for (const c of $("lyPresets").children) { const p = PRESETS.find(([l]) => l === c.textContent); c.classList.toggle("on", !!p && p[1].every((v, i) => Math.abs(v - g[i]) < 0.001)); }
    const info = L.info;
    const hint = $("lyHint"); hint.classList.remove("warn");
    if (!info) { hint.textContent = "Looking…"; return; }
    if (!info.available) { hint.textContent = "This copy of the program has no sound splitter. Install the newest Nyenz Edit to use it."; hint.classList.add("warn"); $("lyBtn").disabled = true; return; }
    $("lyBtn").disabled = false;
    const a = range();
    if (ready) {
      const [u0, u1] = used();
      const outside = st().mix_split && info.split.id === st().mix_split && (u0 < info.split.start - 0.05 || u1 > info.split.end + 0.05);
      hint.textContent = outside ? "Part of your video is outside the split part. Press Split again." : changed() ? "Your mix plays in the viewer and goes into the export." : "Move a slider to change the mix.";
      if (outside) hint.classList.add("warn");
    } else if (running) {
      const j = info.job;
      hint.textContent = j.state === "downloading" ? "Getting the sound helper (once, " + info.model_mb + " MB)…" : "Splitting the sound. You can keep editing meanwhile.";
    } else {
      hint.textContent = "Makes three tracks: voices, music, effects. Takes about " + span($("lyMode").value === "best" ? info.estimate_best_s : info.estimate_s) + "." + (info.model ? "" : " First time: a " + info.model_mb + " MB download.");
    }
    if (running) {
      const j = info.job, p = Math.round((j.progress || 0) * 100);
      $("lyProg").firstElementChild.firstChild.style.width = p + "%";
      $("lyProgNote").textContent = (j.state === "downloading" ? "Downloading " : "Splitting ") + p + "%" + (j.eta_s ? " · " + span(j.eta_s) + " left" : "");
    }
  }

  async function refresh() {
    if (!S.proj || !S.info.has_audio) return;
    const [a, b] = range();
    try {
      L.info = await api("/api/split?id=" + encodeURIComponent(S.proj.source) + "&start=" + a.toFixed(3) + "&end=" + b.toFixed(3) +
        "&prefer=" + encodeURIComponent(st().mix_split || ""));          // keep this project's own cleaned-up split
    } catch (e) { L.info = null; return; }
    const sp = L.info.split;
    if (setNames(sp)) { build(); if (L.els) { pause(); try { L.ctx.close(); } catch (e) { /* already closed */ } L.els = null; L.ctx = null; L.gains = null; L.loaded = ""; } }
    document.dispatchEvent(new CustomEvent("layers-info"));
    if (sp && st().mix_split !== sp.id && !(st().mix_split && L.info.job && L.info.job.state === "running")) {
      const first = !st().mix_split && BASE.every((n) => Math.abs(gainOf(n) - 1) < 0.001) && !S.proj.pieces.some((p) => p.mix && Object.keys(p.mix).length);
      st().mix_split = sp.id;                                // a finished split of this video is attached to the project by itself
      if (first) {                                           // a good mix to start from, by itself: Voices 100 % and kept even, Music 50 %, Effects 80 %
        st().mix_music = 0.5; st().mix_effects = 0.8;
        for (const p of S.proj.pieces) p.mix = Object.assign({}, p.mix || {}, { voices: { volume: 1, mute: false, even: 1 } });
        if (typeof toast === "function") toast("Sound split. Start mix set by itself: Voices 100% (kept even), Music 50%, Effects 80%.");
      }
      scheduleSave();
    }
    paint(); apply();
    const j = L.info.job;
    clearTimeout(L.poll);
    if (j && ["downloading", "running"].includes(j.state)) L.poll = setTimeout(refresh, 1200);
    if (j && j.state === "failed" && L.busy) { L.busy = false; toast(j.error || "The sound could not be split.", true); }
    if (j && j.state === "ready") L.busy = false;
  }
  async function start() {
    const [a, b] = range();
    $("lyBtn").disabled = true; L.busy = true;
    try { await api("/api/split", { method: "POST", json: { input: S.proj.source, start: a, end: b, mode: $("lyMode").value } }); }
    catch (e) { toast(errText(e), true); L.busy = false; $("lyBtn").disabled = false; return; }
    refresh();
  }
  async function cancel() { try { await api("/api/split/cancel", { method: "POST", json: {} }); } catch (e) { /* nothing to cancel */ } L.busy = false; setTimeout(refresh, 400); }
  function splitAgain() { L.info = Object.assign({}, L.info, { split: null }); st().mix_split = ""; paint(); }

  // ---------------------------------------------------------------- live sound
  function usable() {
    const sp = L.info && L.info.split;
    return !!(S.proj && sp && st().mix_split === sp.id && changed());
  }
  function url(n) { return "/media?split=" + encodeURIComponent(L.info.split.id) + "&layer=" + n + "&t=" + encodeURIComponent(TOKEN); }
  function ensure() {
    if (L.els) return true;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;
    L.ctx = new Ctx(); L.els = {}; L.gains = {};
    for (const n of NAMES) {
      const a = new Audio(); a.preload = "auto";
      const g = L.ctx.createGain();
      L.ctx.createMediaElementSource(a).connect(g); g.connect(L.ctx.destination);
      L.els[n] = a; L.gains[n] = g;
    }
    return true;
  }
  function setGain(n, v, piece) {
    if (!L.gains) return;
    const p = piece || (typeof V !== "undefined" && V.seg && V.seg.p);
    const f = S.mutedAll || (p && p.mute) || !st().original_sound ? 0 : (p ? Math.max(0, p.volume) : 1);
    const shape = p && typeof partShapeGain === "function" && typeof active === "function" ? partShapeGain(p, n, active().currentTime) : 1;   // even out, fades
    const duck = typeof stemDuckGain === "function" && typeof active === "function" ? stemDuckGain(n, active().currentTime) : 1;   // going down under another track
    L.gains[n].gain.value = Math.max(0, v) * f * ownGain(p, n) * shape * duck;
  }
  function gainsNow(p) { for (const n of NAMES) setGain(n, gainOf(n), p); }
  function on() { return usable(); }
  function play() {
    if (!usable() || !ensure()) return;
    L.ctx.resume();
    if (L.loaded !== L.info.split.id) { for (const n of NAMES) L.els[n].src = url(n); L.loaded = L.info.split.id; }
    const v = active(), p = V.seg && V.seg.p;
    gainsNow(p);
    L.last = 0; follow(v, p, true);
  }
  function pause() { if (L.els) for (const n of NAMES) L.els[n].pause(); }
  /** Called while playing: keep the three layers at the same moment as the picture. */
  function follow(v, p, force) {
    if (!L.els || !usable()) return;
    const now = performance.now();
    if (!force && now - L.last < 180) return;
    L.last = now;
    const sp = L.info.split, target = v.currentTime - sp.start, rate = clamp(p ? p.speed : 1, 0.0625, 4);
    gainsNow(p);
    for (const n of NAMES) {
      const a = L.els[n];
      if (target < 0 || target > sp.end - sp.start - 0.05) { a.pause(); continue; }          // outside the split part: silence
      if (Math.abs(a.currentTime - target) > 0.15 && a.readyState >= 1) a.currentTime = target;
      if (a.playbackRate !== rate) a.playbackRate = rate;
      if (a.paused) { const pr = a.play(); if (pr && pr.catch) pr.catch(() => {}); }
    }
  }
  /** After a slider moved: update the sound now, and hand the sound over between the plain video and the layers. */
  function apply() {
    if (!S.proj) return;
    if (L.gains) gainsNow(V.seg && V.seg.p);
    if (typeof V !== "undefined" && S.playing) {
      for (const v of [V.a, V.b]) if (V.seg && v === active()) dress(v, V.seg.p);
      if (usable()) play(); else pause();
    }
  }
  function init() {
    if (!S.info.has_audio) { $("lyBox").hidden = true; return; }
    build(); paint();
    $("lyBtn").addEventListener("click", start);
    $("lyCancel").addEventListener("click", cancel);
    $("lyAgain").addEventListener("click", splitAgain);
    $("lyPart").addEventListener("change", () => { L.info = null; refresh(); });
    $("lyMode").addEventListener("change", paint);
    refresh();
  }
  /** What the live sound is doing (for the tests). */
  const state = () => (L.els ? Object.fromEntries(NAMES.map((n) => [n, { paused: L.els[n].paused, time: L.els[n].currentTime, gain: L.gains[n].gain.value, rate: L.els[n].playbackRate }])) : null);
  /** The split attached to this project ({id, start, end}), or null. */
  const split = () => (S.proj && L.info && L.info.split && st().mix_split === L.info.split.id ? L.info.split : null);
  return { init, open: refresh, refresh, play, pause, follow, apply, on, paint, state, split, NAMES, TITLE, ICON, gainOf, ownGain };
})();
