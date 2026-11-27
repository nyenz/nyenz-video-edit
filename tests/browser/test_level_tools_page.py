"""1.36, Final in a real browser: Level (Light / Medium / Strong / Max / Custom, with A/B), Find problems (tabs, go,
fix), Quick fixes (Make voice clear, Remove silence), song tools (Ends with the video, Cuts on the beat) and Made for."""

from __future__ import annotations

import pytest


@pytest.fixture(scope="module")
def talk_id(live, tmp_path_factory):
    """A video of 1 s talking (a tone), 1 s silence, again and again; no split."""
    from tools.make_samples import make_video
    p = make_video(str(tmp_path_factory.mktemp("talk") / "Talk with pauses.mp4"), 40, "320x180", "25", "speech")
    return live.upload(p)


@pytest.fixture(scope="module")
def click_id(live, tmp_path_factory):
    from tools.make_samples import write_click_track
    p = str(tmp_path_factory.mktemp("click") / "Click 120.wav")
    write_click_track(p, 120, 4, 90)
    return live.upload(p)


def open_final(live, page, fid, name, interval=10):
    pid = live.call("POST", "/api/projects", {"source": fid, "name": name, "stage": "final", "interval": interval})["project"]["id"]
    page.goto(f"{live.base}/final?p={pid}")
    page.wait_for_function("() => typeof S !== 'undefined' && S.proj && S.info && document.querySelector('#laneV .clipb')", timeout=30000)
    return pid


def test_level_has_four_strengths_custom_and_a_b(live, page, talk_id):
    open_final(live, page, talk_id, "Level")
    page.evaluate("() => { S.sel = new Set([kept()[0]]); renderInspector(); }")
    seg = "#right .even-field .level-seg"
    assert page.eval_on_selector_all(seg + " button", "bs => bs.map(b => b.textContent)") == ["Off", "Light", "Medium", "Strong", "Max", "Custom"]
    page.click(seg + " button:has-text('Medium')")
    assert page.evaluate("() => kept()[0].even") == 3
    page.click(seg + " button:has-text('Custom')")
    assert page.evaluate("() => kept()[0].even") == 1122
    page.click("#right .level-custom .field:has-text('How fast') button:has-text('Fast')")
    page.click("#right .level-custom .field:has-text('lifts') button:has-text('+24')")
    assert page.evaluate("() => kept()[0].even") == 1242
    page.click("#right .ab-btn")
    assert page.evaluate("() => S.levelOff") is True
    assert page.evaluate("() => partShapeGain(kept()[0], 'original', 0.5)") == 1          # before: no Level heard
    page.click("#right .ab-btn")
    assert page.evaluate("() => S.levelOff") is False
    page.evaluate("() => saveNow()")
    assert page.errors == []


def test_find_problems_lists_them_in_tabs_and_fixes_them(live, page, talk_id):
    open_final(live, page, talk_id, "Problems")
    page.click(".ftabs button[data-panel=sound]")
    assert "Find problems" in page.inner_text("#checkMix")
    page.evaluate("""() => { S.check = { points: [[0, -14], [40, -14]], loudness: { lufs: -15.1, true_peak: -1.6 },
        problems: [{ kind: 'loud', start: 1, end: 5 }, { kind: 'silent', start: 12, end: 15 }, { kind: 'noisy', start: 21, end: 28 }],
        clipped: [{ kind: 'clipped', start: 33, end: 35 }], sig: JSON.stringify([S.proj.pieces, S.proj.settings]) };
        $('mixCheck').hidden = false; renderCheck(); renderTimeline(); }""")
    tabs = page.eval_on_selector_all("#mixCheck .prob-tab span", "els => els.map(e => e.textContent)")
    assert tabs == ["All", "Too loud", "Silent", "Noise", "Clipped"]
    assert page.locator("#mixCheck .prob-row").count() == 4
    page.click("#mixCheck .prob-tab:has-text('Noise')")
    assert page.locator("#mixCheck .prob-row").count() == 1
    page.click("#mixCheck .prob-row")                                       # go there
    assert abs(page.evaluate("() => S.t") - 21) < 0.1
    page.click("#mixCheck .prob-row button:has-text('Fix')")
    assert page.evaluate("() => kept()[2].nr") == 2 and not page.evaluate("() => kept()[0].nr")
    page.click("#mixCheck .prob-tab:has-text('All')")
    page.click("#mixCheck button:has-text('Fix all')")
    assert page.evaluate("() => [kept()[0].even, kept()[3].even, kept()[3].volume]") == [3, 3, 0.7]   # loud and clipped
    assert page.is_visible("#mixCheck .prob-row:has-text('Silent') button:has-text('Remove')")
    assert page.errors == []


def test_quick_fixes_make_voice_clear_and_remove_silence(live, page, talk_id):
    pid = open_final(live, page, talk_id, "Quick fixes", interval=40)
    page.click(".ftabs button[data-panel=sound]")
    page.click("#qVoice")
    assert page.evaluate("() => kept().every(p => p.tone === 'voice' && p.hp === 80 && p.nr === 1 && p.dyn === 1 && p.even === 1)")
    before = page.evaluate("() => finalTotal()")
    page.click("#qSilence")
    dlg = page.locator(".dialog[aria-label='Remove silence']")
    dlg.locator(".field:has-text('Shortest pause') button:has-text('0.5 s')").click()
    dlg.locator(".field:has-text('Keep around') button:has-text('0.1 s')").click()
    dlg.locator("button:has-text('Remove the pauses')").click()
    page.wait_for_function("() => kept().length > 10", timeout=60000)
    after = page.evaluate("() => finalTotal()")
    assert before - after > 10, (before, after)                              # most of the 20 one-second pauses are gone
    page.keyboard.press("Control+z")
    page.wait_for_function("(b) => Math.abs(finalTotal() - b) < 0.05", arg=before)
    page.evaluate("() => saveNow()")
    assert len(live.call("GET", f"/api/projects/{pid}")["project"]["pieces"]) == 1
    assert page.errors == []


def test_song_ends_with_the_video_and_cuts_go_on_the_beat(live, page, talk_id, click_id):
    open_final(live, page, talk_id, "Song tools")
    page.evaluate("""(id) => { S.proj.pieces = S.proj.pieces.map(p => Object.assign(p, { off: false }));
        change(() => { S.proj.pieces = [[0, 10.2], [10.2, 20.3], [20.3, 30.1], [30.1, 40]].map(([a, b]) => fixPiece({ start: a, end: b, off: false, speed: 1, reverse: false, mute: false, volume: 1 })); });
        S.proj.settings.layers = [{ file: id, volume: 1, mute: false, solo: false }]; loadFiles(); refreshAll(); }""", click_id)
    page.wait_for_selector("#laneM .mpart")
    page.click("#laneM .mpart")
    page.click("#right button:has-text('Ends with the video')")
    page.wait_for_function("() => S.proj.settings.layers[0].start > 0", timeout=10000)
    assert abs(page.evaluate("() => S.proj.settings.layers[0].start") - (90 - 40)) < 0.2
    page.evaluate("() => { change(() => setLayer(0, { start: 0 }), { keepVideo: true }); }")
    page.click("#laneM .mpart")
    page.click("#right button:has-text('Cuts on the beat')")
    page.wait_for_function("() => Math.abs(kept()[0].end - 10.0) < 0.06", timeout=60000)
    ends = page.evaluate("() => layout().slice(0, 3).map(r => r.out1)")
    assert all(abs(e * 2 - round(e * 2)) < 0.06 for e in ends), ends          # every cut on a beat (120 BPM: every 0.5 s)
    assert page.errors == []


def test_made_for_sets_the_place_in_export(live, page, talk_id):
    pid = open_final(live, page, talk_id, "Made for")
    page.evaluate("() => exportDialog()")
    dlg = page.locator(".dialog[aria-label=Export]")
    dlg.locator(".field:has-text('Made for') button:has-text('TV')").click()
    assert "TV standard (−23 LUFS)" in dlg.inner_text()
    page.keyboard.press("Escape")
    page.evaluate("() => saveNow()")
    assert live.call("GET", f"/api/projects/{pid}")["project"]["settings"]["made_for"] == "tv"
    assert page.errors == []
