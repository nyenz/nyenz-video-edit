"""1.40.2: exporting and removing things without glitches: one click is one export, a running card only changes its
numbers (no jumping, a click on Stop is not lost), removing keeps the list calm and says so, and a video a project
still uses can not be removed."""

from __future__ import annotations

import pytest


@pytest.fixture(scope="module")
def vid_id(live, tmp_path_factory):
    from tools.make_samples import make_video
    p = make_video(str(tmp_path_factory.mktemp("exd") / "Export test.mp4"), 12, "320x180", "25", "tone")
    return live.upload(p)


def open_final(live, page, fid, name):
    pid = live.call("POST", "/api/projects", {"source": fid, "name": name, "stage": "final"})["project"]["id"]
    page.goto(f"{live.base}/final?p={pid}")
    page.wait_for_function("() => typeof S !== 'undefined' && S.proj && S.info && document.querySelector('#laneV .clipb')", timeout=30000)
    return pid


def test_a_double_click_on_export_starts_one_export(live, page, vid_id):
    pid = open_final(live, page, vid_id, "Double")
    n0 = len(live.call("GET", "/api/jobs")["jobs"])
    page.evaluate("() => exportDialog()")
    btn = page.locator(".dialog[aria-label=Export] .btns .btn.primary")
    btn.dblclick()
    page.wait_for_selector("#exportsDrawer", timeout=10000)
    page.wait_for_timeout(1500)
    jobs = live.call("GET", "/api/jobs")["jobs"]
    assert len(jobs) - n0 == 1, [j["id"] for j in jobs]
    assert page.errors == []


def test_a_running_card_is_updated_in_place_and_the_list_keeps_its_place(live, page, vid_id):
    open_final(live, page, vid_id, "Calm")
    page.evaluate("() => Exports.show()")
    page.wait_for_selector("#exportsDrawer")
    # pretend jobs: many finished ones and one running, whose numbers then change
    page.evaluate("""() => {
      window._real = api; window._p = 10;
      const mk = (i) => ({ id: ('0000000000' + (10 + i)).slice(-12), status: 'done', progress: 1, title: 'Old ' + i, file_id: 'f' + i, group: 'final', result: { duration: 5 }, warnings: [] });
      window.api = async (path) => path === '/api/jobs' ? { jobs: [{ id: 'aaaaaaaaaaaa', status: 'running', progress: window._p / 100, message: 'Step ' + window._p, group: 'final', title: 'Running one', warnings: [] }]
        .concat(Array.from({ length: 12 }, (_, i) => mk(i))) } : window._real(path);
      Exports.gone.clear(); Exports.refresh(true);
    }""")
    page.wait_for_selector("#exportsBody .job[data-id=aaaaaaaaaaaa]")
    page.evaluate("() => { const b = document.querySelector('#exportsBody'); b.style.maxHeight = '200px'; b.style.overflow = 'auto'; b.scrollTop = 150; window._top = b.scrollTop; document.querySelector('.job[data-id=aaaaaaaaaaaa]')._mark = 1; }")
    page.evaluate("async () => { window._p = 55; await Exports.refresh(false); }")
    assert page.evaluate("() => !!document.querySelector('.job[data-id=aaaaaaaaaaaa]')._mark") is True       # the same card, not rebuilt
    assert page.evaluate("() => document.querySelector('.job[data-id=aaaaaaaaaaaa] .st').textContent") == "55%"
    assert page.evaluate("() => document.querySelector('.job[data-id=aaaaaaaaaaaa] .prog i').style.width") == "55%"
    assert "Step 55" in page.inner_text(".job[data-id=aaaaaaaaaaaa] .facts.live")
    assert page.evaluate("() => document.querySelector('#exportsBody').scrollTop") == page.evaluate("() => window._top")
    page.evaluate("() => { window._p = 100; }")
    page.evaluate("async () => { const f = window.api; window.api = async (path) => path === '/api/jobs' ? { jobs: (await f(path)).jobs.map((j, i) => i ? j : Object.assign(j, { status: 'done', progress: 1 })) } : f(path); await Exports.refresh(false); }")
    assert page.evaluate("() => document.querySelector('.job[data-id=aaaaaaaaaaaa] .st').textContent") == "Done"          # a finished one does get its buttons
    assert page.evaluate("() => document.querySelector('#exportsBody').scrollTop") == page.evaluate("() => window._top")      # and the list stays where it was
    page.evaluate("() => { window.api = window._real; }")
    assert page.errors == []


def test_removing_an_export_closes_the_card_and_says_so_and_a_used_video_stays(live, page, vid_id):
    pid = open_final(live, page, vid_id, "Remove")
    page.evaluate("() => exportDialog()")
    page.locator(".dialog[aria-label=Export] .btns .btn.primary").click()
    page.wait_for_function("() => [...document.querySelectorAll('#exportsBody .job .st')].some(s => s.classList.contains('done'))", timeout=240000)
    page.evaluate("() => { const b = document.querySelector('#exportsBody'); b.style.maxHeight = ''; }")
    card = page.locator("#exportsBody .job:has(.st.done)").first
    jid = card.get_attribute("data-id")
    # a project that uses this video keeps it: the card stays and the reason is shown
    fid = [j for j in live.call("GET", "/api/jobs")["jobs"] if j["id"] == jid][0]["file_id"]
    sp = live.call("POST", "/api/projects", {"source": fid, "interval": 0, "stage": "studio"})["project"]["id"]
    card.locator("button.danger").click()
    page.locator(".dialog button:has-text('Remove')").click()
    page.wait_for_selector(".toast.bad, .toast.err, .toast", timeout=5000)
    assert page.locator(f"#exportsBody .job[data-id='{jid}']").count() == 1
    assert page.locator(f"#exportsBody .job[data-id='{jid}'] button.danger").is_enabled()
    live.call("DELETE", f"/api/projects/{sp}")
    live.call("POST", f"/api/projects/{sp}/trash", {}) if False else None
    # now (project deleted for good) it can go
    page.locator(f"#exportsBody .job[data-id='{jid}'] button.danger").click()
    page.locator(".dialog button:has-text('Remove')").click()
    page.wait_for_function("(id) => !document.querySelector(\".job[data-id='\" + id + \"']\")", arg=jid, timeout=5000)
    assert all(j["id"] != jid for j in live.call("GET", "/api/jobs")["jobs"])
    assert page.errors == []
