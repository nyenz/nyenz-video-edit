"""1.28: zoom in to single frames, scene-change marks and jumps, finding scene changes inside a section and cutting on the
exact frame, and Track (the picture moves with a tracked thing) in Final."""

from __future__ import annotations

import time

import pytest

from test_final_page import open_final


@pytest.fixture(scope="module")
def movie_id(live, movie):
    mid = live.upload(movie)
    live.call("POST", "/api/scenes", {"id": mid})                   # the scene changes of the movie (every 20 s)
    end = time.time() + 120
    while time.time() < end and live.call("GET", f"/api/scenes?id={mid}")["state"] != "ready":
        time.sleep(0.5)
    return mid


def test_deep_zoom_frames_scene_marks_and_cutting_on_the_exact_frame(live, page, movie_id):
    pid = open_final(live, page, movie_id, "Zoom deep")
    page.wait_for_function("() => S.cuts && S.cuts.length >= 7", timeout=30000)
    assert page.locator("#ruler .scut").count() >= 1 or page.evaluate("() => cutMarks().length") >= 7
    # [ and ] jump between scene changes
    page.evaluate("() => seek(1)")
    page.click("#tlScroll", position={"x": 5, "y": 5})
    page.keyboard.press("]")
    assert abs(page.evaluate("() => S.t") - 20.0) < 0.1
    page.keyboard.press("]")
    assert abs(page.evaluate("() => S.t") - 40.0) < 0.1
    page.keyboard.press("[")
    assert abs(page.evaluate("() => S.t") - 20.0) < 0.1
    # all the way in: every frame is its own exact picture, and the ruler shows frames
    page.evaluate("() => { const z = document.getElementById('zoom'); z.value = '100'; z.dispatchEvent(new Event('input')); }")
    page.wait_for_timeout(200)
    assert page.evaluate("() => S.pps") > 3000
    page.evaluate("() => scrollToPlayhead()")
    page.wait_for_selector("#laneV .strip.frames img")
    assert page.evaluate("() => [...document.querySelectorAll('#laneV .strip.frames img')].every(i => (i.src || i.dataset.src || '').includes('exact=1'))")
    page.wait_for_function("() => [...document.querySelectorAll('#laneV .strip.frames img')].some(i => i.src && i.complete && i.naturalWidth > 0)", timeout=30000)
    assert page.locator("#ruler i.fr").count() > 5
    # the whole movie as one section: find the scene changes inside it, each on its exact frame
    page.evaluate("() => fitZoom()")
    n0 = page.evaluate("() => kept().length")
    page.evaluate("() => { S.sel = new Set([kept()[0]]); findCutsIn(kept()[0]); }")
    page.wait_for_function(f"() => kept().length > {n0}", timeout=60000)
    starts = page.evaluate("() => kept().map(p => p.start)")
    assert any(abs(s - 20.0) < 0.05 for s in starts) and any(abs(s - 40.0) < 0.05 for s in starts)
    # cut on the exact picture change near a moment (the first piece is 0..20 when the project was cut every 4 s? use a join-free spot)
    page.evaluate("() => { change(() => { S.proj.pieces = [Object.assign(clone(kept()[0]), { start: 50, end: 70 })]; }); }")
    page.evaluate("() => cutExact(layout()[0].out0 + 10.3)")                        # 60.3 s in the movie: the change is at 60.0
    page.wait_for_function("() => kept().length === 2", timeout=30000)
    assert abs(page.evaluate("() => kept()[1].start") - 60.0) < 0.05
    # the right-click menu offers both
    page.evaluate("() => seek(layout()[0].out0 + 1)")
    box = page.query_selector("#laneV .clipb").bounding_box()
    page.mouse.click(box["x"] + 20, box["y"] + box["height"] / 2, button="right")
    menu = page.locator(".menu.ctx").inner_text()
    assert "Find scene changes in this section" in menu and "exact picture change" in menu
    page.keyboard.press("Escape")
    assert page.errors == []


def test_track_moves_the_picture_with_the_thing(live, page, movie_id):
    pid = open_final(live, page, movie_id, "Track")
    page.evaluate("() => { change(() => { S.proj.settings.frame = Object.assign(Frame.full(S.proj.settings.frame), { ratio: '9:16', scale: 2.6 }); }, { keepVideo: true }); }")
    page.wait_for_function("() => Frame.active(S.proj.settings.frame)")
    # the tracker answers with a thing that moves from the left (0.2) to the right (0.8) of the picture
    page.route("**/api/track", lambda route: route.fulfill(status=200, content_type="application/json",
                                                       body='{"path": [[0, 0.2, 0.5], [2, 0.5, 0.5], [4, 0.8, 0.5]], "found": 0.97}'))
    page.evaluate("() => seek(1)")
    page.evaluate("() => startTrack(kept()[0])")
    page.wait_for_selector("#drawLayer:not([hidden])")
    b = page.query_selector("#drawLayer").bounding_box()
    page.mouse.move(b["x"] + b["width"] * 0.45, b["y"] + b["height"] * 0.45)
    page.mouse.down()
    page.mouse.move(b["x"] + b["width"] * 0.55, b["y"] + b["height"] * 0.55, steps=4)
    page.mouse.up()
    page.wait_for_function("() => kept()[0].place && kept()[0].place.track", timeout=10000)
    tr = page.evaluate("() => kept()[0].place.track")
    assert tr["found"] == 0.97 and tr["axes"] == "x" and len(tr["path"]) >= 2
    # moving right in the picture: the picture goes left (x falls)
    xs = [p[1] for p in tr["path"]]
    assert xs[0] > xs[-1]
    page.evaluate("() => { S.sel = new Set([kept()[0]]); refreshAll({ keepVideo: true }); }")
    page.wait_for_selector("#right .track-box:has-text('Tracking')")
    assert "97%" in page.inner_text("#right .track-box")
    page.click("#right .track-box .seg button:has-text('up–down')")
    assert page.evaluate("() => kept()[0].place.track.axes") == "xy"
    page.evaluate("() => saveNow()")
    saved = live.call("GET", f"/api/projects/{pid}")["project"]["pieces"][0]["place"]["track"]
    assert saved["axes"] == "xy" and len(saved["path"]) >= 2
    page.click("#right .track-box button:has-text('Stop tracking')")
    assert page.evaluate("() => !kept()[0].place.track")
    assert page.errors == []
