"""1.35: a part's own sound shaping (Tone, Low / High cut, Dynamics, Clean, Nudge), volume lines, for the own sound, the
split tracks and songs; and all of it really in the finished video."""

from __future__ import annotations

import numpy as np

from editforge import project as P
from editforge.core import ffmpeg as ff
from editforge.project import clean_project, plan_project
from editforge.render.engine import RenderOptions, render


def _levels(path, n):
    """Loudness (dB RMS) of n equal stretches of a file's sound."""
    import subprocess
    raw = subprocess.run([ff.find_executable("ffmpeg"), "-v", "error", "-i", path, "-ac", "1", "-ar", "8000", "-f", "s16le", "-"],
                         capture_output=True, check=True).stdout
    x = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    return [20 * np.log10(np.sqrt(np.mean(c ** 2)) + 1e-9) for c in np.array_split(x, n)]


def test_shapes_are_cleaned_and_only_what_is_set_is_kept():
    assert P.clean_shape({"tone": "voice", "hp": 80, "lp": 4000, "dyn": 1, "nr": 2, "nudge": 35}) == \
        {"tone": "voice", "hp": 80, "lp": 4000, "dyn": 1, "nr": 2, "nudge": 35}
    assert P.clean_shape({"tone": "evil", "hp": 81, "lp": 1, "dyn": 7, "nr": 9, "nudge": 99999}) == {"nudge": 2000}
    assert P.tone_filters({"tone": "phone", "dyn": 2}) == ["highpass=f=400", "lowpass=f=3400", P.DYN[2]]
    assert P.tone_filters({"dyn": 2}, timeline=True) == []
    st = P.clean_settings({"vline": {"original": [[2, 0.2], [0, 1]], "evil": [[0, 1]]},
                           "layers": [{"file": "a.mp3", "vline": [[1, 0.5]], "shape": {"tone": "warm", "nudge": 5}}]})
    assert st["vline"] == {"original": [[0.0, 1.0], [2.0, 0.2]]}
    assert st["layers"][0]["vline"] == [[1.0, 0.5]] and st["layers"][0]["shape"] == {"tone": "warm"}
    p = clean_project({"name": "t", "source": "x", "pieces": [{"start": 0, "end": 2, "tone": "bright", "mix": {"voices": {"volume": 1, "hp": 150}}}]}, 1e9)
    assert p["pieces"][0]["tone"] == "bright" and p["pieces"][0]["mix"]["voices"]["hp"] == 150


def test_a_volume_line_turns_the_own_sound_down_where_it_goes_down(media, tmp_path):
    proj = clean_project({"name": "t", "source": "x", "pieces": [{"start": 0.0, "end": 6.0}],
                          "settings": {"quality": "small", "export_size": "source", "loudness_step": 0,
                                       "vline": {"original": [[0, 1.0], [2.9, 1.0], [3.0, 0.1], [6, 0.1]]}}}, 1e9)
    plan = plan_project(proj, media["tone"], output_path=str(tmp_path / "line.mp4"), preview=False)
    seg = plan.timeline.segments[0]
    assert seg.shape["original"]["line"]
    res = render(plan, RenderOptions(overwrite=True))
    a, b = _levels(res.output_path, 2)
    assert a - b > 12, (a, b)                    # 10 % is -20 dB; the whole mix is then made louder together


def test_tone_cuts_clean_dynamics_and_nudge_render(media, tmp_path):
    proj = clean_project({"name": "t", "source": "x", "pieces": [
        {"start": 0.0, "end": 2.0, "tone": "phone", "dyn": 2, "nr": 1, "nudge": 120},
        {"start": 2.0, "end": 4.0, "hp": 300, "lp": 4000, "nudge": -80}],
        "settings": {"quality": "small", "export_size": "source"}}, 1e9)
    plan = plan_project(proj, media["speech"], output_path=str(tmp_path / "tone.mp4"), preview=True)
    res = render(plan, RenderOptions(overwrite=True))
    assert abs(res.duration - 4.0) < 0.1


def test_song_parts_get_their_tone_and_the_song_its_line(media, tmp_path):
    layers = [{"path": media["music_tone"], "volume": 1.0, "mute": False, "solo": False,
               "parts": [{"end": 2.0, "volume": 1.0, "mute": False, "tone": "cutbass", "hp": 150}, {"end": None, "volume": 1.0, "mute": False}],
               "vline": [[0, 1.0], [3, 1.0], [3.1, 0.05]], "shape": {"dyn": 1}}]
    proj = clean_project({"name": "t", "source": "x", "pieces": [{"start": 0.0, "end": 6.0}],
                          "settings": {"quality": "small", "export_size": "source", "original_sound": False}}, 1e9)
    plan = plan_project(proj, media["silent"] if False else media["tone"], output_path=str(tmp_path / "song.mp4"), layers=layers, preview=False)
    extra = plan.timeline.audio.music[0].extra
    assert "highpass=f=150:enable='between(t,0.000,2.000)'" in extra and P.DYN[1] in extra
    res = render(plan, RenderOptions(overwrite=True))
    a, b = _levels(res.output_path, 2)
    assert a - b > 12, (a, b)
