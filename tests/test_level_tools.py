"""1.36: the Level tool (Light, Medium, Strong, Max, Custom), Made for (the loudness each place expects), Find problems
(silent and noisy stretches too) and Remove silence."""

from __future__ import annotations

import numpy as np
import pytest

from editforge.analysis import evenout as E
from editforge.analysis.loudness import measure_file
from editforge.project import MADE_FOR, clean_project, clean_settings, clean_shape, final_loudness, plan_project
from editforge.render.engine import RenderOptions, render


def test_level_strengths_and_custom_codes():
    assert all(E.valid(v) for v in (1, 2, 3, 4, 1000, 1122, 1244))
    assert not any(E.valid(v) for v in (0, 5, 999, 1300, 1050, 1205, "x", None))
    c = E.params(1244)
    assert c["max_up"] == 24.0 and c["max_down"] == -36.0 and c["win"] == 3
    assert E.params(1000)["win"] == 12 and E.params(1000)["max_up"] == 3.0
    assert clean_shape({"even": 4})["even"] == 4 and clean_shape({"even": 1122})["even"] == 1122 and "even" not in clean_shape({"even": 9})
    st = clean_settings({"layers": [{"file": "a.mp3", "auto": 3}, {"file": "b.mp3", "auto": 77}]})
    assert st["layers"][0]["auto"] == 3 and "auto" not in st["layers"][1]


def test_stronger_levels_even_out_more():
    sr = 8000
    t = np.arange(sr * 30) / sr
    loudness = np.where((t // 3) % 3 == 0, 0.5, 0.1)                      # 3 s loud, then 6 s at the usual level (14 dB apart)
    x = loudness * np.sin(2 * np.pi * 300 * t)
    spread = {}
    for s in (1, 3, 2, 4, 1244):
        g = E.gains(x, sr, s)
        lvl = 20 * np.log10(loudness[:: int(sr * E.HOP)][: len(g)]) + g
        spread[s] = float(np.percentile(lvl[20:-20], 95) - np.percentile(lvl[20:-20], 5))
    assert spread[1] > spread[3] > spread[2] > spread[4], spread               # Light, Medium, Strong, Max
    assert spread[4] < 4.0 and spread[1244] < 4.0                              # Max (and a fast, wide Custom) nearly flat


def test_made_for_sets_the_loudness_of_each_place():
    assert final_loudness({})["target"] == -14.0
    assert final_loudness({"made_for": "tv"}) ["target"] == -23.0 and final_loudness({"made_for": "tv"})["true_peak"] == -2.0
    assert final_loudness({"made_for": "podcast", "loudness_step": 2})["target"] == -13.0
    assert clean_settings({"made_for": "radio"})["made_for"] == "youtube" and set(MADE_FOR) == {"youtube", "tiktok", "instagram", "podcast", "tv"}


@pytest.mark.parametrize("made_for", ["podcast", "tv"])
def test_the_export_is_as_loud_as_the_place_expects(media, tmp_path, made_for):
    proj = clean_project({"name": "t", "source": "x", "pieces": [{"start": 0.0, "end": 6.0}],
                          "settings": {"quality": "small", "export_size": "source", "made_for": made_for}}, 1e9)
    plan = plan_project(proj, media["tone"], output_path=str(tmp_path / f"{made_for}.mp4"))
    res = render(plan, RenderOptions(overwrite=True))
    got = measure_file(res.output_path)
    assert abs(got["lufs"] - MADE_FOR[made_for][0]) <= 1.0, got


def test_find_problems_marks_silence_and_steady_noise(live_state, tmp_path):
    from tools.make_samples import run
    # 6 s of quiet tone, 5 s of nothing, 8 s of steady hiss
    p = tmp_path / "probs.mp4"
    run(["-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=5",
         "-f", "lavfi", "-i", "anoisesrc=amplitude=0.03:color=pink:duration=8:seed=2",
         "-filter_complex", "[0:a]volume=0.3,aformat=channel_layouts=mono:sample_rates=48000[a];[2:a]aformat=channel_layouts=mono:sample_rates=48000[c];[a][1:a][c]concat=n=3:v=0:a=1",
         "-c:a", "aac", str(p)])
    jid = live_state.store.create("", "", str(p), {})
    live_state.store.update(jid, status="done", output_path=str(p))
    got = live_state.loud_curve(jid)
    kinds = {b["kind"] for b in got["problems"]}
    assert "silent" in kinds and "noisy" in kinds, got["problems"]
    sil = [b for b in got["problems"] if b["kind"] == "silent"][0]
    assert 5.0 <= sil["start"] <= 7.5 and 9.0 <= sil["end"] <= 11.5


@pytest.fixture
def live_state(tmp_path, private_home):
    from editforge.web.server import AppState
    st = AppState("127.0.0.1", 0, home=tmp_path / "home")
    yield st
    st.manager.shutdown()
    st.previews.shutdown()
