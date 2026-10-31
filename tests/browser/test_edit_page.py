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
    # its own screen: the four steps across the top, the versions on the left, no sound or picture tabs
    steps = page.eval_on_selector_all("#stepbar .stepcard", "els => els.map(e => e.querySelector('b').textContent)")
    assert steps == ["Odd / Even versions", "Remove every 4th second", "Separate scenes", "Send to Final"]
    assert page.is_visible("#stepbar") and page.is_visible(".edit-left") and page.is_hidden(".ftabs")
    for gone in ("sound", "frame", "text"):
        assert page.is_hidden(f'[data-for="{gone}"]')
    top = page.eval_on_selector_all("header.top button", "els => els.map(e => e.textContent.trim())")
    assert not any(t.startswith("Export") and "Exports" not in t for t in top)
    assert page.eval_on_selector("#secVersions", "e => e.offsetParent !== null")
    # the extra tools wait in dropdowns
    page.click("details[data-sec=pattern] > summary")
    page.wait_for_function("() => document.querySelectorAll('#patPicks button, #patPicks .chip').length > 0")
    assert page.errors == []


def test_the_three_buttons_in_order(live, page, movie_id):
    pid = open_edit(live, page, movie_id)
    # 1: Odd and Even versions, named from the clip
    page.click("#secVersions")
    page.wait_for_function("() => document.querySelectorAll('#secVersionList .vcard').length === 3", timeout=20000)
    names = page.eval_on_selector_all("#secVersionList .vcard b", "els => els.map(e => e.textContent)")
    assert names == ["Clip 01", "Clip 01 - Odd", "Clip 01 - Even"] or sorted(names) == sorted(["Clip 01", "Clip 01 - Odd", "Clip 01 - Even"])
    assert page.inner_text("#secVersionList .vcard.on b") == "Clip 01"
    page.click("#secVersionList .vcard:has-text('Clip 01 - Odd')")
    page.wait_for_url(lambda u: "p=" in u and pid not in u, timeout=15000)
    wait_ready(page)
    assert page.evaluate("() => S.proj.version") == "odd"
    assert "done" in page.get_attribute("#secVersions", "class")
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
    assert "done" in page.get_attribute("#secThin", "class") and "done" not in page.get_attribute("#secScenes", "class")
    # the selected section can be made longer into the gap, never over the next one
    page.evaluate("() => { S.sel = new Set([kept()[2]]); refreshAll({ keepVideo: true }); }")
    before = page.evaluate("() => kept()[2].end")
    page.click("#right button:has-text('End later')")
    assert page.evaluate("() => kept()[2].end") == pytest.approx(before + 0.5, abs=0.01)                    # 3rd kept is before a taken-out 4th
    page.keyboard.press("Control+z")
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
    assert "done" in page.get_attribute("#secScenes", "class") and "9 scenes" in page.inner_text("#secScenes")
    # the work is saved: reload and it is all still there
    page.evaluate("() => saveNow()")
    page.reload()
    wait_ready(page)
    assert page.evaluate("() => new Set(kept().map(p => p.unit)).size") == 9
    assert page.errors == []


def test_send_to_final_opens_the_final_stage_with_the_sound_and_picture_tools(live, page, movie_id):
    open_edit(live, page, movie_id, "Clip 02")
    page.click("#secFinal")
    page.wait_for_url("**/final?p=*", timeout=15000)
    wait_ready(page)
    assert page.evaluate("() => S.mode") == "final" and page.evaluate("() => S.proj.stage") == "final"
    tabs = page.eval_on_selector_all(".ftabs button", "els => els.map(e => e.dataset.panel)")
    assert tabs == ["sound", "frame", "text"] and page.is_hidden("#stepbar") and page.is_hidden(".edit-left")
    assert "on" in page.get_attribute(".ftabs button[data-panel=sound]", "class") and page.is_visible("#lyBox")
    page.click(".ftabs button[data-panel=frame]")
    assert page.is_visible("#framePanel") and page.is_hidden("#lyBox")
    top = page.eval_on_selector_all("header.top button", "els => els.map(e => e.textContent.trim())")
    assert any(t.startswith("Export") and "Exports" not in t for t in top)
    # an Edit page for a Final project goes to the Final page by itself
    pid = page.evaluate("() => S.id")
    page.goto(f"{live.base}/edit?p={pid}")
    page.wait_for_url("**/final?p=*", timeout=10000)
    assert page.errors == []


def test_buttons_never_wait_behind_timeline_pictures(live, page, movie_id):
    """The freeze: hundreds of timeline pictures used to fill the browser's 6 lines to the app, so a button press waited."""
    open_edit(live, page, movie_id, "Busy")
    page.evaluate("() => { window.__most = 0; setInterval(() => { window.__most = Math.max(window.__most, Thumbs.busy); }, 5); }")
    page.click("details[data-sec=cut] > summary")
    page.click("#cutChips button:has-text('1 s')")
    page.click("#cutBtn")
    page.wait_for_function("() => S.proj.pieces.length > 150", timeout=20000)
    page.evaluate("() => { S.pps = 60; renderTimeline(); }")                          # many pictures wanted at once
    took = page.evaluate("async () => { const t = performance.now(); await api('/api/projects/' + S.id); return performance.now() - t; }")
    assert took < 1500, took
    assert page.evaluate("() => window.__most") <= 3
    assert page.errors == []
