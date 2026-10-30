"""Version 1.10: the Edit stage. Button 1 (Odd / Even versions), button 2 (1 s sections, every 4th out), button 3 (scenes),
and the way on to Final."""

from __future__ import annotations

import shutil
import threading
import time

import pytest

from editforge import project as P
from editforge.core.errors import EditForgeError
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


def piece(a, b, **kw):
    return P.clean_piece(dict({"start": a, "end": b}, **kw), 1e6)


# ------------------------------------------------------------------ pure
def span(pieces):
    return [(p["start"], p["end"]) for p in pieces]


def test_button_1_odd_and_even_sections():
    odd, even = P.odd_even([piece(0, 9.3)])
    assert span(odd) == [(0.0, 2.0), (4.0, 6.0), (8.0, 9.3)]       # the last short section is kept
    assert span(even) == [(2.0, 4.0), (6.0, 8.0)]
    assert not any(p["off"] or "unit" in p for p in odd + even)


def test_button_1_needs_more_than_one_section():
    with pytest.raises(EditForgeError):
        P.odd_even([piece(0, 1.5)])


def test_button_1_counts_a_section_that_spans_a_join_as_one():
    odd, even = P.odd_even([piece(0, 3), piece(10, 13)])             # sections: 0-2, 2-3|10-11, 11-13
    assert span(odd) == [(0.0, 2.0), (11.0, 13.0)]
    assert span(even) == [(2.0, 3.0), (10.0, 11.0)]


def test_button_2_one_second_sections_every_fourth_out():
    odd, _ = P.odd_even([piece(0, 20)])                               # 0-2, 4-6, 8-10, 12-14, 16-18
    out = P.thin_pieces(odd)
    kept = [(p["start"], p["end"]) for p in out if not p["off"]]
    gone = [(p["start"], p["end"]) for p in out if p["off"]]
    assert kept == [(0.0, 1.0), (1.0, 2.0), (4.0, 5.0), (8.0, 9.0), (9.0, 10.0), (12.0, 13.0), (16.0, 17.0), (17.0, 18.0)]
    assert gone == [(5.0, 6.0), (13.0, 14.0)]                         # sections 4 and 8 of the joined video: 1 2 3 [4] 5 6 7 [8]


def test_a_section_can_grow_into_the_gap_but_not_into_the_next_section():
    odd, _ = P.odd_even([piece(0, 12)])                               # 0-2, 4-6, 8-10
    lo, hi = P.extend_limits(odd, 1, 12.0)
    assert (lo, hi) == (2.0, 8.0)


def test_meta_survives_cleaning_and_bad_values_are_dropped():
    p = P.clean_project({"source": "x", "pieces": [], "stage": "final", "parent": "0123456789ab", "version": " odd "}, 10)
    assert (p["stage"], p["parent"], p["version"]) == ("final", "0123456789ab", "odd")
    q = P.clean_project({"source": "x", "pieces": [], "stage": "evil", "parent": "../x", "version": ""}, 10)
    assert "stage" not in q and "parent" not in q and "version" not in q


# ------------------------------------------------------------------ server
def new_project(c, state, media, key="scenes"):
    state.chooser = lambda kind, start: str(media[key])
    _, f = c.json("POST", "/api/choose", {"kind": "video"})
    _, r = c.json("POST", "/api/projects", {"source": f["id"], "name": "Clip 01"})
    return r["project"]


def test_the_three_buttons_and_the_way_to_final(web, media):
    c, state = web
    proj = new_project(c, state, media)
    assert proj["stage"] == "edit"
    pid = proj["id"]
    # button 1: two versions named from the clip
    st, r = c.json("POST", f"/api/projects/{pid}/sections", {"action": "versions", "pieces": proj["pieces"]})
    assert st == 200 and [v["name"] for v in r["versions"]] == ["Clip 01 - Odd", "Clip 01 - Even"]
    odd = r["versions"][0]
    _, full = c.json("GET", f"/api/projects/{odd['id']}")
    v = full["project"]
    assert (v["stage"], v["parent"], v["version"]) == ("edit", pid, "odd")
    assert [(p["start"], p["end"]) for p in v["pieces"]] == [(0.0, 2.0), (4.0, 6.0)]            # a 6 s clip: 0-2, 2-4, 4-6
    # pressing it again does not overwrite: the names get a number
    _, r2 = c.json("POST", f"/api/projects/{pid}/sections", {"action": "versions", "pieces": proj["pieces"]})
    assert [x["name"] for x in r2["versions"]] == ["Clip 01 - Odd 2", "Clip 01 - Even 2"]
    # saving from the page keeps where the project belongs
    body = {k: v[k] for k in ("name", "pieces", "settings", "texts", "steps", "rule")}
    _, saved = c.json("PUT", f"/api/projects/{odd['id']}", body)
    assert (saved["stage"], saved["parent"], saved["version"]) == ("edit", pid, "odd")
    # the Home list knows them
    _, lst = c.json("GET", "/api/projects")
    mine = {p["id"]: p for p in lst["projects"]}
    assert mine[odd["id"]]["version"] == "odd" and mine[odd["id"]]["parent"] == pid and mine[pid]["stage"] == "edit"
    # button 2 on the open version
    st, t = c.json("POST", f"/api/projects/{odd['id']}/sections", {"action": "thin", "pieces": v["pieces"], "steps": v["steps"]})
    assert st == 200 and len(t["steps"]) == 1 and t["rule"]["action"] == "remove" and t["sections"] == len(t["pieces"])
    assert [p["off"] for p in t["pieces"]] == [False, False, False, True]          # 1 2 3 [4]
    # send it to Final
    st, fin = c.json("POST", f"/api/projects/{odd['id']}/to-final", {})
    assert st == 200
    _, got = c.json("GET", f"/api/projects/{fin['project']['id']}")
    assert got["project"]["stage"] == "final" and got["project"]["parent"] == odd["id"] and got["project"]["version"] == "odd"
    st, again = c.json("POST", f"/api/projects/{fin['project']['id']}/to-final", {})
    assert st == 400                                                     # it is already in Final


def test_button_3_separates_scenes_in_the_current_video(web, media):
    c, state = web
    proj = new_project(c, state, media)                                   # red, green, blue: 2 s each
    pid = proj["id"]
    end = time.time() + 40
    while time.time() < end:
        st, r = c.json("POST", f"/api/projects/{pid}/sections", {"action": "scenes", "pieces": proj["pieces"]})
        assert st == 200, r
        if r.get("state") == "ready":
            break
        time.sleep(0.3)
    assert r["state"] == "ready" and r["scenes"] == 3, r
    assert [(round(p["start"], 1), round(p["end"], 1)) for p in r["pieces"]] == [(0.0, 2.0), (2.0, 4.0), (4.0, 6.0)]
    assert [p["unit"] for p in r["pieces"]] == [0, 1, 2]
    # in context: odd sections 0-2 and 4-6 are two different scenes even though they are not next to each other in the clip
    odd = [piece(0, 2), piece(4, 6)]
    st, r = c.json("POST", f"/api/projects/{pid}/sections", {"action": "scenes", "pieces": odd})
    assert r["state"] == "ready" and r["scenes"] == 2
