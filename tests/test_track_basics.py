"""1.34: loudness up to 500 % on every sound, kept clean by a soft limiter; Mute / Solo / Lock on every track."""

from __future__ import annotations

from editforge.analysis.loudness import measure_file
from editforge.project import VOL_MAX, clean_project, clean_settings, plan_project
from editforge.render.engine import RenderOptions, render


def test_every_loudness_goes_up_to_500_percent():
    assert VOL_MAX == 5.0
    st = clean_settings({"music_volume": 9, "mix_voices": 4.2, "mix_music": 7, "layers": [{"file": "a.mp3", "volume": 4.8}],
                         "mute": ["original", "music", "evil"], "solo": ["voices"]})
    assert st["music_volume"] == 5.0 and st["mix_voices"] == 4.2 and st["mix_music"] == 5.0 and st["layers"][0]["volume"] == 4.8
    assert st["mute"] == ["original", "music"] and st["solo"] == ["voices"]
    p = clean_project({"name": "t", "source": "x", "pieces": [{"start": 0, "end": 2, "volume": 4.5}, {"start": 2, "end": 3, "volume": 80}]}, 1e9)
    assert [x["volume"] for x in p["pieces"]] == [4.5, 5.0]


def test_500_percent_is_loud_but_never_clips(media, tmp_path):
    proj = clean_project({"name": "t", "source": "x", "pieces": [{"start": 0.0, "end": 5.0, "volume": 5.0}],
                          "settings": {"quality": "small", "export_size": "source"}}, 1e9)
    plan = plan_project(proj, media["tone"], output_path=str(tmp_path / "loud.mp4"), preview=True)
    res = render(plan, RenderOptions(overwrite=True))
    got = measure_file(res.output_path)
    assert got["true_peak"] <= 0.5, got                  # the limiter catches it
    assert got["lufs"] > -30


def test_a_muted_own_sound_is_silent_in_the_export(media, tmp_path):
    proj = clean_project({"name": "t", "source": "x", "pieces": [{"start": 0.0, "end": 4.0}],
                          "settings": {"quality": "small", "export_size": "source", "mute": ["original"]}}, 1e9)
    plan = plan_project(proj, media["tone"], output_path=str(tmp_path / "m.mp4"), preview=True)
    res = render(plan, RenderOptions(overwrite=True))
    assert measure_file(res.output_path)["lufs"] < -60


def test_solo_never_changes_the_export(media, tmp_path):
    proj = clean_project({"name": "t", "source": "x", "pieces": [{"start": 0.0, "end": 4.0}],
                          "settings": {"quality": "small", "export_size": "source", "solo": ["voices"]}}, 1e9)
    plan = plan_project(proj, media["tone"], output_path=str(tmp_path / "s.mp4"), preview=True)
    res = render(plan, RenderOptions(overwrite=True))
    assert measure_file(res.output_path)["lufs"] > -40
