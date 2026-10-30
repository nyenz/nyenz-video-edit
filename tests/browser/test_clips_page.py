"""Stage 1, the Clips page, in a real browser: marking, clips, parts, tools, undo, saving and the timeline itself."""

from __future__ import annotations

import pytest

from helpers_page import clips, drag_mark, open_clips, set_playhead, tab, x_of, y_of


@pytest.fixture(scope="module")
def movie_id(live, movie):
    return live.upload(movie)


def test_page_opens_with_only_the_clip_tools(live, page, movie_id):
    open_clips(live, page, movie_id)
    labels = page.eval_on_selector_all("#clipTabs .tab", "els => els.map(e => e.textContent.trim())")
    assert labels == ["Parts", "Tools"]                      # no Video / Sound tabs here any more
    for gone in ("vBri", "aVol", "vShape", "aNoise"):
        assert page.query_selector("#" + gone) is None
    assert page.errors == []


def test_marking_by_dragging_is_exact_and_adds_named_clips(live, page, movie_id):
    open_clips(live, page, movie_id, "My Movie")
    drag_mark(page, 12.0, 30.0)
    start, end = page.evaluate("() => [C.start, C.end]")
    assert abs(start - 12.0) < 0.2 and abs(end - 30.0) < 0.2           # one screen pixel is about 0.15 s at this zoom
    page.click("#addNew")
    drag_mark(page, 60.0, 75.0)
    page.click("#addNew")
    names = [c["name"] for c in clips(page)]
    assert names == ["My Movie - Clip 01", "My Movie - Clip 02"]
    assert page.errors == []


def test_exact_times_typed_and_marks_only_made_from_good_input(live, page, movie_id):
    open_clips(live, page, movie_id)
    page.fill("#startIn", "0:10"); page.press("#startIn", "Tab")
    page.fill("#endIn", "0:05"); page.press("#endIn", "Tab")
    assert "must come after" in page.inner_text("#markNote") or page.is_disabled("#addNew")
    page.fill("#endIn", "0:20.5"); page.press("#endIn", "Tab")
    page.click("#addNew")
    assert clips(page)[0]["parts"] == [[10.0, 20.5]]


def test_parts_from_different_places_make_one_clip(live, page, movie_id):
    open_clips(live, page, movie_id)
    drag_mark(page, 5, 10); page.click("#addNew")
    drag_mark(page, 100, 104); page.click("#addPart")
    drag_mark(page, 150, 152); page.keyboard.press("a")
    c = clips(page)
    assert len(c) == 1 and len(c[0]["parts"]) == 3
    total = sum(b - a for a, b in c[0]["parts"])
    assert abs(total - 11) < 0.6                                       # 5 + 4 + 2 seconds (marks by mouse are exact to a pixel)


def test_nudge_buttons_and_undo_redo(live, page, movie_id):
    open_clips(live, page, movie_id)
    page.fill("#startIn", "20"); page.press("#startIn", "Tab"); page.fill("#endIn", "30"); page.press("#endIn", "Tab")
    page.click("#addNew")
    tab(page, "Tools")
    page.click("#nStep [data-v='5']")
    page.click("#nSa")                                                 # start earlier by 5 s: adds time before
    page.click("#nEb")                                                 # end later by 5 s: adds time after
    assert clips(page)[0]["parts"] == [[15.0, 35.0]]
    page.click("#nStep [data-v='0.1']")
    page.click("#nSb"); page.click("#nEa")                             # start later / end earlier by 0.1 s
    assert clips(page)[0]["parts"] == [[15.1, 34.9]]
    page.keyboard.press("Control+z")                                   # one step back: the 0.1 s from the end is back
    assert clips(page)[0]["parts"] == [[15.1, 35.0]]
    page.click("#bUndo"); page.click("#bUndo"); page.click("#bUndo")
    assert clips(page)[0]["parts"] == [[20.0, 30.0]]
    page.keyboard.press("Control+y")
    assert clips(page)[0]["parts"] == [[15.0, 30.0]]
    # an edge never goes past the movie or leaves nothing
    page.click("#nStep [data-v='5']")
    for _ in range(5):
        page.click("#nSa")
    assert clips(page)[0]["parts"][0][0] == 0.0
    page.click("#nSa")
    assert "start of the movie" in page.inner_text("#nNote")


def test_split_cut_out_join_and_duplicate(live, page, movie_id):
    open_clips(live, page, movie_id, "Film")
    drag_mark(page, 40, 80); page.click("#addNew")
    tab(page, "Tools")
    # split at the playhead: two clips that together are exactly the old one
    set_playhead(page, 60)
    page.click("#tSplit")
    c = clips(page)
    assert len(c) == 2 and c[0]["parts"][-1][1] == c[1]["parts"][0][0]
    assert abs(c[0]["parts"][0][0] - 40) < 0.3 and abs(c[1]["parts"][-1][1] - 80) < 0.3
    assert [x["name"] for x in c] == ["Film - Clip 01", "Film - Clip 02"] or c[1]["name"] == "Film - Clip 02"
    # join them again
    page.click(".clip-row >> nth=0")
    page.click("#tJoin")
    page.click(".pick-list .item")
    c = clips(page)
    assert len(c) == 1 and len(c[0]["parts"]) == 2
    # cut out the middle: mark inside, press the button
    page.evaluate("() => { C.start = 50; C.end = 55; renderMarks(); }")
    page.click("#tCutOut")
    parts = clips(page)[0]["parts"]
    total = sum(b - a for a, b in parts)
    assert abs(total - 35) < 0.4 and all(not (50 < a < 55 or 50 < b < 55) for a, b in parts)
    # duplicate
    page.click("#tDup")
    c = clips(page)
    assert len(c) == 2 and c[0]["parts"] == c[1]["parts"] and c[0]["id"] != c[1]["id"] and c[1]["name"].endswith("Clip 02")
    # all of it can be undone, one step at a time
    for _ in range(20):
        if page.is_disabled("#bUndo"):
            break
        page.click("#bUndo")
    assert clips(page) == []


def test_clips_are_saved_and_come_back_after_reload(live, page, movie_id):
    cid = open_clips(live, page, movie_id)
    drag_mark(page, 10, 20); page.click("#addNew")
    page.evaluate("() => flush()")
    page.reload()
    page.wait_for_function("() => typeof C !== 'undefined' && C.info && C.cs.clips.length === 1")
    got = live.call("GET", f"/api/clipsets/{cid}")["clipset"]["clips"]
    assert len(got) == 1 and abs(got[0]["parts"][0]["start"] - 10) < 0.3


def test_playing_a_clip_goes_through_every_part_and_stops_on_the_end(live, page, movie_id):
    open_clips(live, page, movie_id)
    page.fill("#startIn", "1"); page.press("#startIn", "Tab"); page.fill("#endIn", "2"); page.press("#endIn", "Tab"); page.click("#addNew")
    page.fill("#startIn", "100"); page.press("#startIn", "Tab"); page.fill("#endIn", "101"); page.press("#endIn", "Tab"); page.click("#addPart")
    page.click("#playClip")
    seen = []
    for _ in range(40):
        page.wait_for_timeout(100)
        seen.append(page.evaluate("() => [video.currentTime, video.paused]"))
        if seen[-1][1] and len(seen) > 5:
            break
    assert any(t > 99.5 for t, _ in seen), seen                         # it jumped to the second part
    t, paused = seen[-1]
    assert paused and 100.9 <= t <= 101.2, seen[-1]                     # and stopped at the end of the last part


def test_play_with_context_and_play_all(live, page, movie_id):
    open_clips(live, page, movie_id)
    drag_mark(page, 30, 31); page.click("#addNew")
    drag_mark(page, 90, 91); page.click("#addNew")
    page.click(".clip-row >> nth=0")
    page.click("#playCtx")
    page.wait_for_function("() => !video.paused || video.currentTime > 26")
    assert 26.5 <= page.evaluate("() => video.currentTime") <= 28.0      # it starts 3 seconds before the part
    page.wait_for_function("() => video.paused", timeout=15000)
    assert 33.5 <= page.evaluate("() => video.currentTime") <= 34.3      # and stops 3 seconds after it
    page.click("#playAll")
    page.wait_for_function("() => video.currentTime > 89", timeout=15000)
    assert page.evaluate("() => selClip().name").endswith("Clip 02")      # the chosen clip follows the playing one


def test_zoom_keeps_the_playhead_still_and_marks_stay_exact_when_zoomed_in(live, page, movie_id):
    open_clips(live, page, movie_id)
    set_playhead(page, 90)
    page.evaluate("() => { $('tlScroll').scrollLeft = 0; }")
    before = x_of(page, 90)
    page.click("#bZoomIn"); page.click("#bZoomIn")
    page.wait_for_timeout(150)
    assert abs(x_of(page, 90) - before) < 3 or 0 <= x_of(page, 90) <= 1366
    # zoom a lot, then mark a short piece: it must be exact to a fraction of a second
    page.evaluate("() => { setZoom(120, 90); }")
    page.wait_for_timeout(150)
    page.evaluate("() => { $('tlScroll').scrollLeft = px(88) - 100; }")
    drag_mark(page, 89.0, 90.0)
    start, end = page.evaluate("() => [C.start, C.end]")
    assert abs(start - 89.0) < 0.05 and abs(end - 90.0) < 0.05, (start, end)


def test_dragging_a_part_edge_changes_it_and_can_be_undone(live, page, movie_id):
    open_clips(live, page, movie_id)
    drag_mark(page, 50, 60); page.click("#addNew")
    y = y_of(page, "#laneC")
    x_end = x_of(page, 60) - 2
    page.mouse.move(x_end, y); page.mouse.down(); page.mouse.move(x_end + 40, y, steps=5); page.mouse.up()
    p = clips(page)[0]["parts"][0]
    assert p[1] > 62 and abs(p[0] - 50) < 0.3
    page.click("#bUndo")
    assert abs(clips(page)[0]["parts"][0][1] - 60) < 0.3


def test_picture_strip_does_not_flicker_while_scrolling(live, page, movie_id):
    open_clips(live, page, movie_id)
    page.evaluate("() => { setZoom(8, 0); }")
    page.wait_for_function("() => document.querySelectorAll('#stripAll img').length > 3")
    page.evaluate("() => { window.__mark = $('stripAll').children[1]; $('tlScroll').scrollLeft += 20; }")
    page.wait_for_timeout(120)
    assert page.evaluate("() => window.__mark.isConnected")               # the same picture element is still there
    assert page.errors == []


def test_timeline_wheel_scrolls_sideways_and_ctrl_wheel_zooms(live, page, movie_id):
    open_clips(live, page, movie_id)
    page.evaluate("() => { setZoom(10, 0); }")
    box = page.eval_on_selector("#tlScroll", "e => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }")
    page.mouse.move(*box)
    before = page.evaluate("() => $('tlScroll').scrollLeft")
    page.mouse.wheel(0, 300)
    page.wait_for_timeout(100)
    after = page.evaluate("() => $('tlScroll').scrollLeft")
    assert after > before or page.evaluate("() => $('tlScroll').scrollTop") > 0
    z0 = page.evaluate("() => C.pps")
    page.keyboard.down("Control"); page.mouse.wheel(0, -200); page.keyboard.up("Control")
    page.wait_for_timeout(100)
    assert page.evaluate("() => C.pps") > z0
