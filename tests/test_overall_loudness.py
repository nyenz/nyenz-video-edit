"""Overall loudness (Export): seven steps around the YouTube standard, and the finished file really is that loud."""

from __future__ import annotations

import pytest

from editforge.analysis.loudness import measure_file
from editforge.project import FINAL_LOUDNESS, clean_project, clean_settings, final_loudness, plan_project
from editforge.render.engine import RenderOptions, render


def test_seven_steps_and_bad_values_are_cleaned():
    assert clean_settings({})["loudness_step"] == 0
    assert [clean_settings({"loudness_step": v})["loudness_step"] for v in (-9, -3, -1.4, 0, 2, 3, 7, "x", None)] == [-3, -3, -1, 0, 2, 3, 3, 0, 0]
    assert [final_loudness({"loudness_step": k})["target"] for k in range(-3, 4)] == [-18.5, -17.0, -15.5, -14.0, -12.5, -11.0, -9.5]
    assert final_loudness({})["true_peak"] == FINAL_LOUDNESS["true_peak"]


@pytest.mark.parametrize("step", [-2, 0, 2])
def test_the_finished_video_is_as_loud_as_chosen(media, tmp_path, step):
    proj = clean_project({"name": "t", "source": "x", "pieces": [{"start": 0.0, "end": 6.0}],
                          "settings": {"quality": "small", "export_size": "source", "loudness_step": step}}, 1e9)
    plan = plan_project(proj, media["tone"], output_path=str(tmp_path / f"o{step}.mp4"), preview=True)
    assert plan.timeline.audio.loudnorm["target"] == -14 + 1.5 * step
    res = render(plan, RenderOptions(overwrite=True))
    got = measure_file(res.output_path)
    assert abs(got["lufs"] - (-14 + 1.5 * step)) <= 1.0, got
    assert got["true_peak"] <= -1.0
