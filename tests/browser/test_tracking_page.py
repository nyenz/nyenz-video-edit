"""1.39, Final in a real browser: tracking in a tall shape (Format: Tracking) and with a frame (Picture: Track every
section). A stop sign moves from left to right; the detector knows stop signs, so the view must follow it."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from editforge.analysis import subjects as SU

MODEL = Path.home() / ".editforge" / "models" / SU.MODEL["name"]
pytestmark = pytest.mark.skipif(not MODEL.is_file(), reason="the tracking model is not on this computer")


@pytest.fixture(scope="module")
def stop_id(live, tmp_path_factory):
    pytest.importorskip("PIL.Image")
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from test_tracking import _stop_sign_video
    models = Path(live.state.home) / "models"
    models.mkdir(parents=True, exist_ok=True)
    if not (models / SU.MODEL["name"]).exists():
        shutil.copyfile(MODEL, models / SU.MODEL["name"])
    p = tmp_path_factory.mktemp("stop") / "Moving stop sign.mp4"
    _stop_sign_video(p)
    return live.upload(str(p))


def open_final(live, page, fid, name):
    pid = live.call("POST", "/api/projects", {"source": fid, "name": name, "stage": "final", "interval": 0})["project"]["id"]
    page.goto(f"{live.base}/final?p={pid}")
    page.wait_for_function("() => typeof S !== 'undefined' && S.proj && S.info && document.querySelector('#laneV .clipb')", timeout=30000)
    return pid


def test_a_tracking_shape_follows_in_the_player(live, page, stop_id):
    pid = open_final(live, page, stop_id, "Track shape")
    page.click(".ftabs button[data-panel=frame]")
    page.evaluate("() => { document.getElementById('shapeCards').closest('details').open = true; setShape('vertical', 'follow'); }")
    page.wait_for_selector("#shapeFill .follow-box")
    assert "Tracking is on in the shape below" in page.inner_text("#trackPanel")
    page.wait_for_function("() => S.subj && S.subj.state === 'done'", timeout=120000)
    assert "Ready" in page.inner_text("#followNote")
    path = page.evaluate("() => S.subj.paths[0]")
    assert path[0][1] < 0.35 and path[-1][1] > 0.6
    # the player's view slides with it
    page.evaluate("() => { seek(0.3); }")
    page.wait_for_timeout(300)
    page.evaluate("() => followView(active(), V.seg.p)")
    left = float(page.evaluate("() => parseFloat(active().style.objectPosition)"))
    page.evaluate("() => { seek(5.6); }")
    page.wait_for_timeout(300)
    page.evaluate("() => { active().currentTime = 5.6; followView(active(), V.seg.p); }")
    right = float(page.evaluate("() => parseFloat(active().style.objectPosition)"))
    assert left < 30 and right > 60, (left, right)
    page.click("#shapeFill .follow-box .seg button:has-text('Lively')")
    page.evaluate("() => saveNow()")
    st = live.call("GET", f"/api/projects/{pid}")["project"]["settings"]
    assert st["shape"] == "vertical_follow" and st["follow_feel"] == "lively"
    assert page.errors == []


def test_track_every_section_with_a_frame(live, page, stop_id):
    pid = open_final(live, page, stop_id, "Track frame")
    page.click(".ftabs button[data-panel=frame]")
    page.click("#trackPanel button:has-text('Make it 9:16 and track')")
    page.wait_for_function("() => kept()[0].place && kept()[0].place.track && kept()[0].place.track.auto", timeout=120000)
    tr = page.evaluate("() => kept()[0].place.track")
    assert tr["path"][0][1] > 0.5 and tr["path"][-1][1] < -0.5        # the picture moves right, then left, so the sign stays in the middle
    assert page.evaluate("() => Frame.full(S.proj.settings.frame).scale") > 3   # zoomed to fill the tall frame
    page.evaluate("() => saveNow()")
    saved = live.call("GET", f"/api/projects/{pid}")["project"]["pieces"][0]["place"]["track"]
    assert saved["auto"] is True and len(saved["path"]) >= 2
    page.wait_for_selector("#trackPanel .follow-box button:has-text('Track again')")
    assert "1 of 1" in page.inner_text("#trackPanel .follow-box")
    assert page.errors == []
