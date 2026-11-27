"""1.38, in a real browser: Back goes back on one kind of change (up to 5 steps each), keeps everything else, and is
still there after the page (or the app) is closed and opened again."""

from __future__ import annotations

import pytest


@pytest.fixture(scope="module")
def back_id(live, tmp_path_factory):
    from tools.make_samples import make_video
    p = make_video(str(tmp_path_factory.mktemp("back") / "back_test-video.1080p.mp4"), 60, "320x180", "25", "tone")
    return live.upload(p)


def test_back_goes_back_on_one_kind_and_survives_closing(live, page, back_id):
    pid = live.call("POST", "/api/projects", {"source": back_id, "stage": "final", "interval": 20})["project"]["id"]
    assert live.call("GET", f"/api/projects/{pid}")["project"]["name"] == "Back test video"       # the title from the file name
    page.goto(f"{live.base}/final?p={pid}")
    page.wait_for_function("() => typeof S !== 'undefined' && S.proj && S.info && document.querySelector('#laneV .clipb')", timeout=30000)
    page.evaluate("() => change(() => { kept()[0].volume = 0.4; }, { sound: true })")
    page.wait_for_timeout(1300)
    page.evaluate("() => change(() => { kept()[0].volume = 0.2; }, { sound: true })")
    page.evaluate("() => change(() => { kept()[1].tone = 'warm'; }, { sound: true })")
    page.evaluate("() => seek(30)")
    page.evaluate("() => splitAtPlayhead()")
    assert page.evaluate("() => kept().length") == 4
    page.click("#bBack")
    rows = page.eval_on_selector_all(".menu.ctx:not(.sub) div[role=menuitem] span", "els => els.map(e => e.textContent)")
    assert rows[0] == "Cuts" and set(rows) == {"Cuts", "Shape the sound", "Loudness"}
    page.hover(".menu.ctx:not(.sub) div[role=menuitem]:has-text('Loudness')")
    assert page.locator(".menu.ctx.sub div[role=menuitem]").count() == 2
    page.click(".menu.ctx.sub div[role=menuitem] >> nth=0")                 # before the last loudness change
    assert page.evaluate("() => kept()[0].volume") == 0.4
    assert page.evaluate("() => kept().length") == 4 and page.evaluate("() => kept()[1].tone") == "warm"   # the cut and the tone stay
    page.wait_for_timeout(1800)                                               # saved with the project
    page.reload()
    page.wait_for_function("() => typeof S !== 'undefined' && S.proj && S.hist && S.hist.Loudness", timeout=30000)
    page.click("#bBack")
    page.hover(".menu.ctx:not(.sub) div[role=menuitem]:has-text('Shape the sound')")
    page.click(".menu.ctx.sub div[role=menuitem] >> nth=0")
    assert page.evaluate("() => kept()[1].tone") is None
    # the right-click menu of a section has its own Back
    page.evaluate("() => { S.sel = new Set([kept()[0]]); refreshAll({ keepVideo: true }); }")
    box = page.query_selector("#laneV .clipb").bounding_box()
    page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2, button="right")
    page.hover(".menu.ctx:not(.sub) div[role=menuitem]:has-text('Back')")
    assert page.locator(".menu.ctx.sub div[role=menuitem]:has-text('Cuts')").count() == 1
    page.keyboard.press("Escape")
    assert page.errors == []
