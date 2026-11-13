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
    page.wait_for_function("() => /scenes? separated/.test(document.getElementById('secNote').textContent)", timeout=90000)
    scenes = page.evaluate("() => new Set(kept().map(p => p.unit)).size")
    assert scenes == 9
    assert "9 scenes separated" in page.inner_text("#secNote")
    assert "done" in page.get_attribute("#secScenes", "class") and "9 scenes" in page.inner_text("#secScenes")
    # the work is saved: reload and it is all still there
    page.evaluate("() => saveNow()")
    page.reload()
    wait_ready(page)
    assert page.evaluate("() => new Set(kept().map(p => p.unit)).size") == 9
    # 1.21: the steps already done stay marked (step 2 too, after scenes), and doing one again asks first
    assert all("done" in page.get_attribute(b, "class") for b in ("#secVersions", "#secThin", "#secScenes"))
    page.wait_for_selector("#secVersionList .vcard.on .vsteps")
    assert page.eval_on_selector_all("#secVersionList .vcard.on .vsteps i", "els => els.map(e => e.className)") == ["done", "done", "done"]
    steps = page.evaluate("() => S.proj.steps.length")
    page.click("#secThin")                                      # done once: it cannot be done twice
    page.wait_for_selector(".toast:has-text('Step 2 is already done')")
    assert page.evaluate("() => S.proj.steps.length") == steps
    page.click("#secVersions")
    page.wait_for_selector(".toast:has-text('Step 1 is done')")
    page.click("#secScenes")
    page.wait_for_selector(".dialog:has-text('already separated')")
    page.click(".dialog button:has-text('Cancel')")
    assert "next" in page.get_attribute("#secFinal", "class")   # the step to do now is lit
    # send to Final once; a second time opens the same Final project (never two of the same thing)
    vid = page.evaluate("() => S.id")
    first = live.call("POST", f"/api/projects/{vid}/to-final", {})
    again = live.call("POST", f"/api/projects/{vid}/to-final", {})
    assert again["project"]["id"] == first["project"]["id"] and again.get("existing") is True and not first.get("existing")
    # the clip the versions were made from: step 1 is done there and cannot be done again
    page.goto(f"{live.base}/edit?p={pid}")
    wait_ready(page)
    page.wait_for_function("() => document.getElementById('secVersions').classList.contains('done')", timeout=10000)
    page.click("#secVersions")
    page.wait_for_selector(".toast:has-text('already made')")
    assert page.locator("#secVersionList .vcard").count() == 3
    assert page.locator("#secVersionList .vnext.good").count() == 1          # the one that is in Final says so
    # Back goes to Home at this stage
    page.click("#backBtn")
    page.wait_for_selector(".vfolder")
    # Home, Edit: one folder for the video, with the original, Odd and Even inside, each with its level
    folder = page.locator(".vfolder").first
    assert folder.locator(".pcard").count() == 3
    assert folder.locator(".chip-tag.top").all_inner_texts() == ["Original", "Odd", "Even"]
    nexts = folder.locator(".plevel .next").all_inner_texts()
    assert nexts[0].startswith("Versions made") and "In Final" in nexts and any(n.startswith("Next: step 2") for n in nexts)
    assert page.locator(".navmore").count() == 0 and page.locator("a[href='/combine']").count() == 0      # More is gone
    folder.locator(".vf-h").click()                             # a folder closes and opens
    assert page.locator(".vfolder.shut").count() == 1
    page.locator(".vfolder .vf-h").first.click()
    # Home, Final: the same folder holds the Final project
    page.click("#phases .phase:nth-child(3)")
    page.wait_for_selector(".vfolder .pcard")
    assert page.locator(".vfolder").count() == 1 and page.locator(".vfolder .pcard").count() == 1
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


def test_the_timeline_follows_the_red_line_while_playing_and_follow_can_be_switched_off(live, page, movie_id):
    open_edit(live, page, movie_id, "Follow")
    wait_ready(page)
    page.evaluate("() => { const z = document.getElementById('zoom'); z.value = '100'; z.dispatchEvent(new Event('input')); }")
    page.wait_for_timeout(200)
    sc = "document.getElementById('tlScroll')"
    assert page.evaluate(f"() => {sc}.scrollWidth > {sc}.clientWidth * 2")
    assert "on" in page.get_attribute("#bFollow", "class")
    # playing, the red line runs past the right edge: the timeline turns a page and the line is in view again
    page.evaluate(f"() => {{ {sc}.scrollLeft = 0; S.playing = true; S.t = timeAt({sc}.clientWidth + 120); renderPlayhead(); }}")
    left = page.evaluate(f"() => {sc}.scrollLeft")
    x = page.evaluate("() => px(S.t)")
    w = page.evaluate(f"() => {sc}.clientWidth")
    assert left > 0 and left < x < left + w
    # off: the timeline stays where it is
    page.evaluate("() => { S.playing = false; }")
    page.click("#bFollow")
    assert "on" not in page.get_attribute("#bFollow", "class")
    page.evaluate(f"() => {{ {sc}.scrollLeft = 0; S.playing = true; S.t = timeAt({sc}.clientWidth + 300); renderPlayhead(); S.playing = false; }}")
    assert page.evaluate(f"() => {sc}.scrollLeft") == 0
    # remembered next time
    page.reload()
    wait_ready(page)
    assert "on" not in page.get_attribute("#bFollow", "class")
    page.click("#bFollow")
    assert page.errors == []
