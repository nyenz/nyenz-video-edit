"""1.37: Separate again, choosing what to pull out. What is pulled out of the chosen parts joins its own track, the chosen
track keeps the rest, the two always add up to what was there, nothing else changes, and the version before is kept."""

from __future__ import annotations

import time

import numpy as np
import pytest

from editforge import voicesplit as VS
from test_v16 import decode, film, level, scalar_engine, web  # noqa: F401  (fixtures)


def pull(c, state, film, layer, what, ranges, quality="balanced", strength="gentle"):
    proj = c.json("GET", f"/api/projects/{film['proj']['id']}")[1]["project"]
    proj["settings"]["mix_split"] = film["split"]
    c.json("PUT", f"/api/projects/{proj['id']}", proj)
    status, r = c.json("POST", f"/api/projects/{proj['id']}/resplit", {"layer": layer, "pull": what, "ranges": ranges, "quality": quality, "strength": strength})
    assert status == 200 and r["state"] == "running" and r["pull"] == what, r
    end = time.time() + 90
    while time.time() < end:
        r = c.json("GET", f"/api/projects/{proj['id']}/resplit")[1]
        if r["state"] != "running":
            break
        time.sleep(0.2)
    assert r["state"] == "done", r
    return r


OUT, IN = slice(int(44100 * 0.5), int(44100 * 1.5)), slice(int(44100 * 2.6), int(44100 * 3.4))


@pytest.mark.parametrize("strength,share", [("gentle", 0.2), ("aggressive", 0.36)])
def test_effects_pulled_out_of_music_join_the_effects_track(web, film, strength, share):  # noqa: F811
    c, state = web
    state.splitter.engine_factory = lambda path: scalar_engine           # a pretend model: 50 % voices, 30 % music, 20 % effects
    state.splitter.model_ready = lambda: True
    r = pull(c, state, film, "music", "effects", [[2.0, 4.0]], strength=strength)
    new = state.splitter.store.resolve(r["id"])
    old = state.splitter.store.resolve(film["split"])
    assert new and old and r["before"] == film["split"]                  # the version before is kept
    assert set(new["files"]) == {"voices", "music", "effects"}            # no extra track
    music, effects, voices = (decode(new["files"][k]) for k in ("music", "effects", "voices"))
    o_music, o_effects, o_voices = (decode(old["files"][k]) for k in ("music", "effects", "voices"))
    A = level(o_music[OUT], 1000)
    assert abs(level(music[OUT], 1000) - A) < 0.003 and level(effects[OUT], 1000) < 0.003        # outside: as it was
    assert abs(level(music[IN], 1000) / A - (1 - share)) < 0.04                                  # inside: the rest stays
    assert abs(level(effects[IN], 1000) / A - share) < 0.04                                      # ... and the pulled part joins Effects
    assert abs(level(effects[IN], 3000) - level(o_effects[IN], 3000)) < 0.003                    # Effects' own sound stays
    assert np.allclose(voices[: len(o_voices)], o_voices, atol=2e-4)                              # Voices is not touched
    removed = decode(new["removed"])
    assert abs(level(removed[IN], 1000) / A - share) < 0.04 and level(removed[OUT], 1000) < 0.003
    info = state.splitter.info(str(film["clip"]), 0.0, 6.0, r["id"])["split"]
    assert info["last"]["pull"] == "effects" and info["last"]["layer"] == "music" and info["removed"] is True
    assert info["last"]["from"] == film["split"]
    assert c.call("GET", f"/media?split={r['id']}&layer=removed&t={state.token}")[0] in (200, 206)


def test_voices_pulled_out_of_effects_use_the_voice_model(web, film):  # noqa: F811
    c, state = web
    seen = {}

    def fake_voice(chunk, mirror=True):
        seen["mirror"] = mirror
        seen["len"] = chunk.shape[1]
        return chunk * 0.5
    state.voice_engine_factory = lambda path: fake_voice
    try:
        r = pull(c, state, film, "effects", "voices", [[1.0, 2.5]], quality="fast")
    finally:
        del state.voice_engine_factory
    assert seen == {"mirror": False, "len": VS.CHUNK}                    # Fast: no mirror pass
    new = state.splitter.store.resolve(r["id"])
    old = state.splitter.store.resolve(film["split"])
    effects, voices = decode(new["files"]["effects"]), decode(new["files"]["voices"])
    A = level(decode(old["files"]["effects"])[slice(int(44100 * 3.5), int(44100 * 4.5))], 3000)
    inside = slice(int(44100 * 1.3), int(44100 * 2.2))
    assert abs(level(effects[inside], 3000) / A - 0.5) < 0.04 and abs(level(voices[inside], 3000) / A - 0.5) < 0.04
    assert abs(level(voices[inside], 300) - level(decode(old["files"]["voices"])[inside], 300)) < 0.003


def test_asking_for_the_same_track_or_without_a_split_is_explained(web, film):  # noqa: F811
    c, state = web
    proj = c.json("GET", f"/api/projects/{film['proj']['id']}")[1]["project"]
    proj["settings"]["mix_split"] = film["split"]
    c.json("PUT", f"/api/projects/{proj['id']}", proj)
    status, err = c.json("POST", f"/api/projects/{proj['id']}/resplit", {"layer": "music", "pull": "music", "ranges": [[1, 2]]})
    assert status == 400 and "pull out" in err["error"]


def test_passes_and_the_voice_transform():
    assert VS.passes("fast", "gentle") == 1 and VS.passes("balanced", "aggressive") == 2 and VS.passes("thorough", "aggressive") == 3
    t = np.arange(VS.CHUNK) / VS.SAMPLE_RATE
    x = np.stack([np.sin(2 * np.pi * 440 * t), 0.5 * np.sin(2 * np.pi * 1000 * t)]).astype(np.float32) * 0.3
    y = VS.istft(VS.stft(x, np), np)
    assert np.abs(y[:, 5000:-5000] - x[:, 5000:-5000]).max() < 1e-3          # what the model sees turns back into the same sound


REAL = __import__("pathlib").Path.home() / ".editforge" / "models" / VS.MODEL_FILE


@pytest.mark.skipif(not REAL.is_file(), reason="the voice model is not on this computer")
def test_the_real_voice_model_leaves_a_plain_tone_alone(tmp_path):
    from tools.make_samples import run
    src = tmp_path / "tone.wav"
    run(["-f", "lavfi", "-i", "sine=frequency=220:duration=8", "-ac", "2", "-ar", "44100", str(src)])
    out = VS.pull_out(str(src), 0.5, 7.5, tmp_path / "o", "voices", layer="music", quality="fast", voice_engine=VS.VoiceEngine(str(REAL)))
    pulled, rest = decode(out["pulled"]), decode(out["rest"])
    assert level(pulled, 220) < 0.1 * level(rest, 220)
