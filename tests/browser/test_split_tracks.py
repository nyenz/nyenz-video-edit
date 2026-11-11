"""1.19, Final in a real browser: after the sound is split, Voices / Music / Effects are tracks on the timeline whose parts can
be chosen (one, several, a whole track, two tracks together) and muted or made quieter; empty number boxes when the chosen
sections differ; and the starting look of a new shape (soft edges 17 %, 260 % in 9:16)."""

from __future__ import annotations

import pytest

from editforge.core.fingerprint import file_fingerprint
from editforge import splitter as SP


@pytest.fixture(scope="module")
def split_movie(live, movie):
    from tools.make_samples import run
    fid = live.upload(movie)
    src = live.state.resolve_input(fid)
    store = SP.SplitStore(live.state.home)
    folder = store.folder(file_fingerprint(src), 0.0, 182.0)
    folder.mkdir(parents=True, exist_ok=True)
    for name, hz in (("voices", 300), ("music", 1000), ("effects", 3000)):
        run(["-f", "lavfi", "-i", f"sine=frequency={hz}:duration=182", "-ar", "16000", "-c:a", "flac", str(folder / (name + ".flac"))])
    store.write_meta(folder, 0.0, 182.0, 1.0, "fast")
    yield fid
    import shutil
    shutil.rmtree(folder, ignore_errors=True)                     # the other tests use this movie without a split


def open_split(live, page, fid, name, interval=20):
    pid = live.call("POST", "/api/projects", {"source": fid, "name": name, "stage": "final", "interval": interval})["project"]["id"]
    page.goto(f"{live.base}/final?p={pid}")
    page.wait_for_function("() => typeof S !== 'undefined' && S.proj && S.info && document.querySelector('#laneV .clipb')", timeout=30000)
    return pid


def test_split_sound_tracks_can_be_chosen_and_changed(live, page, split_movie):
    pid = open_split(live, page, split_movie, "Tracks")
    page.wait_for_selector("#laneStems .lane.stem", timeout=30000)
    assert page.eval_on_selector_all("#laneStems .stem-head span", "els => els.map(e => e.textContent)") == ["Voices", "Music", "Effects"]
    assert page.is_hidden("#laneA")                                   # the three tracks take the place of the one sound track
    page.wait_for_function("() => S.stemPeaks.music && S.stemPeaks.music.length > 1000", timeout=30000)
    n = page.evaluate("() => kept().length")
    # the whole Music track: one click on its name
    page.click("#laneStems .stem-head[data-layer=music]")
    assert page.evaluate("() => aselList().length") == n
    assert page.inner_text("#right .side-h h2") == "Music"
    page.click("#right input[aria-label='Mute the chosen parts']")
    assert page.evaluate("() => kept().every(p => p.mix && p.mix.music.mute)")
    # Voices together with Music: Ctrl + click the second name
    page.click("#laneStems .stem-head[data-layer=voices]", modifiers=["Control"])
    assert page.inner_text("#right .side-h h2") == "Voices + Music"
    # parts: one, then Ctrl + click another, then Delete mutes just those
    page.eval_on_selector("#laneStems .lane.stem[data-layer=effects]", "e => e.scrollIntoView({ block: 'nearest' })")
    lane = page.query_selector("#laneStems .lane.stem[data-layer=effects]").bounding_box()
    xs = page.evaluate("() => layout().slice(0, 3).map(r => px((r.out0 + r.out1) / 2) - $('tlScroll').scrollLeft)")
    tl = page.query_selector("#tlScroll").bounding_box()
    page.mouse.click(tl["x"] + xs[0], lane["y"] + 16)
    page.keyboard.down("Control"); page.mouse.click(tl["x"] + xs[2], lane["y"] + 16); page.keyboard.up("Control")
    assert page.evaluate("() => aselList().map(x => kept().indexOf(x.p) + x.n)") == ["0effects", "2effects"]
    page.keyboard.press("Delete")
    muted = page.evaluate("() => kept().map(p => !!(p.mix && p.mix.effects && p.mix.effects.mute))")
    assert muted[:3] == [True, False, True] and page.evaluate("() => kept().length") == n     # Delete mutes, nothing is removed
    # a quieter part
    page.mouse.click(tl["x"] + xs[1], lane["y"] + 16)
    page.fill("#right input[aria-label='Loudness of the chosen parts']", "50")
    page.dispatch_event("#right input[aria-label='Loudness of the chosen parts']", "change")
    assert page.evaluate("() => kept()[1].mix.effects.volume") == 0.5
    # cut it yourself: S splits at the playhead (the video section too)
    page.evaluate("() => seek(layout()[1].out0 + 5)")
    page.keyboard.press("s")
    assert page.evaluate("() => kept().length") == n + 1
    assert page.evaluate("() => kept()[1].mix.effects.volume") == 0.5 and page.evaluate("() => kept()[2].mix.effects.volume") == 0.5
    # right-click a part
    page.mouse.click(tl["x"] + xs[0], lane["y"] + 16, button="right")
    assert page.locator(".menu.ctx", has_text="Choose the whole Effects track").count() == 1
    page.keyboard.press("Escape")
    page.evaluate("() => saveNow()")
    saved = live.call("GET", f"/api/projects/{pid}")["project"]
    assert saved["pieces"][0]["mix"]["music"]["mute"] and saved["pieces"][0]["mix"]["effects"]["mute"]
    assert page.errors == []


def test_number_boxes_are_empty_when_the_chosen_sections_differ(live, page, split_movie):
    open_split(live, page, split_movie, "Mixed", interval=30)
    page.evaluate("() => { const K = kept(); K[0].place = { x: 0.2, y: 0.1, scale: 1, rotate: 0 }; K[1].place = { x: -0.3, y: 0.1, scale: 1, rotate: 0 }; refreshAll({ keepVideo: true }); }")
    page.click(".ftabs button[data-panel=frame]")
    page.locator("#laneV .clipb").nth(0).click()
    page.keyboard.press("Control+a")
    xbox = page.locator("#framePanel input.inp[aria-label=X]")
    assert xbox.input_value() == "" and xbox.get_attribute("placeholder") == "—"
    assert page.locator("#framePanel input.inp[aria-label=Size]").input_value() == "100"   # the same everywhere: shown
    # a typed Y goes to all; their own X stays
    page.fill("#framePanel input[aria-label=Y]", "0"); page.keyboard.press("Enter")
    places = page.evaluate("() => kept().map(p => p.place)")
    assert all(p["y"] == 0 for p in places)
    assert places[0]["x"] == 0.2 and places[1]["x"] == -0.3
    assert page.errors == []


def test_a_new_shape_starts_with_soft_edges_and_260_percent_in_9_16(live, page, split_movie):
    open_split(live, page, split_movie, "Defaults", interval=0)
    page.click(".ftabs button[data-panel=frame]")
    page.click("#framePanel .ratio:has-text('9:16')")
    fr = page.evaluate("() => S.proj.settings.frame")
    assert fr["ratio"] == "9:16" and fr["edge"] == 17 and fr["scale"] == 2.6 and fr["blur"] == 50
    page.click("#framePanel .ratio:has-text('1:1')")                 # changing shape later keeps what you set
    fr = page.evaluate("() => S.proj.settings.frame")
    assert fr["edge"] == 17 and fr["scale"] == 2.6
    assert page.errors == []


def test_scroll_lock_one_track_group_and_normalise(live, page, split_movie):
    pid = open_split(live, page, split_movie, "Design")
    page.wait_for_selector("#laneStems .lane.stem", timeout=30000)
    # the wheel over the tracks scrolls them up and down when they do not all fit
    page.set_viewport_size({"width": 1366, "height": 640})
    page.wait_for_timeout(300)
    sc = page.query_selector("#tlScroll").bounding_box()
    tall = page.evaluate("() => $('tlScroll').scrollHeight > $('tlScroll').clientHeight + 2")
    if tall:
        page.mouse.move(sc["x"] + 400, sc["y"] + 60)
        page.mouse.wheel(0, 120)
        page.wait_for_timeout(200)
        assert page.evaluate("() => $('tlScroll').scrollTop") > 0
        assert page.evaluate("() => $('tlScroll').scrollLeft") == 0
    page.set_viewport_size({"width": 1366, "height": 768})
    # lock only the Music track: Voices can still change
    page.click("#laneStems .stem-head[data-layer=music] .lock-btn")
    assert page.evaluate("() => S.proj.settings.locks.music") is True and page.evaluate("() => S.proj.settings.locks.voices") is False
    page.click("#laneStems .stem-head[data-layer=music]")
    page.keyboard.press("Delete")
    assert page.evaluate("() => kept().some(p => p.mix && p.mix.music)") is False
    page.wait_for_selector(".toast:has-text('Music track is locked')")
    page.click("#laneStems .stem-head[data-layer=voices]")
    page.keyboard.press("Delete")
    assert page.evaluate("() => kept().every(p => p.mix && p.mix.voices.mute)")
    page.keyboard.press("Control+z")
    page.click("#laneStems .stem-head[data-layer=music] .lock-btn")
    # group the first two Effects parts, lock the group
    page.eval_on_selector("#laneStems .lane.stem[data-layer=effects]", "e => e.scrollIntoView({ block: 'nearest' })")
    lane = page.query_selector("#laneStems .lane.stem[data-layer=effects]").bounding_box()
    tl = page.query_selector("#tlScroll").bounding_box()
    xs = page.evaluate("() => layout().slice(0, 2).map(r => px((r.out0 + r.out1) / 2) - $('tlScroll').scrollLeft)")
    page.mouse.click(tl["x"] + xs[0], lane["y"] + 16)
    page.keyboard.down("Control"); page.mouse.click(tl["x"] + xs[1], lane["y"] + 16); page.keyboard.up("Control")
    page.click("#right button:has-text('Group these parts')")
    page.fill(".dialog input", "Shots")
    page.click(".dialog button:has-text('OK')")
    assert page.evaluate("() => S.proj.settings.sound_groups.map(g => g.name)") == ["Shots"]
    assert page.evaluate("() => kept().slice(0, 2).every(p => p.mix.effects.group === S.proj.settings.sound_groups[0].id)")
    page.click("#right .grp-now button:has-text('Lock')")
    page.keyboard.press("Delete")
    assert page.evaluate("() => kept().slice(0, 2).some(p => p.mix.effects.mute)") is False         # a locked group stays
    # choose the group again from the list (click away first)
    page.click("#laneStems .stem-head[data-layer=voices]")
    page.keyboard.press("Escape")
    page.evaluate("() => { S.asel = new Map(); refreshAll({ keepVideo: true }); }")
    page.click("#right .grp-name:has-text('Shots')")
    assert page.evaluate("() => aselList().length") == 2
    # Normalise the whole Music track: the quiet tone (about -21 dB) is brought up, never over 200 %
    page.click("#laneStems .stem-head[data-layer=music]")
    page.click("#right button:has-text('Same loudness')")
    page.wait_for_function("() => kept().every(p => p.mix && p.mix.music && p.mix.music.volume > 1.2)", timeout=30000)
    assert page.evaluate("() => kept().every(p => p.mix.music.volume <= 2)")
    page.evaluate("() => saveNow()")
    saved = live.call("GET", f"/api/projects/{pid}")["project"]
    assert saved["settings"]["sound_groups"][0]["locked"] is True and saved["pieces"][0]["mix"]["music"]["volume"] > 1.2
    assert page.errors == []


def test_music_track_parts_normalise_and_going_down_under_voices(live, page, split_movie, tmp_path):
    from tools.make_samples import run
    song = tmp_path / "Song.wav"
    run(["-f", "lavfi", "-i", "sine=frequency=500:duration=60", "-af", "volume=0.2", str(song)])
    mid = live.upload(str(song))
    pid = open_split(live, page, split_movie, "Music parts")
    page.evaluate("(id) => { S.proj.settings.layers = [{ file: id, volume: 0.5, mute: false, solo: false }]; scheduleSave(); loadFiles(); refreshAll({ keepVideo: true }); }", mid)
    page.wait_for_selector("#laneM .mpart")
    page.eval_on_selector("#laneM", "e => e.scrollIntoView({ block: 'nearest' })")
    page.locator("#laneM .mpart").first.click(position={"x": 40, "y": 12})
    assert page.evaluate("() => S.msel && [...S.msel.ks]") == [0]
    assert "Song" in page.inner_text("#right .side-h h2")
    # cut the music (only the music: the video sections stay as they are), then mute the first part with Delete
    n = page.evaluate("() => kept().length")
    page.evaluate("() => seek(7)")
    page.keyboard.press("s")
    assert page.evaluate("() => S.proj.settings.layers[0].parts.map(p => p.end)") == [7, None]
    assert page.evaluate("() => kept().length") == n
    assert page.locator("#laneM .mpart").count() == 2
    page.locator("#laneM .mpart").nth(0).click()
    page.keyboard.press("Delete")
    assert page.evaluate("() => S.proj.settings.layers[0].parts.map(p => p.mute)") == [True, False]
    assert page.locator("#laneM .mpart.muted").count() == 1
    # Normalise the second part: the quiet song is brought up
    page.locator("#laneM .mpart").nth(1).click()
    page.click("#right button:has-text('Same loudness')")
    page.wait_for_function("() => S.proj.settings.layers[0].parts[1].volume > 1.2", timeout=30000)
    # the whole track can go up to 200 %
    page.fill("#right input[aria-label='Loudness of the whole music track']", "200")
    page.dispatch_event("#right input[aria-label='Loudness of the whole music track']", "change")
    assert page.evaluate("() => S.proj.settings.layers[0].volume") == 2
    # going down under voices: the voices come from the split Voices track and show as dips on the music
    page.click("#right input[aria-label='Go down while people talk']")
    page.wait_for_selector("#laneM .duckz", timeout=30000)
    assert page.evaluate("() => S.voice.from") == "voices"
    assert page.evaluate("() => S.proj.settings.layers[0].duck") == {"on": True, "level": 0.3}
    assert abs(page.evaluate("() => duckGain(S.proj.settings.layers[0], 20)") - 0.3) < 0.01
    # right-click a music part
    page.locator("#laneM .mpart").nth(1).click(button="right")
    assert page.locator(".menu.ctx", has_text="Cut the music here").count() == 1
    page.keyboard.press("Escape")
    # lock: nothing changes any more
    page.click("#laneM .lane-head .lock-btn")
    page.locator("#laneM .mpart").nth(1).click()
    page.keyboard.press("Delete")
    assert page.evaluate("() => S.proj.settings.layers[0].parts[1].mute") is False
    page.evaluate("() => saveNow()")
    saved = live.call("GET", f"/api/projects/{pid}")["project"]["settings"]["layers"][0]
    assert saved["parts"][0]["mute"] is True and saved["duck"]["on"] is True and saved["locked"] is True
    assert page.errors == []


def test_what_separate_again_found_is_its_own_track(live, page, split_movie):
    from tools.make_samples import run
    src = live.state.resolve_input(split_movie)
    store = SP.SplitStore(live.state.home)
    base = store.folder(file_fingerprint(src), 0.0, 182.0)
    d = base.parent / (base.name + "~20260101000000")
    d.mkdir(exist_ok=True)
    import shutil, json
    for name in ("voices", "music", "effects"):
        shutil.copyfile(base / (name + ".flac"), d / (name + ".flac"))
    run(["-f", "lavfi", "-i", "sine=frequency=700:duration=182", "-ar", "16000", "-c:a", "flac", str(d / "found.flac")])
    (d / "split.json").write_text(json.dumps({"model": SP.MODEL_ID, "start": 0.0, "end": 182.0, "derived": True, "found_from": ["music"]}))
    pid = open_split(live, page, split_movie, "Found")
    page.wait_for_selector("#laneStems .lane.stem", timeout=30000)
    page.evaluate("(id) => { S.proj.settings.mix_split = id; Layers.refresh(); }", file_fingerprint(src) + "/" + d.name)
    page.wait_for_selector("#laneStems .lane.stem[data-layer=found]", timeout=30000)
    assert page.eval_on_selector_all("#laneStems .stem-head span", "els => els.map(e => e.textContent)") == ["Voices", "Music", "Effects", "Found again (from Music)"]
    page.wait_for_function("() => S.stemPeaks.found && S.stemPeaks.found.length > 1000", timeout=30000)
    page.click("#laneStems .stem-head[data-layer=found]")
    page.click("#right input[aria-label='Mute the chosen parts']")
    assert page.evaluate("() => kept().every(p => p.mix.found.mute)")
    assert page.query_selector("#right button:has-text('Separate again')") is None
    page.evaluate("() => saveNow()")
    saved = live.call("GET", f"/api/projects/{pid}")["project"]
    assert saved["pieces"][0]["mix"]["found"]["mute"] is True
    assert page.errors == []
    shutil.rmtree(d, ignore_errors=True)


def test_even_out_fades_auto_level_and_the_sound_check(live, page, split_movie, tmp_path):
    from tools.make_samples import run
    song = tmp_path / "Song2.wav"
    run(["-f", "lavfi", "-i", "sine=frequency=500:duration=60", "-af", "volume='if(between(t,20,30),0.9,0.15)':eval=frame", str(song)])
    mid = live.upload(str(song))
    pid = open_split(live, page, split_movie, "Even out")
    page.wait_for_selector("#laneStems .lane.stem", timeout=30000)
    # a split track: Even out and fades for the whole Music track
    page.click("#laneStems .stem-head[data-layer=music]")
    page.click("#right .even-field .seg button:has-text('Gentle')")
    assert page.evaluate("() => kept().every(p => p.mix.music.even === 1)")
    page.fill("#right input[aria-label='Fade in']", "1.5")
    page.dispatch_event("#right input[aria-label='Fade in']", "change")
    assert page.evaluate("() => kept().every(p => p.mix.music.fin === 1.5)")
    assert page.get_attribute("#right input[aria-label='Loudness of the chosen parts']", "step") == "1"
    page.wait_for_function("() => [...S.envs.values()].some(v => Array.isArray(v))", timeout=30000)
    # music added now gets Auto level by itself; parts can be evened out or set off on their own
    page.evaluate("(id) => { change(() => { S.proj.settings.layers = layers().concat([{ file: id, volume: 0.5, mute: false, solo: false, auto: 1 }]); }, { keepVideo: true }); loadFiles(); }", mid)
    page.wait_for_selector("#laneM .mpart")
    page.locator("#laneM .mpart").first.click(position={"x": 30, "y": 12})
    assert "evened" in page.inner_text("#laneM .mpart")
    page.click("#right .track-box .seg button:has-text('Strong')")
    assert page.evaluate("() => S.proj.settings.layers[0].auto") == 2
    page.locator("#laneM .mpart").first.click(position={"x": 30, "y": 12})
    page.click("#right .pad:not(.track-box) .even-field .seg button:has-text('Off')")
    assert page.evaluate("() => S.proj.settings.layers[0].parts[0].even") == 0
    page.fill("#right input[aria-label='Song fades out']", "3")
    page.dispatch_event("#right input[aria-label='Song fades out']", "change")
    assert page.evaluate("() => S.proj.settings.layers[0].fade_out") == 3
    page.keyboard.press("Escape")
    # the sound check: a quick version, measured; the Loudness strip shows; one button evens out the problem spots
    page.click(".ftabs button[data-panel=sound]")
    page.click("#checkMix")
    page.wait_for_selector("#mixCheck .check-nums", timeout=240000)
    assert "LUFS" in page.inner_text("#mixCheck")
    assert page.is_visible("#laneL") and page.evaluate("() => S.check.points.length") > 20
    if page.evaluate("() => S.check.problems.length"):
        page.click("#mixCheck button:has-text('Even out the problem spots')")
    page.evaluate("() => saveNow()")
    saved = live.call("GET", f"/api/projects/{pid}")["project"]
    assert saved["pieces"][0]["mix"]["music"]["even"] == 1 and saved["settings"]["layers"][0]["auto"] == 2
    assert page.errors == []
