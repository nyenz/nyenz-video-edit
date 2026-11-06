"""Version 1.15: made clips live on in their own place (Made clips), also after the clip project is deleted,
and a made clip that an Edit or Final project uses can never be deleted by accident."""

from __future__ import annotations

import threading

import pytest

from editforge.web.server import make_server
from test_v17 import wait_made
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


def made_project(c, media, names=("Fight", "Chase")):
    fid = c.upload(media["colors"])
    _, v = c.json("POST", "/api/clipsets", {"source": fid, "name": "Movie"})
    cid = v["clipset"]["id"]
    clips = [{"name": n, "parts": [{"start": i * 1.5, "end": i * 1.5 + 1}]} for i, n in enumerate(names)]
    c.json("PUT", f"/api/clipsets/{cid}", dict(v["clipset"], clips=clips))
    c.json("POST", f"/api/clipsets/{cid}/make", {})
    return cid, wait_made(c, cid)


def library(c):
    status, v = c.json("GET", "/api/clips/library")
    assert status == 200
    return {x["name"]: x for x in v["clips"]}


def test_made_clips_stay_after_the_clip_project_is_deleted(web, media):
    c, state = web
    cid, v = made_project(c, media)
    lib = library(c)
    assert set(lib) == {"Fight", "Chase"}
    assert all(x["clipset"] == cid and x["current"] and not x["in_use"] and x["size"] > 0 and x["length"] > 0.5 for x in lib.values())
    assert lib["Fight"]["movie"]
    # Activity shows the clip project's making as one item (finished now)
    act = [i for i in c.json("GET", "/api/activity")[1]["items"] if i["kind"] == "clips"]
    assert len(act) == 1 and act[0]["title"] == "Movie" and act[0]["state"] == "done" and "2 clips made" in act[0]["what"]
    assert act[0]["link"] == f"/clips?c={cid}"
    # trash, then delete the clip project for good: the clips are still there, and still play
    c.json("POST", f"/api/clipsets/{cid}/trash", {})
    assert library(c)["Fight"]["clipset_trashed"]
    status, r = c.json("DELETE", f"/api/clipsets/{cid}")
    assert r["ok"]
    lib = library(c)
    assert set(lib) == {"Fight", "Chase"} and lib["Fight"]["clipset"] == "" and lib["Fight"]["movie"]
    assert state.resolve_input(lib["Fight"]["file"])
    # the old name of the list (From a made clip) shows them too
    _, made = c.json("GET", "/api/clips/made")
    assert {x["name"] for x in made["clips"]} == {"Fight", "Chase"}


def test_a_clip_in_use_shows_who_uses_it_and_cannot_be_removed(web, media):
    c, state = web
    cid, v = made_project(c, media)
    fight = library(c)["Fight"]
    _, pv = c.json("POST", "/api/projects", {"source": fight["file"], "interval": 0, "name": "My edit"})
    pid = pv["project"]["id"]
    lib = library(c)
    assert lib["Fight"]["in_use"] and [u["name"] for u in lib["Fight"]["used_by"]] == ["My edit"]
    assert not lib["Chase"]["in_use"]
    # removing it (from Made clips or from Exports) is refused with a clear message: the project would break
    status, err = c.json("DELETE", "/api/jobs/" + fight["job"])
    assert status == 400 and "My edit" in err["error"]
    assert state.resolve_input(fight["file"])
    # in the trash it still counts: it could be brought back
    c.json("POST", f"/api/projects/{pid}/trash", {})
    lib = library(c)
    assert not lib["Fight"]["in_use"] and lib["Fight"]["used_by"][0]["trashed"]
    status, err = c.json("DELETE", "/api/jobs/" + fight["job"])
    assert status == 400 and "in the trash" in err["error"]
    # once the project is gone for good, the clip can be removed
    c.json("DELETE", f"/api/projects/{pid}")
    status, r = c.json("DELETE", "/api/jobs/" + fight["job"])
    assert status == 200 and r["ok"]
    assert set(library(c)) == {"Chase"}
    # a clip nobody uses is removed at once
    status, r = c.json("DELETE", "/api/jobs/" + library(c)["Chase"]["job"])
    assert r["ok"] and library(c) == {}


def test_a_clip_made_again_keeps_only_the_newest_as_current(web, media):
    c, state = web
    cid, v = made_project(c, media, names=("Only",))
    clip = v["clipset"]["clips"][0]
    c.json("PUT", f"/api/clipsets/{cid}", dict(v["clipset"], clips=[dict(clip, parts=[{"start": 0, "end": 2}])]))
    c.json("POST", f"/api/clipsets/{cid}/make", {})
    wait_made(c, cid)
    _, lv = c.json("GET", "/api/clips/library")
    cur = [x for x in lv["clips"] if x["current"]]
    assert len(lv["clips"]) == 2 and len(cur) == 1 and cur[0]["length"] > 1.5


def test_deleting_a_project_for_good_frees_the_copies_of_its_video(web, media):
    """1.15.2: deleting the last project of a long movie frees its light copy and pictures at once (not after a month)."""
    c, state = web
    fid = c.upload(media["colors"])
    ids = [c.json("POST", "/api/clipsets", {"source": fid, "name": n})[1]["clipset"]["id"] for n in ("One", "Two")]
    fp = state._fp_of(fid)
    assert fp
    light = state.previews.folder / f"{fp}.360p.mp4"
    light.parent.mkdir(parents=True, exist_ok=True)
    light.write_bytes(b"x" * 3_000_000)
    state.thumbs.mkdir(parents=True, exist_ok=True)
    pics = [state.thumbs / f"{fp}_s{k:06d}.jpg" for k in range(3)] + [state.thumbs / f"{fp}_1500.jpg"]
    for p in pics:
        p.write_bytes(b"j" * 1000)
    (state.thumbs / f"{fp}_s.done").write_text("ok")
    other = state.thumbs / "ffffffffffffffff_1000.jpg"                 # a picture of another video stays
    other.write_bytes(b"o")
    # trash the first one and delete it for good: the second still uses the movie, so nothing is removed
    c.json("POST", f"/api/clipsets/{ids[0]}/trash", {})
    status, r = c.json("DELETE", f"/api/clipsets/{ids[0]}")
    assert r["ok"] and r["freed"] == 0 and light.exists()
    # a project in the trash still counts as using it
    c.json("POST", f"/api/clipsets/{ids[1]}/trash", {})
    assert light.exists()
    status, r = c.json("DELETE", f"/api/clipsets/{ids[1]}")
    assert r["ok"] and r["freed"] >= 3_000_000
    assert not light.exists() and not any(p.exists() for p in pics) and not (state.thumbs / f"{fp}_s.done").exists()
    assert other.exists()
