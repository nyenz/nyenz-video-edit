"""Scene finder: real cuts are found at the right frame, and look-alikes (flashes, blinks, typing) are not cuts."""

import subprocess
import pytest

np = pytest.importorskip("numpy")

from editforge.analysis import shots
from editforge.core.ffmpeg import get_tools

SRC = ["testsrc2", "mandelbrot", "rgbtestsrc", "smptehdbars", "gradients"]


def _clip(path, src, dur, extra=""):
    spec = f"{src}=s=320x180:r=25:d={dur}" if src != "mandelbrot" else f"{src}=s=320x180:r=25"
    vf = "format=yuv420p" + (("," + extra) if extra else "")
    args = [get_tools().ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", spec, "-t", str(dur), "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", str(path)]
    subprocess.run(args, check=True)
    return str(path)


def _join(tmp_path, name, parts):
    lst = tmp_path / f"{name}.txt"
    lst.write_text("".join(f"file '{p}'\n" for p in parts))
    out = tmp_path / f"{name}.mp4"
    subprocess.run([get_tools().ffmpeg, "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(out)], check=True)
    return str(out)


def _cuts(path, duration):
    feats = shots.extract_features(path, duration)
    found = shots.refine_all(path, shots.find_cuts(feats))
    return feats, found


def test_hard_cuts_land_on_the_right_frame(tmp_path):
    parts = [_clip(tmp_path / f"s{i}.mp4", SRC[i], 3) for i in range(4)]
    path = _join(tmp_path, "four", parts)
    _, found = _cuts(path, 12)
    assert [c.kind for c in found] == ["cut", "cut", "cut"]
    for c, want in zip(found, (3.0, 6.0, 9.0)):
        assert abs(c.t - want) <= 0.04, (c.t, want)       # within one frame (25 fps)


def test_a_one_frame_flash_is_not_a_scene(tmp_path):
    a = _clip(tmp_path / "a.mp4", "testsrc2", 6, "drawbox=x=0:y=0:w=iw:h=ih:color=white@1:t=fill:enable='between(n,70,71)'")
    _, found = _cuts(a, 6)
    assert found == []


def test_a_hand_in_front_of_the_lens_for_a_moment_is_not_a_scene(tmp_path):
    a = _clip(tmp_path / "a.mp4", "testsrc2", 6, "drawbox=x=0:y=0:w=iw:h=ih:color=black@1:t=fill:enable='between(n,60,64)'")
    _, found = _cuts(a, 6)
    assert found == []


def test_fade_through_black_between_two_scenes_is_one_scene_change(tmp_path):
    a = _clip(tmp_path / "a.mp4", "testsrc2", 4, "fade=t=out:st=3:d=1")
    b = _clip(tmp_path / "b.mp4", "mandelbrot", 4, "fade=t=in:st=0:d=1")
    path = _join(tmp_path, "fade", [a, b])
    _, found = _cuts(path, 8)
    assert len(found) == 1 and abs(found[0].t - 4.0) <= 0.6, [(c.kind, c.t) for c in found]


def test_a_dip_to_black_inside_one_scene_is_not_a_scene_change(tmp_path):
    a = _clip(tmp_path / "a.mp4", "testsrc2", 8, "drawbox=x=0:y=0:w=iw:h=ih:color=black@1:t=fill:enable='between(n,95,110)'")
    _, found = _cuts(a, 8)
    assert found == []


def test_dissolve_between_two_scenes(tmp_path):
    a = _clip(tmp_path / "a.mp4", "testsrc2", 4)
    b = _clip(tmp_path / "b.mp4", "rgbtestsrc", 4)
    out = tmp_path / "x.mp4"
    subprocess.run([get_tools().ffmpeg, "-v", "error", "-y", "-i", a, "-i", b, "-filter_complex", "xfade=transition=fade:duration=1:offset=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(out)], check=True)
    _, found = _cuts(str(out), 7)
    assert len(found) == 1 and abs(found[0].t - 3.5) <= 0.5, [(c.kind, c.t) for c in found]


def test_separate_cuts_inside_pieces_and_numbers_the_scenes(tmp_path):
    parts = [_clip(tmp_path / f"s{i}.mp4", SRC[i], 3) for i in range(3)]
    path = _join(tmp_path, "three", parts)
    feats, found = _cuts(path, 9)
    pieces = [{"start": 0.0, "end": 9.0, "off": False, "speed": 1.0, "reverse": False}]
    out, scenes = shots.separate(pieces, [c.t for c in found], feats)
    assert scenes == 3 and len(out) == 3
    assert [p["unit"] for p in out] == [0, 1, 2]
    assert out[0]["end"] == out[1]["start"] and out[2]["end"] == 9.0


def test_separate_looks_at_joins(tmp_path):
    """Odd sections of a two-scene clip: the join between the last section of scene 1 and the first of scene 2 is a scene change;
    the join between two sections of the same scene is not."""
    a = _clip(tmp_path / "a.mp4", "gradients", 6)
    b = _clip(tmp_path / "b.mp4", "rgbtestsrc", 6)
    path = _join(tmp_path, "two", [a, b])
    feats, found = _cuts(path, 12)
    pieces = [{"start": s, "end": s + 2, "off": False, "speed": 1.0, "reverse": False} for s in (0.0, 4.0, 8.0)]    # 0-2, 4-6 | 8-10
    out, scenes = shots.separate(pieces, [c.t for c in found], feats)
    assert [p["unit"] for p in out] == [0, 0, 1]
    assert scenes == 2


def test_separate_without_pictures_treats_every_join_as_a_change():
    pieces = [{"start": 0.0, "end": 2.0, "off": False}, {"start": 4.0, "end": 6.0, "off": False}]
    out, scenes = shots.separate(pieces, [], None)
    assert [p["unit"] for p in out] == [0, 1] and scenes == 2
