"""Stage 3, the Final page, in a real browser: music layers (volume, mute, solo), the loudness meter and the measured number."""

from __future__ import annotations

import subprocess

import pytest

from editforge.core import ffmpeg as ff


@pytest.fixture(scope="module")
def movie_id(live, movie):
    return live.upload(movie)


@pytest.fixture(scope="module")
def music_id(live, tmp_path_factory):
    p = tmp_path_factory.mktemp("music") / "Loud song.wav"
    subprocess.run([ff.find_executable("ffmpeg"), "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=30", "-af", "volume=-4dB", str(p)], check=True)
    return live.upload(str(p))


def open_final(live, page, source_id, name="Final one"):
    pid = live.call("POST", "/api/projects", {"source": source_id, "name": name, "stage": "final"})["project"]["id"]
    page.goto(f"{live.base}/final?p={pid}")
    page.wait_for_function("() => typeof S !== 'undefined' && S.proj && S.info && document.querySelector('#laneV > *')", timeout=30000)
    return pid


def test_music_layers_have_volume_mute_and_solo_and_are_saved(live, page, movie_id, music_id):
    pid = open_final(live, page, movie_id)
    page.evaluate("(id) => { S.proj.settings.layers = [{ file: id, volume: 0.5, mute: false, solo: false }, { file: id, volume: 1, mute: false, solo: false }]; scheduleSave(); loadFiles(); }", music_id)
    page.click(".rail button[data-panel=audio]")
    page.wait_for_function("() => document.querySelectorAll('#musicLayers .ly-row').length === 2")
    assert page.query_selector("#sDuck") is None and page.query_selector("#sMusic") is None          # no ducking switch any more
    page.click("#musicLayers .ly-row:nth-child(1) .ly-mute")
    page.click("#musicLayers .ly-row:nth-child(2) .ly-solo")
    assert page.evaluate("() => S.proj.settings.layers.map(x => [x.mute, x.solo])") == [[True, False], [False, True]]
    assert "Solo is on" in page.inner_text("#audioNote")
    page.evaluate("() => saveNow()")
    saved = live.call("GET", f"/api/projects/{pid}")["project"]["settings"]["layers"]
    assert [(x["mute"], x["solo"]) for x in saved] == [(True, False), (False, True)]
    page.click("#musicLayers .ly-row:nth-child(1) .ly-del")
    assert page.evaluate("() => S.proj.settings.layers.length") == 1
    assert page.errors == []


def test_an_old_project_with_one_music_file_gets_it_as_a_layer(live, page, movie_id, music_id):
    pid = live.call("POST", "/api/projects", {"source": movie_id, "name": "Old", "stage": "final"})["project"]["id"]
    body = live.call("GET", f"/api/projects/{pid}")["project"]
    body["settings"] = dict(body["settings"], music=music_id, music_volume=0.3)
    live.call("PUT", f"/api/projects/{pid}", body)
    page.goto(f"{live.base}/final?p={pid}")
    page.wait_for_function("() => typeof S !== 'undefined' && S.proj && S.info", timeout=30000)
    assert page.evaluate("() => S.proj.settings.layers.map(x => x.volume)") == [0.3]
    page.wait_for_function("() => document.getElementById('saveState').textContent === 'Saved'", timeout=10000)
    page.wait_for_timeout(900)
    again = live.call("GET", f"/api/projects/{pid}")["project"]["settings"]
    assert again["music"] == "" and len(again["layers"]) == 1


def test_the_mix_check_shows_the_measured_loudness_and_a_live_meter(live, page, movie_id, music_id):
    open_final(live, page, movie_id, "Loudness")
    page.evaluate("(id) => { S.proj.settings.layers = [{ file: id, volume: 1, mute: false, solo: false }]; scheduleSave(); }", music_id)
    page.evaluate("() => { S.pieces = null; }")
    page.click(".rail button[data-panel=sound]")
    page.click("#checkMix")
    page.wait_for_selector("#exportsDrawer .job .facts:has-text('LUFS')", timeout=240000)
    text = page.inner_text("#exportsDrawer .job")
    assert "meets the YouTube standard" in text, text
    page.click("#exportsDrawer .job >> text=Watch")
    page.wait_for_selector("#exportsDrawer .lmeter")
    assert "Whole video" in page.inner_text("#exportsDrawer .lmeter")
    assert page.errors == []


def _box(page):
    return page.evaluate("() => { const b = document.getElementById('frame').getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; }")


def _drag(page, x1, y1, x2, y2):
    page.mouse.move(x1, y1)
    page.mouse.down()
    page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, steps=4)
    page.mouse.move(x2, y2, steps=4)
    page.mouse.up()


def test_the_picture_can_be_moved_scaled_and_turned_with_the_mouse(live, page, movie_id):
    open_final(live, page, movie_id, "Handles")
    page.evaluate("() => { S.proj.settings.frame = Object.assign(Frame.full(null), { ratio: '9:16' }); sizeFrame(); }")
    page.click(".rail button[data-panel=frame]")
    page.wait_for_selector("#frame .frame-ov.editing")
    b = _box(page)
    cx, cy = b["x"] + b["w"] / 2, b["y"] + b["h"] / 2
    # move: drag the picture down and a bit left; close to the middle it snaps back to exactly 0
    _drag(page, cx, cy, cx - 40, cy + 70)
    fr = page.evaluate("() => S.proj.settings.frame")
    assert fr["x"] < -0.1 and fr["y"] > 0.1
    _drag(page, cx - 40, cy + 70, cx + 2, cy + 2)
    fr = page.evaluate("() => S.proj.settings.frame")
    assert fr["x"] == 0 and fr["y"] == 0, fr                                     # snapped to the middle lines
    # resize: drag a corner outwards
    pic = page.evaluate("() => { const f = Frame.full(S.proj.settings.frame), b = document.getElementById('frame').getBoundingClientRect(); const k = Math.min(b.width / (S.info.width / S.info.height), b.height) * f.scale; return { hw: (S.info.width / S.info.height) * k / 2, hh: k / 2 }; }")
    _drag(page, cx + pic["hw"] - 3, cy + pic["hh"] - 2, cx + pic["hw"] * 1.5, cy + pic["hh"] * 1.5)
    assert page.evaluate("() => S.proj.settings.frame.scale") > 1.3
    # turn: drag the round knob to the right of the picture (about 90 degrees)
    page.evaluate("() => { S.proj.settings.frame.scale = 1; sizeFrame(); }")
    _drag(page, cx, cy - pic["hh"] - 26, cx + 120, cy)
    assert page.evaluate("() => S.proj.settings.frame.rotate") == pytest.approx(90, abs=4)
    # the grid shows distances without being asked to drag
    page.evaluate("() => { S.proj.settings.frame.rotate = 0; sizeFrame(); }")
    page.check("#framePanel input.sw >> nth=0")
    assert page.evaluate("() => localStorage.getItem('ef.grid')") == "1"
    page.evaluate("() => saveNow()")
    assert page.errors == []


def test_the_mask_can_be_moved_resized_and_turned(live, page, movie_id):
    open_final(live, page, movie_id, "Mask handles")
    page.evaluate("() => { S.proj.settings.frame = Object.assign(Frame.full(null), { ratio: '9:16', mask: { shape: 'rect', x: 0.5, y: 0.5, w: 0.5, h: 0.2, feather: 20, invert: false, rot: 0 } }); sizeFrame(); }")
    page.click(".rail button[data-panel=frame]")
    page.click("#framePanel .seg button:has-text('Mask')")
    b = _box(page)
    cx, cy = b["x"] + b["w"] / 2, b["y"] + b["h"] / 2
    _drag(page, cx, cy, cx, cy + 60)
    assert page.evaluate("() => S.proj.settings.frame.mask.y") > 0.55
    hh = 0.2 * b["h"] / 2
    cy2 = b["y"] + b["h"] * page.evaluate("() => S.proj.settings.frame.mask.y")
    _drag(page, cx, cy2 + hh, cx, cy2 + hh + 40)                                   # the bottom side handle: taller
    assert page.evaluate("() => S.proj.settings.frame.mask.h") > 0.25
    page.fill("#framePanel input[aria-label='Turn the mask']", "30")
    page.dispatch_event("#framePanel input[aria-label='Turn the mask']", "input")
    assert page.evaluate("() => S.proj.settings.frame.mask.rot") == 30
    page.evaluate("() => saveNow()")
    saved = live.call("GET", f"/api/projects/{page.evaluate('() => S.proj.id')}")["project"]["settings"]["frame"]["mask"]
    assert saved["rot"] == 30 and saved["shape"] == "rect"
    assert page.errors == []


def test_the_top_bar_always_shows_the_version_and_an_update_button_when_one_is_out(live, page):
    page.goto(f"{live.base}/")
    page.wait_for_function("() => document.querySelector('.update-pill') && /Version /.test(document.querySelector('.update-pill').textContent)", timeout=15000)
    assert page.is_visible(".update-pill.quiet")
    page.evaluate("() => { Update.st = Object.assign({}, Update.st, { available: true, latest: '99.0.0' }); Update.paint(); }")
    assert page.inner_text(".update-pill") == "Update to 99.0.0" and not page.is_visible(".update-pill.quiet")
    assert page.errors == []
