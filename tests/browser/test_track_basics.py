"""1.34, Final in a real browser: every sound track (the video's own sound, each split track, each song) has Mute, Solo and
Lock that work together; loudness goes up to 500 %; and Exports shows one tab per kind, newest on top."""

from __future__ import annotations

import json
import time

import pytest

from editforge.core.fingerprint import file_fingerprint
from editforge import splitter as SP


@pytest.fixture(scope="module")
def plain_id(live, movie):
    return live.upload(movie)


@pytest.fixture(scope="module")
def split_movie(live, movie, tmp_path_factory):
    from tools.make_samples import run
    copy = tmp_path_factory.mktemp("tb") / "Split me.mp4"
    copy.write_bytes(open(movie, "rb").read())
    fid = live.upload(str(copy))
    src = live.state.resolve_input(fid)
    store = SP.SplitStore(live.state.home)
    folder = store.folder(file_fingerprint(src), 0.0, 182.0)
    folder.mkdir(parents=True, exist_ok=True)
    for name, hz in (("voices", 300), ("music", 1000), ("effects", 3000)):
        run(["-f", "lavfi", "-i", f"sine=frequency={hz}:duration=182", "-ar", "16000", "-c:a", "flac", str(folder / (name + ".flac"))])
    store.write_meta(folder, 0.0, 182.0, 1.0, "fast")
    return fid


def open_final(live, page, fid, name):
    pid = live.call("POST", "/api/projects", {"source": fid, "name": name, "stage": "final", "interval": 20})["project"]["id"]
    page.goto(f"{live.base}/final?p={pid}")
    page.wait_for_function("() => typeof S !== 'undefined' && S.proj && S.info && document.querySelector('#laneV .clipb')", timeout=30000)
    return pid


def test_the_video_sound_has_mute_solo_and_lock_and_goes_to_500(live, page, plain_id):
    pid = open_final(live, page, plain_id, "Own sound")
    head = "#laneA .lane-head"
    page.wait_for_selector(head + " .lh-btn.solo")
    page.click(head + " .lh-btn:not(.solo)")                                   # Mute
    assert page.evaluate("() => S.proj.settings.mute") == ["original"]
    assert page.evaluate("() => ownSoundOn()") is False
    assert page.evaluate("() => $('laneA').classList.contains('muted')")
    page.click(head + " .lh-btn:not(.solo)")                                   # heard again
    assert page.evaluate("() => ownSoundOn()") is True
    page.click(head + " .lh-btn.solo")                                         # Solo: only for listening
    assert page.evaluate("() => S.proj.settings.solo") == ["original"]
    page.wait_for_selector("#soloChip:not([hidden])")
    assert "Sound" in page.get_attribute("#soloChip", "title")
    page.click("#soloChip")
    assert page.evaluate("() => S.proj.settings.solo") == []
    # a locked sound track cannot be muted, but the mute button says why
    page.click(head + " .lock-btn")
    page.click(head + " .lh-btn:not(.solo)")
    assert page.evaluate("() => S.proj.settings.mute") == []
    page.click(head + " .lock-btn")
    # loudness of a section goes up to 500 %
    page.evaluate("() => { S.sel = new Set([kept()[0]]); renderInspector(); }")
    rng = page.locator("#right input.rng[aria-label=Loudness]")
    assert rng.get_attribute("max") == "5"
    page.evaluate("() => { const r = document.querySelector('#right input.rng[aria-label=Loudness]'); r.value = '4.5'; r.dispatchEvent(new Event('change')); }")
    assert page.evaluate("() => kept()[0].volume") == 4.5
    page.evaluate("() => saveNow()")
    saved = live.call("GET", f"/api/projects/{pid}")["project"]
    assert saved["pieces"][0]["volume"] == 4.5 and saved["settings"]["mute"] == []
    assert page.errors == []


def test_each_split_track_has_mute_and_solo_that_change_what_you_hear(live, page, split_movie):
    pid = open_final(live, page, split_movie, "Split tracks")
    page.wait_for_selector("#laneStems .lane.stem", timeout=30000)
    for n in ("voices", "music", "effects"):
        assert page.locator(f"#laneStems .stem-head[data-layer={n}] .lh-btn").count() == 2
        assert page.locator(f"#laneStems .stem-head[data-layer={n}] .lock-btn").count() == 1
    page.click("#laneStems .stem-head[data-layer=music] .lh-btn:not(.solo)")
    assert page.evaluate("() => S.proj.settings.mute") == ["music"]
    assert page.evaluate("() => aselList().length") == 0                       # the button does not choose the track
    page.click("#laneStems .stem-head[data-layer=voices] .lh-btn.solo")
    assert page.evaluate("() => ['voices','music','effects'].map(keyHeard)") == [True, False, False]
    page.evaluate("() => { seek(1); play(); }")
    page.wait_for_function("() => Layers.state() && Layers.state().voices.gain > 0", timeout=20000)
    g = page.evaluate("() => Layers.state()")
    assert g["music"]["gain"] == 0 and g["effects"]["gain"] == 0
    page.evaluate("() => pause()")
    # solo is only for listening: the saved mix still has voices and effects, without the muted music
    page.evaluate("() => saveNow()")
    st = live.call("GET", f"/api/projects/{pid}")["project"]["settings"]
    assert st["mute"] == ["music"] and st["solo"] == ["voices"]
    from editforge.project import _layer_mix  # noqa: F401  (the export reads the same settings)
    # the Split panel's mute is the same switch
    page.click("#laneStems .stem-head[data-layer=music] .lh-btn:not(.solo)")
    assert page.evaluate("() => S.proj.settings.mute") == []
    # a locked track cannot be muted
    page.click("#laneStems .stem-head[data-layer=effects] .lock-btn")
    page.click("#laneStems .stem-head[data-layer=effects] .lh-btn:not(.solo)")
    assert page.evaluate("() => S.proj.settings.mute") == []
    assert page.errors == []


def _fake_job(live, name, group, age):
    """A finished export, without making a video (the list only needs the record)."""
    opts = {"kind": "project"}
    if group == "clip":
        opts["clipset"] = "x"
    if group == "preview":
        opts["preview"] = True
    jid = live.state.store.create("", "", f"/nowhere/{name}.mp4", opts)
    live.state.store.update(jid, status="done", progress=1.0, created=time.time() - age)
    return jid


def test_exports_has_a_tab_per_kind_newest_on_top_with_find_and_rename(live, page, plain_id):
    old = _fake_job(live, "Old final", "final", 500)
    new = _fake_job(live, "New final", "final", 50)
    _fake_job(live, "A clip", "clip", 100)
    _fake_job(live, "A preview", "preview", 200)
    open_final(live, page, plain_id, "Exports")
    page.evaluate("() => { localStorage.setItem('exTab', 'final'); Exports.jump = false; }")
    page.evaluate("() => Exports.show()")
    page.wait_for_selector("#exportsDrawer .ex-tab")
    page.evaluate("() => { Exports.tab = 'final'; return Exports.refresh(true); }")
    tabs = page.eval_on_selector_all("#exportsDrawer .ex-tab span:not(.note)", "els => els.map(e => e.textContent)")
    assert tabs[:2] == ["Finals", "Clips"] and "Previews" in tabs
    names = page.eval_on_selector_all("#exportsDrawer .job .hd b", "els => els.map(e => e.textContent)")
    assert "A clip" + ".mp4" not in names and "A preview.mp4" not in names      # never everything at once
    assert names.index("New final.mp4") < names.index("Old final.mp4")         # newest on top
    page.click("#exportsDrawer .ex-tab[data-tab=clip]")
    page.wait_for_selector("#exportsDrawer .ex-tab.on[data-tab=clip]")
    names = page.eval_on_selector_all("#exportsDrawer .job .hd b", "els => els.map(e => e.textContent)")
    assert "A clip.mp4" in names and "New final.mp4" not in names
    assert page.evaluate("() => localStorage.getItem('exTab')") == "clip"                  # remembered
    page.click("#exportsDrawer .ex-tab[data-tab=final]")
    page.wait_for_selector("#exportsDrawer .ex-tab.on[data-tab=final]")
    page.fill("#exportsDrawer .ex-find", "old")
    page.fill("#exportsDrawer .ex-find", "old final")
    page.wait_for_function("() => [...document.querySelectorAll('#exportsDrawer .job .hd b')].map(e => e.textContent).join() === 'Old final.mp4'")
    assert page.evaluate("() => document.activeElement.classList.contains('ex-find')")    # still typing
    live.call("POST", f"/api/jobs/{old}/rename", {"name": "My best cut"})
    jobs = {j["id"]: j for j in live.call("GET", "/api/jobs")["jobs"]}
    assert jobs[old]["title"] == "My best cut" and jobs[new].get("title") is None
    assert live.call("POST", f"/api/jobs/{old}/reveal", {})["ok"] is False      # no file manager on a test server
    assert page.errors == []
