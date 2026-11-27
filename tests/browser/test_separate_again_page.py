"""1.37, Final in a real browser: Separate again with a choice of what to pull out, its options, and after it: listen to
what was taken out, go back to the version before, or go again, stronger."""

from __future__ import annotations

import numpy as np
import pytest

from editforge.core.fingerprint import file_fingerprint
from editforge import splitter as SP


@pytest.fixture(scope="module")
def sep_movie(live, movie, tmp_path_factory):
    from tools.make_samples import run
    copy = tmp_path_factory.mktemp("sep") / "Separate movie.mp4"
    data = bytearray(open(movie, "rb").read())
    copy.write_bytes(bytes(data))
    fid = live.upload(str(copy))
    src = live.state.resolve_input(fid)
    store = SP.SplitStore(live.state.home)
    folder = store.folder(file_fingerprint(src), 0.0, 182.0)
    folder.mkdir(parents=True, exist_ok=True)
    for name, hz in (("voices", 300), ("music", 1000), ("effects", 3000)):
        run(["-f", "lavfi", "-i", f"sine=frequency={hz}:duration=182", "-ar", "44100", "-ac", "2", "-c:a", "flac", str(folder / (name + ".flac"))])
    store.write_meta(folder, 0.0, 182.0, 1.0, "fast")
    sp = live.state.splitter
    was = (sp.engine_factory, sp.__dict__.get("model_ready"))
    sp.engine_factory = lambda path: (lambda chunk, fast=True: np.stack([chunk * 0.5, chunk * 0.3, chunk * 0.2]))   # a pretend model
    sp.model_ready = lambda: True
    yield fid
    sp.engine_factory = was[0]
    if was[1] is None:
        del sp.model_ready
    else:
        sp.model_ready = was[1]


def test_pull_effects_out_of_music_then_listen_go_back_and_again(live, page, sep_movie):
    pid = live.call("POST", "/api/projects", {"source": sep_movie, "name": "Separate", "stage": "final", "interval": 20})["project"]["id"]
    page.goto(f"{live.base}/final?p={pid}")
    page.wait_for_function("() => typeof S !== 'undefined' && S.proj && S.info && document.querySelector('#laneV .clipb')", timeout=30000)
    page.wait_for_selector("#laneStems .lane.stem", timeout=30000)
    first = page.evaluate("() => S.proj.settings.mix_split")
    page.evaluate("() => { S.sel.clear(); S.asel = new Map(); aselSet(kept()[1], 'music', true); refreshAll({ keepVideo: true }); }")
    box = "#right .sep-box"
    labels = page.eval_on_selector_all(box + " .sep-pulls button span", "els => els.map(e => e.textContent)")
    assert labels == ["Pull out voices", "Pull out effects"]
    page.click(box + " .seg button:has-text('Fast')")
    page.click(box + " .seg button:has-text('Aggressive')")
    page.click(box + " button:has-text('Pull out effects')")
    page.wait_for_function("(f) => S.proj.settings.mix_split !== f", arg=first, timeout=90000)
    page.wait_for_function("() => Layers.split() && Layers.split().last", timeout=30000)
    page.evaluate("() => { S.sel.clear(); S.asel = new Map(); aselSet(kept()[1], 'music', true); refreshAll({ keepVideo: true }); }")
    page.wait_for_selector(box + " .sep-last")
    assert "Effects pulled out of Music (fast, aggressive)" in page.inner_text(box + " .sep-last")
    page.click(box + " button:has-text('Listen to what was taken out')")
    page.wait_for_function("() => REMOVED && !REMOVED.paused", timeout=20000)
    page.click(box + " button:has-text('Stop')")
    page.click(box + " button:has-text('Back to the version before')")
    page.wait_for_function("(f) => S.proj.settings.mix_split === f", arg=first)
    page.evaluate("() => saveNow()")
    assert live.call("GET", f"/api/projects/{pid}")["project"]["settings"]["mix_split"] == first
    # the right-click menu has it too, as a sub-menu
    page.evaluate("() => { S.sel.clear(); S.asel = new Map(); aselSet(kept()[1], 'music', true); refreshAll({ keepVideo: true }); }")
    page.eval_on_selector("#laneStems .lane.stem[data-layer=music]", "e => e.scrollIntoView({ block: 'nearest' })")
    lane = page.query_selector("#laneStems .lane.stem[data-layer=music]").bounding_box()
    tl = page.query_selector("#tlScroll").bounding_box()
    x1 = page.evaluate("() => px((layout()[1].out0 + layout()[1].out1) / 2) - $('tlScroll').scrollLeft")
    page.mouse.click(tl["x"] + x1, lane["y"] + 16, button="right")
    page.hover(".menu.ctx:not(.sub) div[role=menuitem]:has-text('Separate again')")
    assert page.locator(".menu.ctx.sub div[role=menuitem]").all_inner_texts() == ["Pull out voices", "Pull out effects"]
    page.keyboard.press("Escape")
    assert page.errors == []
