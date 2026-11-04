"""Version 1.15 in a real browser: Cut before / Cut after, dragging, right-click menus, and the Made clips tab."""

from __future__ import annotations

import time

import pytest

from helpers_page import clips, drag_mark, open_clips, set_playhead, x_of, y_of


@pytest.fixture(scope="module")
def movie_id(live, movie):
    return live.upload(movie)


def menu_labels(page):
    page.wait_for_selector(".menu.ctx")
    return page.eval_on_selector_all(".menu.ctx div[role=menuitem] span", "els => els.map(e => e.textContent)")


def click_menu(page, label):
    page.locator(".menu.ctx div[role=menuitem]", has_text=label).first.click()


def test_cut_before_and_after_with_keys_and_buttons(live, page, movie_id):
    open_clips(live, page, movie_id)
    drag_mark(page, 10, 30); page.click("#addNew")
    set_playhead(page, 14.0)
    page.keyboard.press("q")                                           # Cut before: the clip now starts at the playhead
    a, b = clips(page)[0]["parts"][0]
    assert abs(a - 14.0) < 0.05 and abs(b - 30) < 0.3
    set_playhead(page, 25.0)
    page.click("#tlCutA")                                              # Cut after, from the timeline bar
    a, b = clips(page)[0]["parts"][0]
    assert abs(a - 14.0) < 0.05 and abs(b - 25.0) < 0.05
    page.keyboard.press("Control+z")
    assert abs(clips(page)[0]["parts"][0][1] - 30) < 0.3              # undo works on it
    # outside every clip: a clear note, nothing changes
    set_playhead(page, 100.0)
    before = clips(page)
    page.keyboard.press("w")
    assert clips(page) == before and "playhead inside a clip" in page.inner_text("#markNote")
    assert page.errors == []


def test_right_click_a_clip_on_the_timeline_cuts_where_you_clicked(live, page, movie_id):
    open_clips(live, page, movie_id)
    drag_mark(page, 40, 60); page.click("#addNew")
    y = y_of(page, "#laneC")
    page.mouse.click(x_of(page, 45), y, button="right")
    labels = menu_labels(page)
    for want in ("Play this clip", "Cut before here", "Cut after here", "Split here", "Rename", "Duplicate", "Delete this clip"):
        assert want in labels, labels
    click_menu(page, "Cut before here")
    a, b = clips(page)[0]["parts"][0]
    assert abs(a - 45) < 0.3 and abs(b - 60) < 0.3
    assert page.query_selector(".menu.ctx") is None                    # the menu closes after a choice
    # right-click on the empty strip: marks and the playhead
    page.mouse.click(x_of(page, 120), y_of(page, "#laneV"), button="right")
    labels = menu_labels(page)
    assert "Move the playhead here" in labels and "Mark the start here" in labels
    page.keyboard.press("Escape")
    assert page.query_selector(".menu.ctx") is None
    assert page.errors == []


def test_drag_a_clip_to_move_it_and_drag_rows_to_reorder(live, page, movie_id):
    open_clips(live, page, movie_id)
    drag_mark(page, 20, 30); page.click("#addNew")
    drag_mark(page, 80, 90); page.click("#addNew")
    page.evaluate("() => select(clips()[0].id)")
    a0, b0 = clips(page)[0]["parts"][0]
    y = y_of(page, "#laneC")
    page.mouse.move(x_of(page, 25), y); page.mouse.down()
    page.mouse.move(x_of(page, 40), y, steps=4); page.mouse.move(x_of(page, 55), y, steps=4); page.mouse.up()
    a, b = clips(page)[0]["parts"][0]
    assert abs((b - a) - (b0 - a0)) < 0.01 and abs(a - (a0 + 30)) < 1.5   # same length, 30 s later
    page.keyboard.press("Control+z")
    assert clips(page)[0]["parts"][0] == [a0, b0]
    # drag the second clip in the list above the first
    names = [c["name"] for c in clips(page)]
    rows = page.query_selector_all("#clips .clip-row")
    r0, r1 = rows[0].bounding_box(), rows[1].bounding_box()
    page.mouse.move(r1["x"] + 60, r1["y"] + r1["height"] / 2); page.mouse.down()
    page.mouse.move(r1["x"] + 60, r0["y"] + 10, steps=6); page.mouse.move(r0["x"] + 60, r0["y"] + 4, steps=2); page.mouse.up()
    assert [c["name"] for c in clips(page)] == names[::-1]
    # right-click a row in the list
    page.click("#clips .clip-row >> nth=0", button="right")
    assert "Move down" in menu_labels(page)
    page.keyboard.press("Escape")
    assert page.errors == []


def wait_library(live, n, timeout=90):
    end = time.time() + timeout
    while time.time() < end:
        lib = live.call("GET", "/api/clips/library")["clips"]
        if len(lib) >= n:
            return lib
        time.sleep(0.4)
    raise AssertionError("clips were not made")


def test_made_clips_tab_shows_clips_in_use_and_protects_them(live, page, movie_id):
    cid = live.call("POST", "/api/clipsets", {"source": movie_id, "name": "Library movie"})["clipset"]["id"]
    cs = live.call("GET", f"/api/clipsets/{cid}")["clipset"]
    live.call("PUT", f"/api/clipsets/{cid}", dict(cs, clips=[{"name": "Lib A", "parts": [{"start": 1, "end": 2}]},
                                                             {"name": "Lib B", "parts": [{"start": 3, "end": 4}]}]))
    live.call("POST", f"/api/clipsets/{cid}/make", {})
    end = time.time() + 120
    while time.time() < end:
        lib = [x for x in live.call("GET", "/api/clips/library")["clips"] if x["name"] in ("Lib A", "Lib B")]
        if len(lib) == 2:
            break
        time.sleep(0.4)
    a = next(x for x in lib if x["name"] == "Lib A")
    live.call("POST", "/api/projects", {"source": a["file"], "interval": 0, "name": "Uses A"})
    live.call("DELETE", f"/api/clipsets/{cid}")                       # the big project is gone; the clips are not
    page.goto(f"{live.base}/?phase=made")
    page.wait_for_selector("#grid .pcard")
    assert page.is_visible("#subTabs") and page.is_visible("#libFilter") and page.is_hidden("#createRow")
    cards = page.eval_on_selector_all("#grid .pcard", "els => els.map(e => e.querySelector('.pinfo b').textContent)")
    assert "Lib A" in cards and "Lib B" in cards
    card = page.locator("#grid .pcard", has_text="Lib A")
    assert "In use" in card.inner_text()
    card.click(button="right")
    labels = menu_labels(page)
    assert "Open 'Uses A'" in labels and "New edit project from it" in labels and "Open its clip project" not in labels
    click_menu(page, "Remove this clip")                               # greyed out: says why, deletes nothing
    page.wait_for_selector(".toast")
    assert "Uses A" in page.inner_text(".toast")
    assert any(x["name"] == "Lib A" for x in live.call("GET", "/api/clips/library")["clips"])
    # the In use / Not used filter
    page.click("#libFilter button:has-text('Not used')")
    cards = page.eval_on_selector_all("#grid .pcard", "els => els.map(e => e.querySelector('.pinfo b').textContent)")
    assert "Lib B" in cards and "Lib A" not in cards
    assert page.errors == []


def test_edit_page_cut_before_after_and_right_click(live, page, movie_id):
    pid = live.call("POST", "/api/projects", {"source": movie_id, "name": "Mouse edit", "interval": 0})["project"]["id"]
    page.goto(f"{live.base}/edit?p={pid}")
    page.wait_for_function("() => typeof S !== 'undefined' && S.proj && S.info && document.querySelector('#laneV .clipb')", timeout=30000)
    total = page.evaluate("() => rawTotal()")
    page.evaluate("() => seek(10)")
    page.keyboard.press("q")
    assert abs(page.evaluate("() => rawTotal()") - (total - 10)) < 0.1
    page.evaluate("() => seek(20)")
    page.click("#bCutA")
    assert abs(page.evaluate("() => rawTotal()") - 20) < 0.1
    box = page.query_selector("#laneV .clipb").bounding_box()
    page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2, button="right")
    labels = menu_labels(page)
    for want in ("Play from here", "Split here", "Cut before here", "Cut after here", "Remove this section"):
        assert want in labels, labels
    click_menu(page, "Split here")
    assert page.evaluate("() => kept().length") == 2
    assert page.errors == []
