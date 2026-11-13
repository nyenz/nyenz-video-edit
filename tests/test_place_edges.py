"""1.17 (Final, Picture): each section can have its own position of the video layer, the video layer's own edges can be
soft (no mask needed), and the sound of the video is measured for the sound track drawn under the timeline."""

from __future__ import annotations

import subprocess
import threading
import time

import pytest

from editforge.core.media import probe_media
from editforge.web.server import make_server
from test_v17 import FFMPEG, _gray
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


def white_video(tmp_path, seconds=2):
    src = tmp_path / "white.mp4"
    subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c=white:s=640x360:r=25:d={seconds}", "-f", "lavfi", "-i",
                    f"sine=frequency=440:duration={seconds}", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(src)], check=True)
    return str(src)


def render(c, proj):
    _, saved = c.json("PUT", "/api/projects/" + proj["id"], proj)
    status, job = c.json("POST", f"/api/projects/{proj['id']}/render", {"preview": False})
    assert status in (200, 201), job
    end = time.time() + 90
    while time.time() < end:
        j = next(x for x in c.json("GET", "/api/jobs")[1]["jobs"] if x["id"] == job["id"])
        if j["status"] in ("done", "failed"):
            break
        time.sleep(0.3)
    assert j["status"] == "done", j
    return saved, j["output_path"]


def test_each_section_can_have_its_own_position(web, tmp_path):
    c, state = web
    fid = c.upload(white_video(tmp_path))
    proj = c.json("POST", "/api/projects", {"source": fid, "interval": 1})[1]["project"]
    assert len(proj["pieces"]) == 2
    # the whole video: half size in the middle, black around. The second section only: moved to the right.
    proj["settings"]["frame"] = {"ratio": "16:9", "bg": "black", "scale": 0.5}
    proj["settings"]["export_size"] = "source"
    proj["pieces"][1]["place"] = {"x": 0.5, "y": 0, "scale": 0.5, "rotate": 0, "junk": 5}
    saved, out = render(c, proj)
    assert saved["pieces"][1]["place"] == {"x": 0.5, "y": 0.0, "scale": 0.5, "rotate": 0.0} and "place" not in saved["pieces"][0]
    first, second = _gray(out, 0.5, 640, 360), _gray(out, 1.5, 640, 360)
    assert first[180][320] > 200 and first[180][100] < 30 and first[180][600] < 30       # in the middle
    assert second[180][320] > 200 and second[180][540] > 200 and second[180][100] < 30   # moved right: the middle is its left half
    assert second[180][200] < 30
    # a section placed on its own works even when the whole video has no frame
    proj2 = c.json("POST", "/api/projects", {"source": fid, "interval": 1})[1]["project"]
    proj2["pieces"][0]["place"] = {"x": 0, "y": 0, "scale": 0.5, "rotate": 0}
    saved2, out2 = render(c, proj2)
    assert saved2["settings"]["frame"] is None
    a, b = _gray(out2, 0.5, 640, 360), _gray(out2, 1.5, 640, 360)
    assert a[180][320] > 200 and b[10][10] > 200                                          # the second fills the picture as before


def test_soft_edges_of_the_video_layer_without_a_mask(web, tmp_path):
    c, state = web
    fid = c.upload(white_video(tmp_path, 1))
    proj = c.json("POST", "/api/projects", {"source": fid, "interval": 0})[1]["project"]
    proj["settings"]["frame"] = {"ratio": "16:9", "bg": "black", "scale": 0.5, "edge": 0}
    proj["settings"]["export_size"] = "source"
    _, hard = render(c, proj)
    proj["settings"]["frame"]["edge"] = 60
    saved, soft = render(c, proj)
    assert saved["settings"]["frame"]["edge"] == 60
    h, s = _gray(hard, 0.5, 640, 360), _gray(soft, 0.5, 640, 360)
    # the picture spans x 160..480; at its very border the soft one fades into the black layer, its middle stays white
    assert h[180][165] > 200 and s[180][165] < 120
    assert s[180][320] > 200
    steps = lambda rows: max(abs(rows[180][x + 1] - rows[180][x]) for x in range(140, 200))
    assert steps(h) > 3 * steps(s)
    # soft edges alone count as a frame change (it is kept)
    proj["settings"]["frame"] = {"ratio": "original", "edge": 30, "scale": 0.8}
    proj["settings"]["export_size"] = "source"
    saved, _ = render(c, proj)
    assert saved["settings"]["frame"]["edge"] == 30


def test_the_sound_is_measured_for_the_timeline(web, tmp_path):
    c, state = web
    fid = c.upload(white_video(tmp_path, 2))
    end = time.time() + 30
    while time.time() < end:
        r = c.call("GET", "/api/peaks?id=" + fid)
        if r[0] == 200:
            break
        assert r[0] == 202
        time.sleep(0.2)
    status, headers, body = r
    assert status == 200 and headers.get("X-Peak-Rate") == "50"
    assert 95 <= len(body) <= 105 and 80 <= body[50] <= 100                                 # 2 s of a steady tone (sine at 1/8)
    silent = tmp_path / "silent.mp4"
    subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=white:s=320x180:r=25:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(silent)], check=True)
    sid = c.upload(str(silent))
    end = time.time() + 30
    while time.time() < end:
        r = c.call("GET", "/api/peaks?id=" + sid)
        if r[0] == 200:
            break
        time.sleep(0.2)
    assert r[0] == 200 and r[2] == b""                                                     # no sound: nothing to draw
