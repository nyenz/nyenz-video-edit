"""1.17, Final in a real browser: a section's own position (one, or all chosen with Ctrl + A and typed numbers),
soft edges of the video layer, the full-window Preview, and the sound track drawn under the video."""

from __future__ import annotations

import pytest

from test_final_page import open_final


@pytest.fixture(scope="module")
def movie_id(live, movie):
    return live.upload(movie)


def test_position_of_one_section_or_all_chosen(live, page, movie_id):
    pid = live.call("POST", "/api/projects", {"source": movie_id, "name": "Placed", "stage": "final", "interval": 4})["project"]["id"]
    page.goto(f"{live.base}/final?p={pid}")
    page.wait_for_function("() => typeof S !== 'undefined' && S.proj && S.info && document.querySelector('#laneV .clipb')", timeout=30000)
    page.click(".ftabs button[data-panel=frame]")
    page.wait_for_selector("#framePanel .nums4")
    n = page.evaluate("() => kept().length")
    assert n >= 3
    # whole video: X moves everything (nothing has its own position)
    page.fill("#framePanel .numf:has-text('X') input", "100"); page.keyboard.press("Enter")
    assert page.evaluate("() => S.proj.settings.frame.x") > 0 and page.evaluate("() => kept().filter(p => p.place).length") == 0
    # one section: choose it, switch to Chosen sections, type Y
    page.locator("#laneV .clipb").nth(1).click()
    page.click("#framePanel button:has-text('Chosen sections')")
    page.fill("#framePanel .numf:has-text('Y') input", "-50"); page.keyboard.press("Enter")
    places = page.evaluate("() => kept().map(p => p.place ? Math.round(p.place.y * 1000) : null)")
    assert places[1] is not None and places[1] < 0 and places[0] is None and places[2] is None
    assert page.evaluate("() => S.proj.settings.frame.y") == 0                         # the whole video did not move
    # all sections: Ctrl + A, then type X: every section gets it
    page.locator("#laneV .clipb").nth(0).click()
    page.keyboard.press("Control+a")
    page.fill("#framePanel .numf:has-text('X') input", "-80"); page.keyboard.press("Enter")
    xs = page.evaluate("() => kept().map(p => p.place && p.place.x)")
    assert len(set(xs)) == 1 and xs[0] < 0
    # it is saved with the project, and soft edges too
    page.click("#framePanel button:has-text('Whole video')")
    page.evaluate("() => { const f = Frame.full(S.proj.settings.frame); f.edge = 40; storeFrame(f); }")
    page.evaluate("() => saveNow()")
    saved = live.call("GET", f"/api/projects/{pid}")["project"]
    assert all(p.get("place") for p in saved["pieces"] if not p["off"]) and saved["settings"]["frame"]["edge"] == 40
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
    pid = live.call("POST", "/api/projects", {"source": movie_id, "name": "Pick", "stage": "final", "interval": 4})["project"]["id"]
    page.goto(f"{live.base}/final?p={pid}")
    page.wait_for_function("() => typeof S !== 'undefined' && S.proj && S.info && document.querySelector('#laneV .clipb')", timeout=30000)
    page.evaluate("() => seek(layout()[2].out0 + 0.5)")
    page.click("#frame")
    assert page.evaluate("() => selList().map(p => kept().indexOf(p))") == [2]
    page.evaluate("() => { pause(); seek(layout()[0].out0 + 0.5); }")
    page.click("#frame", modifiers=["Control"])                    # Ctrl adds it
    assert sorted(page.evaluate("() => selList().map(p => kept().indexOf(p))")) == [0, 2]
    # in Picture, the press chooses it before you drag, and the panel counts it
    page.evaluate("() => pause()")
    page.click(".ftabs button[data-panel=frame]")
    page.click("#framePanel button:has-text('Chosen sections')")
    page.evaluate("() => seek(layout()[1].out0 + 0.5)")
    page.click("#frame")
    assert page.evaluate("() => selList().map(p => kept().indexOf(p))") == [1]
    assert "Chosen sections (1)" in page.inner_text("#framePanel")
    assert page.evaluate("() => S.playing") is False                 # in Picture a click does not start playing
    assert page.errors == []
