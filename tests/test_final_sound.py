"""Version 1.11: the Final stage's sound. The final mix always meets the YouTube standard, music never ducks,
extra music layers have volume / mute / solo, and the measured loudness is reported after the export."""

from __future__ import annotations

import subprocess
import threading

import pytest

from editforge import project as P
from editforge.analysis import loudness
from editforge.core import ffmpeg as ff
from editforge.web.server import make_server
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


def tone(path, freq, secs, db):
    subprocess.run([ff.find_executable("ffmpeg"), "-v", "error", "-y", "-f", "lavfi", "-i", f"sine=frequency={freq}:duration={secs}",
                    "-af", f"volume={db}dB", str(path)], check=True)
    return str(path)


# ------------------------------------------------------------------ pure
def test_loudness_is_parsed_and_judged():
    text = "  Integrated loudness:\n    I:         -14.2 LUFS\n    Threshold: -24.6 LUFS\n\n  Loudness range:\n    LRA:         5.2 LU\n\n  True peak:\n    Peak:       -1.3 dBFS\n"
    m = loudness.parse_ebur128(text)
    assert m == {"lufs": -14.2, "true_peak": -1.3, "lra": 5.2}
    assert loudness.judge(m)["ok"] is True
    assert loudness.judge({"lufs": -9.0, "true_peak": -0.2, "lra": 3.0})["ok"] is False        # too loud
    assert loudness.judge({"lufs": -14.0, "true_peak": -0.2, "lra": 3.0})["ok"] is False        # peaks too high
    assert loudness.parse_ebur128("I: -inf LUFS\nPeak: -inf dBFS") is None


def test_settings_keep_layers_and_solo_and_ducking_is_gone():
    st = P.clean_settings({"layers": [{"file": "u/x/a.mp3", "volume": 9, "mute": 1, "solo": 0}, {"file": ""}, "bad"] + [{"file": "f"}] * 20,
                           "mute": ["voices", "evil"], "solo": ["music"]})
    assert st["layers"][0] == {"file": "u/x/a.mp3", "volume": 2.0, "mute": True, "solo": False}
    assert 0 < len(st["layers"]) <= P.MAX_LAYERS
    assert st["mute"] == ["voices"] and st["solo"] == ["music"]


# ------------------------------------------------------------------ the whole thing
def render(c, state, media, tmp_path, settings):
    state.chooser = lambda kind, start: str(media["speech"])
    _, f = c.json("POST", "/api/choose", {"kind": "video"})
    _, r = c.json("POST", "/api/projects", {"source": f["id"], "name": "Final test", "stage": "final"})
    pid, body = r["project"]["id"], r["project"]
    body = {k: body[k] for k in ("name", "pieces", "steps", "rule", "texts")}
    body["settings"] = settings(c)
    st, _ = c.json("PUT", f"/api/projects/{pid}", body)
    assert st == 200
    st, job = c.json("POST", f"/api/projects/{pid}/render", {"preview": True})
    assert st == 201, job
    done = c.wait_jobs([job["id"]], 240)[0]
    assert done["status"] == "done", done
    return done


def test_the_final_mix_meets_the_standard_with_two_music_layers_and_reports_it(web, media, tmp_path):
    c, state = web
    loud = tone(tmp_path / "loud.wav", 220, 10, -3)            # very loud music
    quiet = tone(tmp_path / "quiet.wav", 880, 10, -30)

    def settings(c):
        a, b = c.upload(loud), c.upload(quiet)
        return {"layers": [{"file": a, "volume": 1.0}, {"file": b, "volume": 1.0}]}
    done = render(c, state, media, tmp_path, settings)
    m = done["result"]["loudness"]
    assert m is not None and m["ok"], m
    assert abs(m["lufs"] - (-14.0)) <= 1.0 and m["true_peak"] <= -0.95, m
    # measuring the file again gives the same numbers
    again = loudness.measure_file(done["output_path"])
    assert abs(again["lufs"] - m["lufs"]) < 0.11


def test_a_muted_layer_is_not_in_the_mix_and_solo_leaves_only_that_layer(web, media, tmp_path):
    c, state = web
    a = tone(tmp_path / "a.wav", 330, 10, -6)
    b = tone(tmp_path / "b.wav", 1200, 10, -6)

    def freq_energy(path, f):
        out = subprocess.run([ff.find_executable("ffmpeg"), "-v", "info", "-i", path, "-af", f"bandpass=f={f}:width_type=h:w=60,volumedetect", "-f", "null", "-"],
                             capture_output=True, text=True).stderr
        return float([l for l in out.splitlines() if "mean_volume" in l][0].split(":")[1].split()[0])

    def settings(c):
        ia, ib = c.upload(a), c.upload(b)
        return {"original_sound": False, "layers": [{"file": ia, "volume": 1.0, "solo": True}, {"file": ib, "volume": 1.0}]}
    done = render(c, state, media, tmp_path, settings)
    assert freq_energy(done["output_path"], 330) > freq_energy(done["output_path"], 1200) + 25        # only layer a is heard
    assert done["result"]["loudness"]["ok"]
