"""1.17, Final in a real browser: a section's own position (one, or all chosen with Ctrl + A and typed numbers),
soft edges of the video layer, the full-window Preview, and the sound track drawn under the video."""

from __future__ import annotations

import pytest

from test_final_page import open_final


@pytest.fixture(scope="module")
def movie_id(live, movie):
    return live.upload(movie)


def open_placed(live, page, movie_id, name):
    pid = live.call("POST", "/api/projects", {"source": movie_id, "name": name, "stage": "final", "interval": 4})["project"]["id"]
    page.goto(f"{live.base}/final?p={pid}")
    page.wait_for_function("() => typeof S !== 'undefined' && S.proj && S.info && document.querySelector('#laneV .clipb')", timeout=30000)
    return pid


def test_moving_the_picture_moves_only_the_section_showing(live, page, movie_id):
    """Like CapCut: no 'Position for' switch. A press on the picture chooses the section showing; moving changes only it.
    Ctrl + A on the timeline, then moving, changes all. Reset position puts it back in the middle, not turned."""
    pid = open_placed(live, page, movie_id, "Placed")
    page.click(".ftabs button[data-panel=frame]")
    page.wait_for_selector("#framePanel .nums4")
    assert "Position for" not in page.inner_text("#framePanel")
    n = page.evaluate("() => kept().length")
    assert n >= 3
    page.evaluate("() => seek(layout()[1].out0 + 0.5)")
    page.click("#frame")                                                 # chooses section 2
    page.fill("#framePanel .numf:has-text('Y') input", "-50"); page.keyboard.press("Enter")
    ys = page.evaluate("() => kept().map(p => p.place ? p.place.y : null)")
    assert ys[1] is not None and ys[1] < 0 and ys[0] is None and ys[2] is None
    # drag on the picture of section 3: only section 3 moves
    page.evaluate("() => seek(layout()[2].out0 + 0.5)")
    box = page.query_selector("#frame").bounding_box()
    cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    page.mouse.move(cx, cy); page.mouse.down(); page.mouse.move(cx + 40, cy, steps=5); page.mouse.up()
    xs = page.evaluate("() => kept().map(p => p.place ? p.place.x : null)")
    assert xs[2] is not None and xs[2] > 0.05 and (xs[1] or 0) == 0 and xs[0] is None
    assert page.evaluate("() => selList().map(p => kept().indexOf(p))") == [2]
    # Ctrl + A, then a typed X: every section gets it
    page.keyboard.press("Control+a")
    page.fill("#framePanel .numf:has-text('X') input", "-80"); page.keyboard.press("Enter")
    xs = page.evaluate("() => kept().map(p => p.place && p.place.x)")
    assert len(set(xs)) == 1 and xs[0] < 0
    # Reset position: all chosen go back to the middle, not turned (size stays)
    page.evaluate("() => { const f = Frame.full(effectiveFrame()); f.rotate = 30; f.scale = 1.5; storeFrame(f); }")
    page.click("#resetPlace")
    places = page.evaluate("() => kept().map(p => p.place)")
    assert all(p["x"] == 0 and p["y"] == 0 and p["rotate"] == 0 and p["scale"] == 1.5 for p in places)
    page.evaluate("() => saveNow()")
    saved = live.call("GET", f"/api/projects/{pid}")["project"]
    assert all(p.get("place") for p in saved["pieces"] if not p["off"])
    assert page.errors == []


def test_locked_tracks_cannot_be_changed_by_mistake(live, page, movie_id):
    pid = open_placed(live, page, movie_id, "Locked")
    n = page.evaluate("() => kept().length")
    page.click("#laneV .lane-head .lock-btn")
    assert page.evaluate("() => S.proj.settings.locks.video") is True
    page.locator("#laneV .clipb").nth(1).click()
    page.keyboard.press("Delete")
    page.evaluate("() => seek(layout()[0].out0 + 1)"); page.keyboard.press("s")
    assert page.evaluate("() => kept().length") == n                      # nothing removed or split
    page.wait_for_selector(".toast:has-text('video track is locked')")
    # the picture can still be placed on a locked track
    page.click(".ftabs button[data-panel=frame]")
    page.fill("#framePanel .numf:has-text('X') input", "30"); page.keyboard.press("Enter")
    assert page.evaluate("() => kept()[1].place.x") > 0                     # the chosen section (2)
    # the sound track: loudness and mute are locked
    page.wait_for_selector("#laneA .lane-head .lock-btn")
    page.click("#laneA .lane-head .lock-btn")
    page.locator("#laneV .clipb").nth(1).click()
    assert page.is_disabled("#right input[aria-label=Loudness]")
    page.evaluate("() => saveNow()")
    assert live.call("GET", f"/api/projects/{pid}")["project"]["settings"]["locks"] == {"video": True, "sound": True, "voices": False, "music": False, "effects": False}
    page.click("#laneV .lane-head .lock-btn")                             # unlock: Delete works again
    page.locator("#laneV .clipb").nth(1).click()
    page.keyboard.press("Delete")
    assert page.evaluate("() => kept().length") == n - 1
    assert page.errors == []


def test_preview_and_the_sound_track(live, page, movie_id):
    open_final(live, page, movie_id, "Preview me")
    # the sound track: a lane under the video, drawn once the sound is measured
    page.wait_for_function("() => S.peaks && S.peaks.length > 0", timeout=30000)
    assert page.is_visible("#laneA canvas.wave")
    lit = page.evaluate("""() => { const c = document.querySelector('#laneA canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
                         let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; }""")
    assert lit > 500
    # Preview: the full window, plays, Esc closes it
    page.click("#previewBtn")
    page.wait_for_selector("#pvBar")
    assert page.evaluate("() => document.body.classList.contains('previewing')")
    box = page.query_selector("#stage").bounding_box()
    assert box["height"] > 600
    page.wait_for_function("() => S.playing === true")
    page.keyboard.press("Escape")
    assert page.query_selector("#pvBar") is None and not page.evaluate("() => document.body.classList.contains('previewing')")
    page.keyboard.press("p")                                                           # P opens it too
    page.wait_for_selector("#pvBar")
    page.click("#pvBar button:has-text('Close')")
    assert page.query_selector("#pvBar") is None
    assert page.errors == []


def test_a_click_on_the_picture_chooses_the_section_showing_there(live, page, movie_id):
    open_placed(live, page, movie_id, "Pick")
    page.evaluate("() => seek(layout()[2].out0 + 0.5)")
    page.click("#frame")
    assert page.evaluate("() => selList().map(p => kept().indexOf(p))") == [2]
    page.evaluate("() => { pause(); seek(layout()[0].out0 + 0.5); }")
    page.click("#frame", modifiers=["Control"])                    # Ctrl adds it
    assert sorted(page.evaluate("() => selList().map(p => kept().indexOf(p))")) == [0, 2]
    page.evaluate("() => pause()")
    page.click(".ftabs button[data-panel=frame]")
    page.evaluate("() => seek(layout()[1].out0 + 0.5)")
    page.click("#frame")
    assert page.evaluate("() => selList().map(p => kept().indexOf(p))") == [1]
    assert page.evaluate("() => S.playing") is False                 # in Picture a click does not start playing
    assert page.errors == []
