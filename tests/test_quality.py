"""No quality is lost on the way: colours are kept (and HDR is turned into normal colours), clips are made almost
lossless because they are edited again, graphics-card encoders use their best settings, and the sound is kept clean."""

from __future__ import annotations

import json
import subprocess

import pytest

from editforge import clipsets
from editforge.core.ffmpeg import get_tools
from editforge.core.media import probe_media
from editforge.project import QUALITIES, clean_project, plan_project
from editforge.render.encoders import hardware_args, video_encoder_args
from editforge.render.engine import RenderOptions, render


def _make(path, extra_v, vf="format=yuv420p"):
    subprocess.run([get_tools().ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=25:d=2", "-f", "lavfi", "-i", "sine=d=2",
                    "-vf", vf, "-c:v", "libx264", *extra_v, "-c:a", "aac", "-shortest", str(path)], check=True)
    return str(path)


def _stream(path):
    out = subprocess.run([get_tools().ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=pix_fmt,color_transfer,color_primaries,color_space,color_range", "-of", "json", path], capture_output=True, text=True).stdout
    return json.loads(out)["streams"][0]


def _export(src, tmp_path, name, **settings):
    proj = clean_project({"name": "q", "source": "x", "pieces": [{"start": 0.0, "end": 2.0}],
                          "settings": dict({"quality": "small", "export_size": "source"}, **settings)}, 1e9)
    plan = plan_project(proj, src, output_path=str(tmp_path / name))
    return plan, render(plan, RenderOptions(overwrite=True, encoder="software")).output_path


def test_the_colours_of_the_original_are_written_into_the_finished_file(tmp_path):
    src = _make(tmp_path / "709.mp4", ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"])
    plan, out = _export(src, tmp_path, "o709.mp4")
    st = _stream(out)
    assert (st["color_primaries"], st["color_transfer"], st["color_space"]) == ("bt709", "bt709", "bt709")
    assert st["pix_fmt"] == "yuv420p" and st.get("color_range") == "tv"
    assert plan.timeline.output.audio_bitrate == "320k"


def test_an_hdr_video_is_turned_into_normal_colours(tmp_path):
    if not (get_tools().has_filter("zscale") and get_tools().has_filter("tonemap")):
        pytest.skip("this FFmpeg has no zscale")
    src = _make(tmp_path / "hdr.mp4", ["-profile:v", "high10", "-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc"],
                vf="format=yuv420p10le")
    assert probe_media(src).color_transfer == "smpte2084"
    plan, out = _export(src, tmp_path, "ohdr.mp4")
    assert plan.timeline.output.hdr
    st = _stream(out)
    assert st["pix_fmt"] == "yuv420p" and (st["color_primaries"], st["color_transfer"]) == ("bt709", "bt709")


def test_clips_are_made_almost_lossless_and_the_graphics_card_uses_its_best_settings():
    cs = {"source": "x"}
    clip = {"name": "c", "parts": [{"start": 0.0, "end": 2.0}], "speed": 1.0, "volume": 1.0, "mute": False, "color": {}, "settings": {"quality": "best"}}
    assert clipsets.clip_project(cs, clip, 10.0)["settings"]["quality"] == "master" and QUALITIES["master"][0] <= 12
    clip["settings"] = {"quality": "small"}
    assert clipsets.clip_project(cs, clip, 10.0)["settings"]["quality"] == "small"      # a smaller file asked for: kept
    nv = hardware_args("h264_nvenc", 17)
    assert nv[nv.index("-preset") + 1] == "p7" and nv[nv.index("-cq") + 1] == "16" and "-spatial-aq" in nv
    from editforge.core.model import OutputSpec
    args = video_encoder_args("libx264", OutputSpec(crf=17, x264_preset="medium", color={"primaries": "bt709", "range": "tv"}), 2)
    assert args[args.index("-color_primaries") + 1] == "bt709" and args[args.index("-color_range") + 1] == "tv"
