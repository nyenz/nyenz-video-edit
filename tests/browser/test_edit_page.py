"""Stage 2, the Edit page, in a real browser: the three buttons, the versions, and the way on to Final."""

from __future__ import annotations

import pytest


@pytest.fixture(scope="module")
def movie_id(live, movie):
    return live.upload(movie)


def open_edit(live, page, source_id, name="Clip 01"):
    pid = live.call("POST", "/api/projects", {"source": source_id, "name": name})["project"]["id"]
    page.goto(f"{live.base}/edit?p={pid}")
    wait_ready(page)
    return pid


def wait_ready(page):
    page.wait_for_function("() => typeof S !== 'undefined' && S.proj && S.info && document.querySelector('#tlInner .seg, #laneV .seg, #laneV > *')", timeout=30000)


def test_edit_stage_shows_only_the_edit_tools(live, page, movie_id):
    open_edit(live, page, movie_id)
    rail = page.eval_on_selector_all(".rail button:not([hidden])", "els => els.map(e => e.dataset.panel)")
    assert rail == ["sections", "media", "cut", "pattern"]
    for gone in ("audio", "sound", "format", "frame", "text"):
        assert page.query_selector(f".rail button[data-panel={gone}]").is_hidden()
    top = page.eval_on_selector_all("header.top button", "els => els.map(e => e.textContent.trim())")
    assert any("Send to Final" in t for t in top) and not any(t.startswith("Export") and "Exports" not in t for t in top)
    assert page.eval_on_selector("#secVersions", "e => e.offsetParent !== null")
    assert page.errors == []


def test_the_three_buttons_in_order(live, page, movie_id):
    pid = open_edit(live, page, movie_id)
    # 1: Odd and Even versions, named from the clip
    page.click("#secVersions")
    page.wait_for_function("() => document.querySelectorAll('#secVersionList .item').length === 3", timeout=20000)
    names = page.eval_on_selector_all("#secVersionList .item b", "els => els.map(e => e.textContent)")
    assert names == ["Clip 01", "Clip 01 - Odd", "Clip 01 - Even"] or sorted(names) == sorted(["Clip 01", "Clip 01 - Odd", "Clip 01 - Even"])
    page.click("#secVersionList .item:has-text('Clip 01 - Odd')")
    page.wait_for_url(lambda u: "p=" in u and pid not in u, timeout=15000)
    wait_ready(page)
    assert page.evaluate("() => S.proj.version") == "odd"
    n_odd = page.evaluate("() => S.proj.pieces.length")
    dur = page.evaluate("() => S.info.duration")
    assert n_odd == -(-int(-(-dur // 2)) // 2) or abs(n_odd - dur / 4) < 1.01              # sections 1, 3, 5 ... of a 2 s cut
    # 2: thin out the open version: 1 s sections, every 4th out
    page.click("#secThin")
    page.wait_for_function("() => S.proj.steps.length === 1", timeout=20000)
    gone = page.evaluate("() => S.proj.pieces.filter(p => p.off).length")
    total = page.evaluate("() => S.proj.pieces.length")
    assert abs(total - dur / 2) < 2.01 and gone == total // 4                        # 1 s sections, the 4th, 8th ... out
    assert page.evaluate("() => kept().length") == total - gone
    # Ctrl+Z takes it back
    page.keyboard.press("Control+z")
    page.wait_for_function("(n) => S.proj.steps.length === 0 && S.proj.pieces.length === n", arg=n_odd, timeout=10000)
    page.click("#secThin")
    page.wait_for_function("() => S.proj.steps.length === 1", timeout=20000)
    # 3: separate scenes in the video as it is now: the movie has 9 colours
    page.click("#secScenes")
    page.wait_for_function("() => /scenes? found/.test(document.getElementById('secNote').textContent)", timeout=90000)
    scenes = page.evaluate("() => new Set(kept().map(p => p.unit)).size")
    assert scenes == 9
    assert "9 scenes found" in page.inner_text("#secNote")
    # the work is saved: reload and it is all still there
    page.evaluate("() => saveNow()")
    page.reload()
    wait_ready(page)
    assert page.evaluate("() => new Set(kept().map(p => p.unit)).size") == 9
    assert page.errors == []


def test_send_to_final_opens_the_final_stage_with_the_sound_and_picture_tools(live, page, movie_id):
    open_edit(live, page, movie_id, "Clip 02")
    page.click("header.top >> text=Send to Final")
    page.wait_for_url("**/final?p=*", timeout=15000)
    wait_ready(page)
    assert page.evaluate("() => S.mode") == "final" and page.evaluate("() => S.proj.stage") == "final"
    rail = page.eval_on_selector_all(".rail button:not([hidden])", "els => els.map(e => e.dataset.panel)")
    assert rail == ["media", "cut", "audio", "sound", "format", "frame", "text"]
    top = page.eval_on_selector_all("header.top button", "els => els.map(e => e.textContent.trim())")
    assert any(t.startswith("Export") and "Exports" not in t for t in top)
    # an Edit page for a Final project goes to the Final page by itself
    pid = page.evaluate("() => S.id")
    page.goto(f"{live.base}/edit?p={pid}")
    page.wait_for_url("**/final?p=*", timeout=10000)
    assert page.errors == []
