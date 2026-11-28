"""1.40.2: a song layer is really heard in preview files and exports, with every song setting (also on Windows FFmpeg)."""
import subprocess
import pytest
from test_v16 import web, film, export, decode, level, run

def music(path):
    run(["-f", "lavfi", "-i", "sine=frequency=5000:duration=12", "-af", "volume='0.2+0.8*abs(sin(t*1.3))':eval=frame,afade=t=in:d=1", "-c:a", "libmp3lame", str(path)])
    return str(path)

CASES = {
    "auto": {"auto": 1},
    "auto_parts": {"auto": 1, "parts": [{"end": 2.0, "volume": 0.63, "fin": 0.5}, {"end": 4.0, "volume": 1.0, "even": 3, "fout": 0.3}, {"end": None, "volume": 0.8}]},
    "duck": {"auto": 1, "duck": {"on": True, "by": {"voices": 0.3, "effects": 0.1}}},
    "vline": {"auto": 1, "vline": [[0, 1.0], [2, 0.5], [5, 1.5]]},
    "shape": {"auto": 1, "shape": {"tone": "warm", "dyn": 1, "hp": 1}},
    "all": {"auto": 1, "start": 1.5, "fade_in": 0.5, "fade_out": 1.5, "duck": {"on": True, "by": {"voices": 0.3}}, "vline": [[0, 1.0], [5, 0.7]],
            "parts": [{"end": 2.0, "volume": 0.63}, {"end": None, "volume": 1.0}], "shape": {"tone": "warm"}},
}

@pytest.mark.parametrize("preview", [True, False])
@pytest.mark.parametrize("case", list(CASES))
def test_song_combo(web, film, tmp_path, case, preview):
    c, state = web
    song = c.upload(music(tmp_path / "mp3 (4).mp3"))
    st = {"mix_split": film["split"], "mix_music": 0.02, "mix_effects": 0.44, "shape": "vertical", "follow_who": "auto",
          "layers": [dict({"file": song, "volume": 0.3}, **CASES[case])]}
    job = export(c, film, st, pieces=[{"start": i * .5, "end": i * .5 + .5} for i in range(0, 12, 2)], preview=preview)
    assert job["status"] == "done", job
    y = decode(job["output_path"])
    print("SONG", case, preview, round(level(y, 5000), 4), "voice", round(level(y, 300), 4), job.get("warnings"))
    assert level(y, 5000) > 0.003


def test_plain_project_song_without_split(web, film, tmp_path):
    c, state = web
    song = c.upload(music(tmp_path / "mp3 (4).mp3"))
    for st in ({"layers": [{"file": song, "volume": 0.3}]}, {"original_sound": True, "layers": [{"file": song, "volume": 0.3, "auto": 1}]}):
        job = export(c, film, st, preview=False)
        assert job["status"] == "done", job
        y = decode(job["output_path"])
        print("SONG plain", st["layers"][0], round(level(y, 5000), 4))
        assert level(y, 5000) > 0.003
