"""1.40, Studio in a real browser: its own home tab and top-bar link, a Studio project opens on /studio with the Final
tools plus typed time, frame steps, In/Out remove (closing the gap), markers, J/K/L, colour looks and the new looks."""

from __future__ import annotations

import pytest


@pytest.fixture(scope="module")
def vid_id(live, tmp_path_factory):
    from tools.make_samples import make_video
    p = make_video(str(tmp_path_factory.mktemp("st") / "Holiday clip.mp4"), 20, "320x180", "25", "tone")
    return live.upload(p)


def open_studio(live, page, fid):
    pid = live.call("POST", "/api/projects", {"source": fid, "interval": 0, "stage": "studio"})["project"]["id"]
    page.goto(f"{live.base}/studio?p={pid}")
    page.wait_for_function("() => typeof S !== 'undefined' && S.proj && S.info && document.querySelector('#laneV .clipb')", timeout=30000)
    return pid


def test_studio_has_its_home_tab_and_link_and_opens_on_its_own_page(live, page, vid_id):
    pid = open_studio(live, page, vid_id)
    assert page.evaluate("() => S.studio && S.mode === 'final'") is True
    assert page.is_visible("#studioTools") and page.is_visible(".top .studio-link.on")
    assert page.evaluate("() => document.body.classList.contains('stage-studio')") is True
    page.goto(f"{live.base}/final?p={pid}")                       # the wrong page sends it to Studio
    page.wait_for_url("**/studio?p=" + pid, timeout=10000)
    page.goto(f"{live.base}/?phase=studio")
    page.wait_for_selector(".phase.studio.on", timeout=10000)
    page.wait_for_function("() => document.querySelector('main').innerText.includes('Holiday clip')", timeout=15000)
    assert page.errors == []


def test_typed_time_frames_in_out_remove_and_markers(live, page, vid_id):
    open_studio(live, page, vid_id)
    page.fill("#stTime", "0:05.00"); page.press("#stTime", "Enter")
    assert abs(page.evaluate("() => S.t") - 5) < 0.01
    page.keyboard.press(".")
    assert abs(page.evaluate("() => S.t") - 5.04) < 0.005
    page.keyboard.press(",")
    page.keyboard.press("i")
    page.evaluate("() => seek(8)")
    page.keyboard.press("o")
    assert page.is_visible("#stRipple") and "3.0" in page.inner_text("#stRippleT")
    page.evaluate("() => seek(12)")
    page.keyboard.press("m")                                        # a marker after the part that goes
    page.evaluate("() => seek(6)")
    page.keyboard.press("m")                                        # and one inside it
    assert page.inner_text("#stMarksN") == "2"
    page.click("#stRipple")
    total = page.evaluate("() => rawTotal()")
    assert abs(total - 17) < 0.05, total
    assert page.evaluate("() => kept().length") == 2
    assert page.evaluate("() => S.proj.settings.markers.map(m => m.t)") == [9]       # moved up 3 s, the inside one went
    page.evaluate("() => seek(0)")
    page.keyboard.press("Shift+M")
    assert abs(page.evaluate("() => S.t") - 9) < 0.01
    page.click("#stMarks")
    assert page.locator(".menu.ctx [role=menuitem]:has-text('Add a marker here')").count() == 1
    page.keyboard.press("Escape")
    page.keyboard.press("Control+z")
    assert abs(page.evaluate("() => rawTotal()") - 20) < 0.05
    page.keyboard.press("l")
    assert page.evaluate("() => S.playing") is True
    page.keyboard.press("k")
    assert page.evaluate("() => S.playing") is False
    page.evaluate("() => saveNow()")
    assert page.errors == []


def test_colour_looks_and_new_effects(live, page, vid_id):
    open_studio(live, page, vid_id)
    page.evaluate("() => { S.sel = new Set([kept()[0]]); renderInspector(); }")
    page.evaluate("() => { for (const d of document.querySelectorAll('#right details')) d.open = true; }")
    names = page.eval_on_selector_all("#right .color-presets button span", "els => els.map(e => e.textContent)")
    assert names == ["Natural", "Warm", "Cool", "Vivid", "Muted", "Film", "Bright", "B&W"]
    page.click("#right .color-presets button:has-text('Warm')")
    assert page.evaluate("() => kept()[0].color.warmth") == 0.45
    assert "sepia" in page.evaluate("() => active().style.filter")
    page.evaluate("() => { for (const d of document.querySelectorAll('#right details')) d.open = true; }")
    page.click("#right .looks button:has-text('Less grain')")
    page.click("#right .looks button:has-text('Steady shaky')")
    assert page.evaluate("() => kept()[0].fx") == ["denoise", "stabilize"]
    page.evaluate("() => saveNow()")
    assert page.errors == []
