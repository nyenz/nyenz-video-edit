"""A 2-hour movie: the timeline must stay quick and exact at every zoom, and marks must land where the mouse is."""

from __future__ import annotations

import pytest

from helpers_page import clips, drag_mark, open_clips, set_playhead, x_of


@pytest.fixture(scope="module")
def long_id(live, long_movie):
    return live.upload(long_movie)


def test_zooming_and_scrolling_a_two_hour_movie_is_quick(live, page, long_id):
    open_clips(live, page, long_id)
    assert abs(page.evaluate("() => C.info.duration") - 7200) < 2
    times = []
    for pps in (0.05, 0.3, 2, 10, 60, 200):
        ms = page.evaluate("""(pps) => { const t0 = performance.now(); setZoom(pps, 3600); for (let i = 0; i < 5; i++) { $('tlScroll').scrollLeft += 400; renderLane(); }
            return (performance.now() - t0) / 6; }""", pps)
        times.append(round(ms, 1))
    assert max(times) < 60, times                                             # each redraw well under a frame or three
    assert page.errors == []


def test_marks_far_into_the_movie_are_exact(live, page, long_id):
    open_clips(live, page, long_id)
    page.evaluate("() => { setZoom(40, 5400); $('tlScroll').scrollLeft = px(5398) - 80; }")
    page.wait_for_timeout(200)
    drag_mark(page, 5399.0, 5401.5)
    start, end = page.evaluate("() => [C.start, C.end]")
    assert abs(start - 5399.0) < 0.06 and abs(end - 5401.5) < 0.06, (start, end)
    page.click("#addNew")
    assert abs(clips(page)[0]["parts"][0][0] - 5399.0) < 0.06


def test_fit_shows_the_whole_movie_and_the_end_is_reachable(live, page, long_id):
    open_clips(live, page, long_id)
    page.click("#bFit")
    sc_w, inner_w = page.evaluate("() => [$('tlScroll').clientWidth, $('tlInner').scrollWidth]")
    assert inner_w <= sc_w + 2                                                # no sideways scroll when everything fits
    page.wait_for_function("() => document.activeElement === document.body")     # a mouse click does not keep the keyboard
    page.keyboard.press("End")
    assert page.evaluate("() => video.currentTime") > 7195
    page.keyboard.press("Home")
    assert page.evaluate("() => video.currentTime") < 1


def test_the_playhead_follows_when_playing_past_the_screen(live, page, long_id):
    open_clips(live, page, long_id)
    page.evaluate("() => { setZoom(30, 0); $('tlScroll').scrollLeft = 0; }")
    set_playhead(page, 3)
    page.evaluate("() => { video.play(); }")
    page.wait_for_function("() => video.currentTime > 40", timeout=60000)
    page.evaluate("() => video.pause()")
    x = x_of(page, page.evaluate("() => video.currentTime"))
    w = page.evaluate("() => $('tlScroll').getBoundingClientRect().right")
    assert 0 <= x <= w                                                        # the playhead is still on screen
