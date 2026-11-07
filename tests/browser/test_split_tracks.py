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
