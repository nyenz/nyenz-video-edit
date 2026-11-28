"""Studio: open any video (also a finished export), markers, colour looks, less grain and steady shots."""
from __future__ import annotations

import subprocess
import threading

import numpy as np
import pytest

from editforge import project as P
from editforge.core import ffmpeg as ff
from editforge.dsl import registry
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


def test_markers_are_cleaned_sorted_and_capped():
    raw = [{"t": 5, "note": "b"}, {"t": "1.23456", "note": "a" * 200}, {"t": -1}, {"t": "x"}, "bad", {"note": "no time"}]
    out = P.clean_markers(raw)
    assert out == [{"t": 1.235, "note": "a" * 80}, {"t": 5.0, "note": "b"}]
    assert len(P.clean_markers([{"t": i} for i in range(500)])) == P.MARKERS_MAX
    assert P.clean_settings({"markers": raw})["markers"] == out
    assert P.clean_settings({})["markers"] == []


def test_new_looks_and_warmth_are_known_and_kept():
    assert "denoise" in registry.EFFECT_NAMES and "stabilize" in registry.EFFECT_NAMES
    assert P.STAGES == ("edit", "final", "studio")
    piece = P.clean_project({"name": "x", "source": "s", "pieces": [{"start": 0, "end": 2, "fx": ["denoise", "stabilize", "evil"],
                                                                    "color": {"warmth": 3}}]}, 5)["pieces"][0]
    assert piece["fx"] == ["denoise", "stabilize"] and piece["color"]["warmth"] == 1.0


def mean_rgb(path, t=1.0):
    raw = subprocess.run([ff.find_executable("ffmpeg"), "-v", "error", "-ss", str(t), "-i", str(path), "-frames:v", "1",
                          "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "64x36", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(36, 64, 3).astype(float).mean(axis=(0, 1))


def test_studio_opens_a_finished_export_and_renders_warm_steady_and_clean(web, media):
    c, state = web
    state.chooser = lambda kind, start: str(media["ramp"])
    _, f = c.json("POST", "/api/choose", {"kind": "video"})
    st, r = c.json("POST", "/api/projects", {"source": f["id"], "interval": 0, "stage": "studio"})
    assert st == 201, r
    proj = r["project"]
    assert proj["stage"] == "studio" and len(proj["pieces"]) == 1
    st, _, page = c.call("GET", "/studio?p=" + proj["id"])
    assert st == 200 and b"studioTools" in page
    # a plain export first, to compare the colour
    def export(pieces, settings=None):
        body = {k: proj[k] for k in ("name", "steps", "rule", "texts")}
        body["pieces"], body["settings"] = pieces, settings or {}
        assert c.json("PUT", f"/api/projects/{proj['id']}", body)[0] == 200
        st, job = c.json("POST", f"/api/projects/{proj['id']}/render", {"preview": False})
        assert st == 201, job
        done = c.wait_jobs([job["id"]], 240)[0]
        assert done["status"] == "done", done
        return done
    plain = export(proj["pieces"])
    p2 = dict(proj["pieces"][0], fx=["denoise", "stabilize"], color={"brightness": 0, "contrast": 1, "saturation": 1, "warmth": 1})
    warm = export([p2], {"markers": [{"t": 1, "note": "here"}]})
    a, b = mean_rgb(plain["output_path"]), mean_rgb(warm["output_path"])
    assert (b[0] - b[2]) > (a[0] - a[2]) + 4, (a, b)            # warmer: more red than blue
    _, saved = c.json("GET", f"/api/projects/{proj['id']}")
    assert saved["project"]["settings"]["markers"] == [{"t": 1.0, "note": "here"}]
    # the export is in the Studio group, and it can itself be opened in Studio
    _, jobs = c.json("GET", "/api/jobs")
    mine = [j for j in jobs["jobs"] if j["id"] == warm["id"]][0]
    assert mine["group"] == "studio" and mine.get("file_id")
    st, r2 = c.json("POST", "/api/projects", {"source": mine["file_id"], "interval": 0, "stage": "studio"})
    assert st == 201 and r2["project"]["stage"] == "studio", r2
