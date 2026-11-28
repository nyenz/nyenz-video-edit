"""1.39: tall and square shapes follow the most visible person or thing of each shot (YOLOX), each cut on its own; a
section's own Track is kept in the frame; and what is found is saved per video."""

from __future__ import annotations

import math
import os
import shutil
import subprocess
from pathlib import Path

import pytest

np = pytest.importorskip("numpy")
pytest.importorskip("onnxruntime")
Image = pytest.importorskip("PIL.Image")
from PIL import ImageDraw  # noqa: E402

from editforge.analysis import subjects as SU  # noqa: E402
from editforge.core.ffmpeg import get_tools  # noqa: E402
from editforge.project import clean_project, clean_settings, plan_project  # noqa: E402
from editforge.render.engine import RenderOptions, render  # noqa: E402

MODEL = Path.home() / ".editforge" / "models" / SU.MODEL["name"]
need_model = pytest.mark.skipif(not MODEL.is_file(), reason="the tracking model is not on this computer")


def box(d, x0, y0, x1, y1, kind=0, sure=0.9):
    return [x0, y0, x1, y1, kind, sure]


def test_choosing_who_to_follow():
    # a person on the left the whole time, a car on the right: the person is followed
    s = {t / 3: [box(0, 0.1, 0.2, 0.3, 0.9), box(0, 0.7, 0.5, 0.95, 0.8, kind=2)] for t in range(12)}
    path = SU.subject_path(s, 0, 4)
    assert all(abs(x - 0.2) < 0.03 for _, x in path)
    # the person leaves after 2 s: the frame moves on to the car (the next most visible)
    s2 = {t / 3: ([box(0, 0.1, 0.2, 0.3, 0.9)] if t < 9 else []) + ([box(0, 0.7, 0.5, 0.95, 0.8, kind=2)] if t >= 8 else []) for t in range(18)}
    p2 = SU.subject_path(s2, 0, 6, feel="lively")
    assert p2[0][1] < 0.3 and p2[-1][1] > 0.7
    # nothing found: nothing to follow (the middle then)
    assert SU.subject_path({0.0: [], 1.0: []}, 0, 1) == []
    # People only: a big car alone is not followed
    assert SU.subject_path({t / 3: [box(0, 0.6, 0.1, 0.9, 0.9, kind=2)] for t in range(6)}, 0, 2, who="people") == []
    st = clean_settings({"shape": "portrait_follow", "follow_who": "people", "follow_feel": "lively", "follow_room": 1})
    assert (st["shape"], st["follow_who"], st["follow_feel"], st["follow_room"]) == ("portrait_follow", "people", "lively", True)
    assert clean_settings({"follow_who": "x"})["follow_who"] == "auto"


def _stop_sign_video(path, seconds=6):
    """A stop sign that moves from the left to the right of a 16:9 picture (the detector knows stop signs)."""
    frames = []
    W, H = 640, 360
    d = Path(path).parent / "frames"
    d.mkdir(exist_ok=True)
    for i in range(int(seconds * 10)):
        img = Image.new("RGB", (W, H), (120, 160, 200))
        g = ImageDraw.Draw(img)
        cx, cy, r = 110 + (W - 220) * i / (seconds * 10 - 1), 180, 60
        g.polygon([(cx + r * math.cos(math.radians(22.5 + 45 * k)), cy + r * math.sin(math.radians(22.5 + 45 * k))) for k in range(8)], fill=(200, 20, 30))
        g.rectangle((cx - 40, cy - 10, cx + 40, cy + 10), fill=(255, 255, 255))
        g.rectangle((cx - 5, cy + r, cx + 5, H), fill=(90, 90, 90))
        img.save(d / f"{i:04d}.png")
        frames.append(cx / W)
    subprocess.run([get_tools().ffmpeg, "-v", "error", "-y", "-framerate", "10", "-i", str(d / "%04d.png"), "-f", "lavfi", "-i",
                    f"sine=duration={seconds}", "-shortest", "-r", "25", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(path)], check=True)
    return frames


def _red_x(path, t):
    out = subprocess.run([get_tools().ffmpeg, "-v", "error", "-ss", str(t), "-i", str(path), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                         capture_output=True, check=True).stdout
    w, h = 1080, 1920
    from editforge.core.media import probe_media
    info = probe_media(str(path))
    a = np.frombuffer(out, dtype=np.uint8).reshape(info.height, info.width, 3).astype(int)
    red = (a[:, :, 0] > 150) & (a[:, :, 1] < 80) & (a[:, :, 2] < 90)
    ys, xs = np.nonzero(red)
    return (xs.mean() / info.width) if len(xs) else None


@need_model
def test_a_tall_video_follows_the_thing_that_moves(tmp_path, private_home):
    models = Path(os.environ["EDITFORGE_HOME"]) / "models"
    models.mkdir(parents=True, exist_ok=True)
    if not (models / SU.MODEL["name"]).exists():
        shutil.copyfile(MODEL, models / SU.MODEL["name"])
    src = tmp_path / "stop.mp4"
    _stop_sign_video(src)
    proj = clean_project({"name": "t", "source": "x", "pieces": [{"start": 0.0, "end": 6.0}],
                          "settings": {"quality": "small", "shape": "vertical_follow", "follow_feel": "lively"}}, 1e9)
    plan = plan_project(proj, str(src), output_path=str(tmp_path / "tall.mp4"), preview=True)
    seg = plan.timeline.segments[0]
    assert seg.reframe.mode == "subject" and len(seg.reframe.path) >= 2
    assert seg.reframe.path[0][1] < 0.35 and seg.reframe.path[-1][1] > 0.6        # the path goes from left to right
    res = render(plan, RenderOptions(overwrite=True))
    for t in (1.5, 3.0, 4.5):
        x = _red_x(res.output_path, t)
        assert x is not None and 0.2 < x < 0.8, (t, x)                            # the sign stays in the tall frame
    # found once: saved, so a second plan does not look again
    from editforge.core.fingerprint import file_fingerprint
    assert (Path(os.environ["EDITFORGE_HOME"]) / "subjects" / (file_fingerprint(str(src)) + ".json")).is_file()


def test_a_sections_own_track_is_kept_in_a_tall_frame(media, tmp_path):
    proj = clean_project({"name": "t", "source": "x", "pieces": [{"start": 0.0, "end": 3.0, "follow": {"mode": "object", "path": [[0, 0.1, 0.5], [3, 0.9, 0.5]]}}],
                          "settings": {"quality": "small", "shape": "vertical"}}, 1e9)
    plan = plan_project(proj, media["tone"], output_path=str(tmp_path / "own.mp4"), preview=True)
    r = plan.timeline.segments[0].reframe
    assert r.mode == "path" and r.path[0][1] == 0.1 and r.path[-1][1] == 0.9
    assert not any("only works with the original shape" in w for w in plan.warnings)
    assert render(plan, RenderOptions(overwrite=True)).output_path


def test_track_every_section_keeps_the_thing_in_the_middle_of_a_tall_frame(tmp_path):
    """What Track every section writes (the picture moves the other way to the sign) keeps the sign in the middle."""
    src = tmp_path / "stop.mp4"
    _stop_sign_video(src)
    path = [[0, 1.77, 0], [1, 1.44, 0], [4.67, -1.14, 0], [5.33, -1.51, 0], [5.67, -1.51, 0]]
    proj = clean_project({"name": "t", "source": "x", "pieces": [{"start": 0, "end": 6, "place": {"x": 0, "y": 0, "scale": 3.1605, "rotate": 0,
                                                                                               "track": {"path": path, "found": 1, "axes": "x", "auto": True}}}],
                          "settings": {"quality": "small", "frame": {"ratio": "9:16", "scale": 3.1605}}}, 1e9)
    assert proj["pieces"][0]["place"]["track"]["auto"] is True
    res = render(plan_project(proj, str(src), output_path=str(tmp_path / "o.mp4"), preview=True), RenderOptions(overwrite=True))
    for t in (1, 3, 5):
        x = _red_x(res.output_path, t)
        assert x is not None and abs(x - 0.5) < 0.15, (t, x)
