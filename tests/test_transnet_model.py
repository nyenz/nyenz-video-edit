"""The real shot-change network on real (made-up) videos. Skipped when the model file is not on this computer
(put transnetv2.onnx in ~/.editforge/models, or set EDITFORGE_TRANSNET to its path)."""

import os
import subprocess
from pathlib import Path

import pytest

np = pytest.importorskip("numpy")
pytest.importorskip("onnxruntime")

from editforge.analysis import shots, transnet
from editforge.core.ffmpeg import get_tools

MODEL = Path(os.environ.get("EDITFORGE_TRANSNET") or (Path.home() / ".editforge" / "models" / transnet.MODEL_NAME))
pytestmark = pytest.mark.skipif(not MODEL.is_file(), reason="the shot-change model is not on this computer")

SRC = ["testsrc2", "mandelbrot", "rgbtestsrc", "smptehdbars", "gradients"]


def _clip(path, src, dur, extra=""):
    spec = f"{src}=s=320x180:r=25:d={dur}" if src != "mandelbrot" else f"{src}=s=320x180:r=25"
    vf = "format=yuv420p" + (("," + extra) if extra else "")
    subprocess.run([get_tools().ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", spec, "-t", str(dur), "-vf", vf, "-c:v", "libx264",
                    "-preset", "veryfast", str(path)], check=True)
    return str(path)


def _join(tmp_path, name, parts):
    lst = tmp_path / f"{name}.txt"
    lst.write_text("".join(f"file '{p}'\n" for p in parts))
    out = tmp_path / f"{name}.mp4"
    subprocess.run([get_tools().ffmpeg, "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(out)], check=True)
    return str(out)


def _find(path, duration):
    st = transnet.Streamer(MODEL)
    feats, fine = shots.extract_all(path, duration, on_big=st.push)
    probs = st.finish()
    return probs, shots.refine_fine(transnet.combine(shots.find_cuts(feats), probs, fine.rate, feats=feats), fine)


def test_hard_cuts_on_the_exact_frame(tmp_path):
    path = _join(tmp_path, "four", [_clip(tmp_path / f"s{i}.mp4", SRC[i], 3) for i in range(4)])
    probs, cuts = _find(path, 12)
    assert len(probs) == 300
    assert [c.kind for c in cuts] == ["cut", "cut", "cut"]
    for c, want in zip(cuts, (3.0, 6.0, 9.0)):
        assert abs(c.t - want) <= 0.04, (c.t, want)


def test_a_flash_is_not_a_change(tmp_path):
    a = _clip(tmp_path / "a.mp4", "testsrc2", 6, "drawbox=x=0:y=0:w=iw:h=ih:color=white@1:t=fill:enable='between(n,70,71)'")
    _, cuts = _find(a, 6)
    assert cuts == []


def test_a_dissolve_is_one_change(tmp_path):
    a = _clip(tmp_path / "a.mp4", "testsrc2", 4)
    b = _clip(tmp_path / "b.mp4", "rgbtestsrc", 4)
    out = tmp_path / "x.mp4"
    subprocess.run([get_tools().ffmpeg, "-v", "error", "-y", "-i", a, "-i", b, "-filter_complex", "xfade=transition=fade:duration=1:offset=3",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", str(out)], check=True)
    _, cuts = _find(str(out), 7)
    assert len(cuts) == 1 and abs(cuts[0].t - 3.5) <= 0.5, [(c.kind, c.t) for c in cuts]


def test_reading_alone_gives_the_same_chances(tmp_path):
    path = _join(tmp_path, "two", [_clip(tmp_path / f"t{i}.mp4", SRC[i], 3) for i in range(2)])
    together, _ = _find(path, 6)
    alone = transnet.predict(path, 25.0, model=MODEL)
    assert len(alone) == len(together) and float(np.abs(alone - together).max()) < 0.05


def test_a_hand_or_a_dip_to_black_is_not_a_change(tmp_path):
    hand = _clip(tmp_path / "h.mp4", "testsrc2", 6, "drawbox=x=0:y=0:w=iw:h=ih:color=black@1:t=fill:enable='between(n,60,64)'")
    dip = _clip(tmp_path / "d.mp4", "testsrc2", 8, "drawbox=x=0:y=0:w=iw:h=ih:color=black@1:t=fill:enable='between(n,95,110)'")
    assert _find(hand, 6)[1] == []
    assert _find(dip, 8)[1] == []


def test_fade_through_black_is_one_change(tmp_path):
    a = _clip(tmp_path / "a.mp4", "testsrc2", 4, "fade=t=out:st=3:d=1")
    b = _clip(tmp_path / "b.mp4", "mandelbrot", 4, "fade=t=in:st=0:d=1")
    _, cuts = _find(_join(tmp_path, "fade", [a, b]), 8)
    assert len(cuts) == 1 and abs(cuts[0].t - 4.0) <= 0.6, [(c.kind, c.t) for c in cuts]


def test_the_scene_finder_uses_the_network_and_keeps_its_chances(tmp_path):
    import json
    import time
    from editforge import clipsets
    path = _join(tmp_path, "three", [_clip(tmp_path / f"u{i}.mp4", SRC[i], 3) for i in range(3)])
    sf = clipsets.SceneFinder(tmp_path / "scenes", lambda s: "fp", home=MODEL.parent.parent)
    if sf.version() != clipsets.NET_VERSION:
        pytest.skip("the model file here is not the one the app expects")
    sf.start(path, 9.0, True)
    for _ in range(600):
        st = sf.status(path)
        if st["state"] in ("ready", "failed"):
            break
        time.sleep(0.1)
    assert st["state"] == "ready", st
    assert [round(t) for t in st["scenes"]] == [3, 6]
    assert json.loads((tmp_path / "scenes" / "fp.json").read_text())["v"] == clipsets.NET_VERSION
    probs, rate = sf.chances(path)
    assert rate == 25.0 and len(probs) == 225 and float(probs.max()) > 0.5


def test_looking_harder_inside_a_part_uses_the_network(tmp_path):
    import json
    import threading
    import time
    import urllib.request
    from editforge.web.server import make_server
    home = tmp_path / "home"
    (home / "models").mkdir(parents=True)
    (home / "models" / transnet.MODEL_NAME).symlink_to(MODEL)
    path = _join(tmp_path, "four", [_clip(tmp_path / f"v{i}.mp4", SRC[i], 3) for i in range(4)])
    srv, state = make_server("127.0.0.1", 0, home=home)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    def call(p, body):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        req = urllib.request.Request(f"http://127.0.0.1:{state.port}{p}", data=data, method="POST",
                                     headers={"X-EditForge-Token": state.token, "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read())
    try:
        fid = call("/api/upload?name=four.mp4", Path(path).read_bytes())["id"]
        for _ in range(600):
            got = call("/api/scenes/inside", {"id": fid, "start": 4.0, "end": 11.0, "sens": 1.8})
            if got["state"] == "ready":
                break
            time.sleep(0.1)
        assert state.scenes.chances(state.resolve_input(fid))[0] is not None
        assert len(got["cuts"]) == 2 and all(abs(a - b) <= 0.04 for a, b in zip(got["cuts"], (6.0, 9.0))), got
    finally:
        state.manager.shutdown()
        state.previews.shutdown()
        srv.shutdown()
        srv.server_close()
