"""1.16: scenes are separated in the background for any number of projects (they wait in line), the result is put into
the project also when its page is closed, and everything the app is working on shows in the Activity list."""

from __future__ import annotations

import threading
import time

import pytest

from editforge.analysis import shots
from editforge.web.server import make_server
from test_web_workshop import Client


@pytest.fixture()
def web(tmp_path):
    srv, state = make_server("127.0.0.1", 0, home=tmp_path / "home")
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield Client(state.port, state.token), state
    state.manager.shutdown()
    state.previews.shutdown()
    srv.shutdown()
    srv.server_close()


def new_project(c, fid, name):
    return c.json("POST", "/api/projects", {"source": fid, "interval": 0, "name": name})[1]["project"]["id"]


def wait_task(c, pid, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        t = c.json("GET", f"/api/projects/{pid}/task")[1]["task"]
        if t["state"] in ("done", "failed"):
            return t
        time.sleep(0.2)
    raise AssertionError("the scenes were not separated")


def test_one_pass_finds_the_same_exact_frames_as_before(media):
    """The new reader looks at every frame once, so the exact frame of each cut is known without reading the video again."""
    path = media["scenes"]
    feats, fine = shots.extract_all(path, 6.0)
    new = [c.t for c in shots.refine_fine(shots.find_cuts(feats), fine)]
    old_feats = shots.extract_features(path, 6.0)
    old = [c.t for c in shots.refine_all(path, shots.find_cuts(old_feats))]
    assert len(new) == len(old) == 2
    assert all(abs(a - b) < 0.045 for a, b in zip(new, old))
    assert all(abs(a - b) < 0.05 for a, b in zip(new, [2.0, 4.0]))


def test_several_projects_get_their_scenes_while_no_page_is_open(web, media):
    c, state = web
    fid = c.upload(media["scenes"])
    other = c.upload(media["colors"])
    pids = [new_project(c, fid, "One"), new_project(c, fid, "Two"), new_project(c, other, "Three")]
    for pid in pids:
        status, t = c.json("POST", f"/api/projects/{pid}/scenes", {})
        assert status == 200 and t["state"] in ("queued", "running", "done")
    # the Activity list and the Home cards show them
    act = c.json("GET", "/api/activity")[1]
    assert {i["title"] for i in act["items"] if i["kind"] == "scenes"} >= {"One", "Two", "Three"}
    for pid in pids:
        assert wait_task(c, pid)["state"] == "done"
    one = c.json("GET", f"/api/projects/{pids[0]}")[1]["project"]
    assert len({p["unit"] for p in one["pieces"]}) == 3 and one["rule"]["hand"]
    assert one["task_done"]["scenes"] == 3 and one["task_done"]["before"]     # the page offers Undo with this
    cards = {p["name"]: p for p in c.json("GET", "/api/projects")[1]["projects"]}
    assert cards["Two"]["task"]["state"] == "done" and cards["Two"]["task"]["scenes"] == 3
    done = [i for i in c.json("GET", "/api/activity")[1]["items"] if i["kind"] == "scenes"]
    assert all(i["state"] == "done" and i["link"].startswith("/edit?p=") for i in done)
    # until the page has loaded the result, an old page saving cannot undo it
    stale = dict(one, pieces=one["task_done"]["before"])
    c.json("PUT", f"/api/projects/{pids[0]}", stale)
    assert len(c.json("GET", f"/api/projects/{pids[0]}")[1]["project"]["pieces"]) == 3
    c.json("POST", f"/api/projects/{pids[0]}/task-seen", {})
    seen = c.json("GET", f"/api/projects/{pids[0]}")[1]["project"]
    assert seen["task_done"]["seen"] and "before" not in seen["task_done"]
    c.json("PUT", f"/api/projects/{pids[0]}", dict(seen, pieces=stale["pieces"]))        # now the page decides again
    assert len(c.json("GET", f"/api/projects/{pids[0]}")[1]["project"]["pieces"]) == 1


def test_stop_and_start_again_and_go_on_after_a_restart(web, media, monkeypatch):
    c, state = web
    fid = c.upload(media["scenes"])
    pid = new_project(c, fid, "Stop me")
    gate = threading.Event()
    real = shots.extract_all

    def slow(*a, **k):
        gate.wait(10)
        return real(*a, **k)
    monkeypatch.setattr(shots, "extract_all", slow)
    t = c.json("POST", f"/api/projects/{pid}/scenes", {})[1]
    assert t["state"] in ("queued", "running")
    t = c.json("POST", f"/api/projects/{pid}/scenes-stop", {})[1]
    assert t["state"] == "none"
    gate.set()
    time.sleep(0.5)
    assert c.json("GET", f"/api/projects/{pid}/task")[1]["task"]["state"] == "none"
    assert len(c.json("GET", f"/api/projects/{pid}")[1]["project"]["pieces"]) == 1        # nothing was changed
    # the app was closed while it was waiting: at the next start it goes on by itself
    state.edit_project(pid, task={"kind": "scenes", "since": time.time()})
    state.resume_tasks()
    assert wait_task(c, pid)["state"] == "done"


def test_scenes_need_an_edit_project_with_a_picture(web, media):
    c, state = web
    pid = new_project(c, c.upload(media["scenes"]), "Final one")
    state.edit_project(pid, stage="final")
    status, err = c.json("POST", f"/api/projects/{pid}/scenes", {})
    assert status == 400 and "Edit" in err["error"]
