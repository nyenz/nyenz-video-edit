"""1.16 in a real browser: Separate scenes goes on in the background (with its own bar in Activity and on the Home
card), several projects at once from Home, and choosing, combining, moving and removing whole scenes on the timeline."""

from __future__ import annotations

import threading
import time

import pytest

from editforge.analysis import shots


@pytest.fixture(scope="module")
def movie_id(live, movie):
    return live.upload(movie)


def new_edit(live, source_id, name):
    return live.call("POST", "/api/projects", {"source": source_id, "name": name, "interval": 0})["project"]["id"]


def wait_ready(page):
    page.wait_for_function("() => typeof S !== 'undefined' && S.proj && S.info && document.querySelector('#laneV > *')", timeout=30000)


def forget_scenes(live):
    for f in live.state.scenes.folder.glob("*"):
        f.unlink()


def test_separate_scenes_goes_on_after_leaving_the_page(live, page, movie_id, monkeypatch):
    forget_scenes(live)
    gate = threading.Event()
    real = shots.extract_all
    monkeypatch.setattr(shots, "extract_all", lambda *a, **k: (gate.wait(30), real(*a, **k))[1])
    pid = new_edit(live, movie_id, "Background scenes")
    page.goto(f"{live.base}/edit?p={pid}"); wait_ready(page)
    page.click("#secScenes")
    page.wait_for_function("() => S.waiting === true")
    assert "open other projects meanwhile" in page.inner_text("#secNote")
    n = page.evaluate("() => kept().length")
    page.keyboard.press("Delete")                                      # the timeline waits for the scenes
    assert page.evaluate("() => kept().length") == n
    # leave the page: Home shows it working, and so does Activity
    page.goto(f"{live.base}/?phase=edit")
    card = page.locator('#grid .pcard[data-id="%s"]' % pid)
    card.locator(".ptask").wait_for()
    assert "scenes" in card.locator(".ptask").inner_text()
    page.wait_for_function("() => document.getElementById('activityBtn').classList.contains('busy')")
    page.click("#activityBtn")
    row = page.locator("#activityBody .act-row", has_text="Background scenes")
    row.wait_for()
    assert row.locator("a:has-text('Open')").get_attribute("href") == f"/edit?p={pid}"
    page.keyboard.press("Escape")
    gate.set()
    # done while no editor page was open: the card says so, and a message offers to open it
    page.wait_for_function("(id) => { const t = document.querySelector('#grid .pcard[data-id=\"' + id + '\"] .ptask'); return t && /separated/.test(t.textContent); }", arg=pid, timeout=60000)
    proj = live.call("GET", f"/api/projects/{pid}")["project"]
    assert len({p["unit"] for p in proj["pieces"]}) == 9
    # open it: the scenes are there, the note says so, and Undo brings back the cut from before
    page.goto(f"{live.base}/edit?p={pid}"); wait_ready(page)
    page.wait_for_function("() => /9 scenes separated/.test(document.getElementById('secNote').textContent)", timeout=15000)
    assert page.evaluate("() => sceneList().length") == 9
    page.keyboard.press("Control+z")
    assert page.evaluate("() => kept().length") == n
    assert page.errors == []


def test_choose_several_projects_on_home_and_separate_them_all(live, page, movie_id):
    a, b = new_edit(live, movie_id, "Many A"), new_edit(live, movie_id, "Many B")
    page.goto(f"{live.base}/?phase=edit")
    page.locator('#grid .pcard[data-id="%s"]' % a).click(modifiers=["Control"])
    page.locator('#grid .pcard[data-id="%s"]' % b).click(modifiers=["Control"])
    assert page.is_visible("#pickBar") and "2 chosen" in page.inner_text("#pickBar")
    page.locator('#grid .pcard[data-id="%s"]' % a).scroll_into_view_if_needed()      # (scrolling closes an open menu)
    page.wait_for_timeout(300)
    page.locator('#grid .pcard[data-id="%s"]' % a).click(button="right")
    assert page.locator(".menu.ctx", has_text="Separate scenes in 2 projects").count() == 1
    page.keyboard.press("Escape")
    page.click("#pickBar button:has-text('Separate scenes')")
    for pid in (a, b):
        page.wait_for_function("(id) => { const t = document.querySelector('#grid .pcard[data-id=\"' + id + '\"] .ptask'); return t && /separated/.test(t.textContent); }", arg=pid, timeout=60000)
    assert page.is_hidden("#pickBar")
    assert page.errors == []


def test_choose_combine_move_and_remove_whole_scenes(live, page, movie_id):
    pid = new_edit(live, movie_id, "Scene edit")
    live.call("POST", f"/api/projects/{pid}/scenes", {})
    page.goto(f"{live.base}/edit?p={pid}"); wait_ready(page)
    page.wait_for_function("() => sceneList().length === 9", timeout=60000)
    assert page.is_visible("#chooseSeg") and page.is_visible("#bCombine")
    assert page.inner_text("#laneV .clipb.sc-first .scene-tag") == "Scene 1"
    page.evaluate("() => fitZoom()")
    blocks = lambda: page.query_selector_all("#laneV .clipb")
    # a click chooses the whole scene; Ctrl + click adds another
    page.locator("#laneV .clipb").nth(1).click()
    page.locator("#laneV .clipb").nth(3).click(modifiers=["Control"])
    assert page.evaluate("() => chosenScenes().size") == 2
    assert "2 scenes selected" in page.inner_text("#iSel")
    page.click("#bCombine")
    assert page.evaluate("() => sceneList().length") == 8
    first = page.evaluate("() => sceneList()[1].pieces.map(p => p.start)")
    assert len(first) == 2 and first[1] > first[0] + 30                  # scene 4 now plays right after scene 2
    page.keyboard.press("Control+z")
    assert page.evaluate("() => sceneList().length") == 9
    # drag a scene to the end
    order = page.evaluate("() => sceneList().map(s => s.pieces[0].start)")
    src = blocks()[0].bounding_box(); last = blocks()[-1].bounding_box()
    page.mouse.move(src["x"] + 20, src["y"] + 30); page.mouse.down()
    page.mouse.move(last["x"] + last["width"] - 5, last["y"] + 30, steps=8); page.mouse.up()
    assert page.evaluate("() => sceneList().map(s => s.pieces[0].start)") == order[1:] + order[:1]
    # Delete removes the chosen scene; Split in Scenes makes a new scene
    page.keyboard.press("Delete")
    assert page.evaluate("() => sceneList().length") == 8
    page.evaluate("() => seek(sceneList()[0].out0 + 5)")
    page.keyboard.press("s")
    assert page.evaluate("() => sceneList().length") == 9
    # right-click a scene
    page.locator("#laneV .clipb").nth(2).click(button="right")
    assert page.locator(".menu.ctx", has_text="Remove this scene").count() == 1
    page.keyboard.press("Escape")
    # Sections: a click chooses one section again
    page.click("#chooseSeg button:has-text('Sections')")
    page.locator("#laneV .clipb").nth(0).click()
    assert page.evaluate("() => S.sel.size") == 1
    page.evaluate("() => localStorage.removeItem('ef.choose')")
    assert page.errors == []


def test_clean_up_list_and_grouped_exports(live, page, movie_id):
    a = new_edit(live, movie_id, "Tidy A")
    st, j = live.state.store, live.call("POST", f"/api/projects/{a}/render", {"preview": True})
    end = time.time() + 120
    while time.time() < end and live.call("GET", f"/api/jobs/{j['id']}")["status"] != "done":
        time.sleep(0.5)
    page.goto(f"{live.base}/?phase=edit")
    page.wait_for_selector("#tidyCount:not([hidden])")
    page.click("#tidyBtn")
    page.wait_for_selector("#tidyDrawer .tidy-row")
    row = page.locator("#tidyDrawer .tidy-row", has_text="Quick preview").first
    assert "only made to check" in row.inner_text()
    n = page.locator("#tidyDrawer .tidy-row").count()
    row.locator("button:has-text('Keep')").click()                # kept: not suggested again
    assert page.locator("#tidyDrawer .tidy-row").count() == n - 1
    page.evaluate("() => localStorage.removeItem('ef.tidy.keep')")
    page.reload()
    page.wait_for_selector("#tidyCount:not([hidden])")
    page.click("#tidyBtn")
    page.locator("#tidyDrawer .tidy-row", has_text="Quick preview").first.locator("button:has-text('Clear')").click()
    page.click(".dialog button:has-text('Clear')")
    page.wait_for_selector(".toast:has-text('Cleared')")
    assert live.state.store.get(j["id"]) is None
    page.keyboard.press("Escape")
    page.goto(f"{live.base}/?phase=edit")
    page.evaluate("() => Exports.show()")
    page.wait_for_selector("#exportsDrawer")
    assert page.errors == []
