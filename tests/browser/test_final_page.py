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
    page.click(".ftabs button[data-panel=sound]")
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
    page.click(".ftabs button[data-panel=sound]")
    page.click("#checkMix")
    page.wait_for_selector("#mixCheck .check-nums", timeout=240000)          # the Sound check result in the panel
    assert "LUFS" in page.inner_text("#mixCheck")
    page.wait_for_function("() => fetch('/api/jobs', { headers: { 'X-EditForge-Token': TOKEN } }).then(r => r.json()).then(d => d.jobs.length === 0)", timeout=30000)   # no leftover file
    page.evaluate("() => quickPreview()")                                    # a preview you ask for stays, with its measured loudness
    page.wait_for_selector("#exportsDrawer .job .facts:has-text('LUFS')", timeout=240000)
    text = page.locator("#exportsDrawer .job:has(.facts:has-text('LUFS'))").first.inner_text()
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
    page.click(".ftabs button[data-panel=frame]")
    page.wait_for_selector("#frame .frame-ov.editing")
    b = _box(page)
    cx, cy = b["x"] + b["w"] / 2, b["y"] + b["h"] / 2
    # move: drag the picture down and a bit left; close to the middle it snaps back to exactly 0
    _drag(page, cx, cy, cx - 40, cy + 70)
    fr = page.evaluate("() => effectiveFrame()")
    assert fr["x"] < -0.1 and fr["y"] > 0.1
    _drag(page, cx - 40, cy + 70, cx + 2, cy + 2)
    fr = page.evaluate("() => effectiveFrame()")
    assert fr["x"] == 0 and fr["y"] == 0, fr                                     # snapped to the middle lines
    # resize: drag a corner outwards
    pic = page.evaluate("() => { const f = Frame.full(effectiveFrame()), b = document.getElementById('frame').getBoundingClientRect(); const k = Math.min(b.width / (S.info.width / S.info.height), b.height) * f.scale; return { hw: (S.info.width / S.info.height) * k / 2, hh: k / 2 }; }")
    _drag(page, cx + pic["hw"] - 3, cy + pic["hh"] - 2, cx + pic["hw"] * 1.5, cy + pic["hh"] * 1.5)
    assert page.evaluate("() => effectiveFrame().scale") > 1.3
    # turn: drag the round knob to the right of the picture (about 90 degrees)
    page.evaluate("() => { const f = Frame.full(effectiveFrame()); f.scale = 1; storeFrame(f); }")
    _drag(page, cx, cy - pic["hh"] - 26, cx + 120, cy)
    assert page.evaluate("() => effectiveFrame().rotate") == pytest.approx(90, abs=4)
    # the grid shows distances without being asked to drag
    page.evaluate("() => { const f = Frame.full(effectiveFrame()); f.rotate = 0; storeFrame(f); }")
    page.check("#framePanel input.sw >> nth=0")
    assert page.evaluate("() => localStorage.getItem('ef.grid')") == "1"
    assert page.evaluate("() => S.proj.settings.frame.x") == 0                  # the shape is for all; the position is the section's
    page.evaluate("() => saveNow()")
    assert page.errors == []


def test_the_mask_can_be_moved_resized_and_turned(live, page, movie_id):
    open_final(live, page, movie_id, "Mask handles")
    page.evaluate("() => { S.proj.settings.frame = Object.assign(Frame.full(null), { ratio: '9:16', mask: { shape: 'rect', x: 0.5, y: 0.5, w: 0.5, h: 0.2, feather: 20, invert: false, rot: 0 } }); sizeFrame(); }")
    page.click(".ftabs button[data-panel=frame]")
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


def test_overall_loudness_has_seven_steps_and_is_used_by_the_preview(live, page, movie_id):
    pid = open_final(live, page, movie_id, "Loud one")
    page.click(".topbar button:has-text('Export'), button.primary:has-text('Export')")
    dlg = page.locator(".dialog[aria-label=Export]")
    seg = dlg.locator(".field:has-text('Overall loudness') .seg button")
    assert seg.all_inner_texts() == ["−3", "−2", "−1", "Standard", "+1", "+2", "+3"]
    assert dlg.locator(".field:has-text('Overall loudness') .seg button.on").inner_text() == "Standard"     # it starts in the middle
    assert "−14 LUFS" in dlg.inner_text()
    seg.nth(5).click()
    assert "3.0 dB louder" in dlg.inner_text()
    dlg.locator("button:has-text('Quick preview')").click()
    page.wait_for_function("() => !document.querySelector('.dialog[aria-label=Export]')")
    assert live.call("GET", f"/api/projects/{pid}")["project"]["settings"]["loudness_step"] == 2
    page.evaluate("() => { exportDialog(); }")                            # (the Exports drawer is open now)
    page.wait_for_selector(".dialog[aria-label=Export], .dialog:has-text('already')")
    if page.locator(".dialog:has-text('already')").count():              # the preview still runs: it asks first (1.40.3)
        page.locator(".dialog:has-text('already') button:has-text('Start another')").click()
        page.wait_for_selector(".dialog[aria-label=Export]")
    assert page.locator(".dialog[aria-label=Export] .seg button.on:has-text('+2')").count() == 1           # remembered
    assert page.errors == []


def test_song_goes_down_under_each_track_with_its_own_level(live, page, movie_id, music_id):
    pid = open_final(live, page, movie_id, "Ducks")
    page.evaluate("(id) => { S.proj.settings.layers = [{ file: id, volume: 0.5, mute: false, solo: false, duck: { on: true, by: { voices: 0.3, effects: 0.1 } } }]; scheduleSave(); loadFiles(); }", music_id)
    page.wait_for_selector(".mrow .mpart")
    page.click(".mrow .mpart")
    rows = page.locator(".duck-box .duck-row")
    page.wait_for_function("() => document.querySelectorAll('.duck-box .duck-row').length === 3")
    assert rows.nth(0).get_attribute("data-under") == "voices" and "30%" in rows.nth(0).inner_text()
    assert "on" in rows.nth(2).get_attribute("class") and "10%" in rows.nth(2).inner_text()
    assert "on" not in rows.nth(1).get_attribute("class").split()                  # music: not chosen
    rows.nth(0).locator("input.sw").click()                                         # voices off, effects stays
    page.wait_for_function("() => { const d = S.proj.settings.layers[0].duck; return d.on && !('voices' in d.by) && d.by.effects === 0.1; }")
    page.evaluate("() => saveNow()")
    saved = live.call("GET", f"/api/projects/{pid}")["project"]["settings"]["layers"][0]["duck"]
    assert saved == {"on": True, "by": {"effects": 0.1}}
    assert page.errors == []


def test_song_parts_can_be_dragged_and_taken_out(live, page, movie_id, music_id):
    pid = open_final(live, page, movie_id, "Song parts")
    page.evaluate("(id) => { S.proj.settings.layers = [{ file: id, volume: 0.5, mute: false, solo: false, parts: [{ end: 20, volume: 1, mute: false }, { end: 40, volume: 1, mute: false }, { end: null, volume: 1, mute: false }] }]; scheduleSave(); loadFiles(); }", music_id)
    page.wait_for_function("() => document.querySelectorAll('.mrow .mpart').length === 3")
    page.evaluate("() => { S.msel = { i: 0, ks: new Set([1]) }; moveMusicPart(0, 1, 5); }")          # part 2 (20-40 s) 5 s later
    ps = page.evaluate("() => mspans(layers()[0]).map((r) => [+r.a.toFixed(2), +r.b.toFixed(2), +r.src.toFixed(2), !!r.q.mute])")
    assert ps[:3] == [[0, 20, 0, False], [20, 25, 20, True], [25, 45, 20, False]]               # a gap where it was, its sound went with it
    assert [ps[3][0], ps[3][2]] == [45, 45]                                                    # the rest is covered up to 45 s
    page.evaluate("() => { S.msel = { i: 0, ks: new Set([1]) }; deleteMusicParts(true); }")     # take the gap out: the rest moves up
    ps = page.evaluate("() => mspans(layers()[0]).map((r) => [+r.a.toFixed(2), +r.b.toFixed(2), +r.src.toFixed(2), !!r.q.mute])")
    assert ps[:2] == [[0, 20, 0, False], [20, 40, 20, False]] and [ps[2][0], ps[2][2]] == [40, 45]
    page.evaluate("() => moveMusicCut(0, 0, 15)")                                              # the cut at 20 s moves to 15 s
    ps = page.evaluate("() => mspans(layers()[0]).map((r) => [+r.a.toFixed(2), +r.b.toFixed(2), +r.src.toFixed(2)])")
    assert ps[0] == [0, 15, 0] and ps[1] == [15, 40, 15]
    page.evaluate("() => saveNow()")
    saved = live.call("GET", f"/api/projects/{pid}")["project"]["settings"]["layers"][0]["parts"]
    assert saved[0]["end"] == 15.0 and "from" not in saved[0] and "from" not in saved[1]      # follows on: no jump saved
    # a real drag with the mouse moves the last part
    page.evaluate("() => { S.pps = 8; renderTimeline(); }")
    box = page.locator('.mrow[data-i="0"] .mpart').nth(1).bounding_box()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.mouse.down(); page.mouse.move(box["x"] + box["width"] / 2 + 40, box["y"] + box["height"] / 2, steps=5); page.mouse.up()
    ps = page.evaluate("() => mspans(layers()[0]).map((r) => [+r.a.toFixed(1), +r.src.toFixed(1), !!r.q.mute])")
    assert [20.0, 15.0, False] in ps and [15.0, 15.0, True] in ps                               # moved 5 s right, a gap before it
    assert page.errors == []


def test_loudness_is_heard_live_without_making_anything_and_solo_is_easy_to_see(live, page, movie_id, music_id):
    pid = open_final(live, page, movie_id, "Listen")
    jobs_before = len(live.call("GET", "/api/jobs")["jobs"])
    page.evaluate("() => exportDialog()")
    dlg = page.locator(".dialog[aria-label=Export]")
    dlg.locator(".field:has-text('Overall loudness') .seg button").nth(6).click()            # +3: plays right away, louder
    page.wait_for_function("() => S.playing")
    assert abs(page.evaluate("() => masterGain()") - 10 ** (4.5 / 20)) < 1e-6
    assert "Stop listening" in dlg.inner_text()
    dlg.locator("button:has-text('Stop listening')").click()
    page.wait_for_function("() => !S.playing")
    dlg.locator(".field:has-text('Overall loudness') .seg button").nth(0).click()            # -3: quieter
    assert abs(page.evaluate("() => masterGain()") - 10 ** (-4.5 / 20)) < 1e-6
    page.evaluate("() => pause()")
    page.keyboard.press("Escape")
    page.wait_for_selector(".dialog[aria-label=Export]", state="detached")                    # Esc closes it
    assert len(live.call("GET", "/api/jobs")["jobs"]) == jobs_before                           # nothing was rendered
    page.evaluate("() => saveNow()")
    assert live.call("GET", f"/api/projects/{pid}")["project"]["settings"]["loudness_step"] == -3
    # a Solo left on shows next to the player, and one click hears everything again
    page.evaluate("(id) => { S.proj.settings.layers = [{ file: id, volume: 0.5, mute: false, solo: true }]; scheduleSave(); loadFiles(); }", music_id)
    page.wait_for_selector("#soloChip:not([hidden])")
    page.click("#soloChip")
    page.wait_for_selector("#soloChip", state="hidden")
    assert page.evaluate("() => S.proj.settings.layers[0].solo") is False
    assert page.errors == []


def test_a_finished_video_keeps_playing_and_stays_full_screen_while_the_exports_list_updates(live, page, movie_id):
    open_final(live, page, movie_id, "Watch it")
    page.evaluate("() => { S.proj.pieces = S.proj.pieces.map((p, i) => Object.assign(p, { off: i > 2 })); saveNow(); }")
    page.evaluate("() => exportDialog()")
    page.click(".dialog[aria-label=Export] button:has-text('Quick preview file')")
    page.wait_for_selector("#exportsDrawer .job button:has-text('Watch')", timeout=180000)
    page.locator("#exportsDrawer .job button:has-text('Watch')").first.click()
    page.wait_for_selector("#exportsDrawer .mini video")
    page.evaluate("() => { const v = document.querySelector('#exportsDrawer .mini video'); v.muted = true; v._mark = 1; return v.play(); }")
    page.evaluate("() => Exports.refresh()")                       # what the app does every second while something is running
    page.evaluate("() => { Exports.sig = 'changed'; return Exports.refresh(); }")
    assert page.evaluate("() => { const v = document.querySelector('#exportsDrawer .mini video'); return !!v && v._mark === 1 && !v.paused; }")
    page.click("#exportsDrawer .mini button[title='Full screen']")
    page.wait_for_function("() => document.fullscreenElement && document.fullscreenElement.classList.contains('mini')")
    page.evaluate("() => { Exports.sig = 'changed again'; return Exports.refresh(true); }")
    assert page.evaluate("() => !!document.fullscreenElement")       # still full screen
    bar = page.locator(".mini.is-full .mini-bar").bounding_box()
    assert bar and bar["y"] + bar["height"] <= 800 + 1                # the controls are on the screen in full screen
    page.keyboard.press("Escape")
    page.wait_for_function("() => !document.fullscreenElement")
    assert page.errors == []
