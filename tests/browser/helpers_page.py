"""Small helpers shared by the browser tests."""

from __future__ import annotations


def open_clips(live, page, source_id, name=None):
    """Make a new clip project from an uploaded movie and open its page. Returns the project id."""
    body = {"source": source_id}
    if name:
        body["name"] = name
    cid = live.call("POST", "/api/clipsets", body)["clipset"]["id"]
    page.goto(f"{live.base}/clips?c={cid}")
    page.wait_for_function("() => typeof C !== 'undefined' && C.info && video.readyState >= 1 && document.querySelector('#stripAll img')", timeout=30000)
    return cid


def x_of(page, t):
    """Screen x of movie time t on the timeline."""
    return page.evaluate("(t) => { const sc = $('tlScroll'), r = sc.getBoundingClientRect(); return r.left + px(t) - sc.scrollLeft; }", t)


def y_of(page, sel):
    return page.evaluate("(s) => { const r = document.querySelector(s).getBoundingClientRect(); return r.top + r.height / 2; }", sel)


def drag_mark(page, a, b):
    """Drag on the picture strip from time a to time b."""
    y = y_of(page, "#laneV")
    page.mouse.move(x_of(page, a), y)
    page.mouse.down()
    page.mouse.move((x_of(page, a) + x_of(page, b)) / 2, y, steps=3)
    page.mouse.move(x_of(page, b), y, steps=3)
    page.mouse.up()


def clips(page):
    return page.evaluate("() => clips().map(c => ({ id: c.id, name: c.name, parts: c.parts.map(p => [p.start, p.end]) }))")


def tab(page, name):
    """The clip panel has no tabs any more: everything shows at once. Kept so the tests read the same."""
    return None


def set_playhead(page, t):
    page.evaluate("(t) => { seek(t); }", t)
    page.wait_for_function("(t) => Math.abs(video.currentTime - t) < 0.2 && !video.seeking", arg=t)
