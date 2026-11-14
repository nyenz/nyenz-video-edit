"""Version 1.6: split a video's sound into voices / music / effects and mix the layers."""

from __future__ import annotations

import json
import subprocess
import shutil
import threading
import time
import urllib.parse
from pathlib import Path

import pytest

from editforge import project as P
from editforge import splitter as S
from editforge.core import ffmpeg as ff
from editforge.core.fingerprint import file_fingerprint
from editforge.web.server import make_server
from test_web_workshop import Client

np = pytest.importorskip("numpy")
ROOT = Path(__file__).resolve().parent.parent
FFMPEG = ff.find_executable("ffmpeg")


def run(args):
    subprocess.run([FFMPEG, "-v", "error", "-y"] + args, check=True)


def decode(path, seconds=None):
    """The sound of a file as a mono float array at 44.1 kHz."""
    cmd = [FFMPEG, "-v", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", "44100", "-f", "f32le", "-"]
    return np.frombuffer(subprocess.run(cmd, capture_output=True, check=True).stdout, dtype=np.float32)


def level(x, hz, sr=44100):
    """How much of a pure tone of ``hz`` is in ``x`` (amplitude)."""
    t = np.arange(len(x)) / sr
    return float(abs(np.mean(x * np.exp(-2j * np.pi * hz * t)))) * 2


def scalar_engine(chunk, fast=True):
    """A pretend model that splits every sound 50 / 30 / 20 (so the three layers add up to the original)."""
    return np.stack([chunk * 0.5, chunk * 0.3, chunk * 0.2])


# ---------------------------------------------------------------------------------------- the transforms
def test_stft_and_back_gives_the_same_sound():
    rng = np.random.default_rng(1)
    x = (rng.standard_normal((2, S.CHUNK)) * 0.1).astype(np.float32)
    spec = S.stft(x, np)
    assert spec.shape == (2, S.BINS, S.FRAMES, 2)
    y = S.istft(spec, np, S.CHUNK)
    assert y.shape == x.shape
    assert float(np.abs(y - x).max()) < 1e-3


# ---------------------------------------------------------------------------------------- the streaming split
def test_splitting_in_chunks_keeps_every_sample_and_the_layers_add_up(tmp_path):
    src = tmp_path / "mix.wav"                          # 20 s: three chunks of 6 s and a short end
    run(["-f", "lavfi", "-i", "sine=frequency=330:duration=20", "-f", "lavfi", "-i", "anoisesrc=amplitude=0.05:duration=20:seed=2",
         "-filter_complex", "[0:a]volume=0.3[a];[a][1:a]amix=inputs=2:normalize=0,pan=stereo|c0=c0|c1=c0", str(src)])
    out = tmp_path / "layers"
    seen = []
    S.split_sound(str(src), 0.0, 20.0, out, scalar_engine, progress=seen.append)
    assert seen and seen[-1] > 0.9 and seen == sorted(seen)
    original = decode(src)
    parts = [decode(out / (k + ".flac")) for k in S.LAYERS]
    assert all(abs(len(p) - len(original)) < 50 for p in parts)
    n = min(len(original), *[len(p) for p in parts])
    total = sum(p[:n] for p in parts)
    assert float(np.abs(total - original[:n]).max()) < 0.003
    assert abs(float(np.sqrt(np.mean(parts[0][:n] ** 2)) / np.sqrt(np.mean(original[:n] ** 2))) - 0.5) < 0.02     # voices = 50 %


def test_splitting_part_of_a_video_and_stopping(tmp_path):
    src = tmp_path / "long.wav"
    run(["-f", "lavfi", "-i", "sine=frequency=500:duration=30", str(src)])
    out = tmp_path / "part"
    S.split_sound(str(src), 10.0, 18.0, out, scalar_engine)
    got = decode(out / "voices.flac")
    assert abs(len(got) / 44100 - 8.0) < 0.05
    stop = threading.Event()
    stop.set()
    with pytest.raises(S.Cancelled):
        S.split_sound(str(src), 0.0, 30.0, tmp_path / "never", scalar_engine, cancel=stop)
    assert not list((tmp_path / "never").glob("*.flac*"))


def test_the_ai_model_file_runs_through_onnxruntime(tmp_path):
    ort = pytest.importorskip("onnxruntime")
    model = ROOT / "tests" / "data" / "split_test.onnx"        # a tiny stand-in: three fixed fractions of the input
    assert model.is_file()
    eng = S.Engine(str(model), threads=1)
    rng = np.random.default_rng(2)
    x = (rng.standard_normal((2, S.CHUNK)) * 0.1).astype(np.float32)
    y = eng(x)
    assert y.shape == (3, 2, S.CHUNK)
    assert float(np.abs(y.sum(axis=0) - x).max()) < 2e-3


# ---------------------------------------------------------------------------------------- the job and the store
@pytest.fixture(autouse=True)
def _stand_in_model_size(monkeypatch):
    monkeypatch.setattr(S, "MODEL_SIZE", 0)          # the tests use stand-in model files, not the real 76 MB one


def make_splitter(tmp_path):
    fake = tmp_path / "models" / S.MODEL_FILE
    fake.parent.mkdir(parents=True, exist_ok=True)
    fake.write_bytes(b"x" * 1_100_000)
    return S.Splitter(tmp_path, engine_factory=lambda p: scalar_engine, model_path=str(fake))


def wait(sp, states=("ready", "failed", "idle"), timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        st = sp.status()
        if st["state"] in states:
            return st
        time.sleep(0.05)
    raise AssertionError(sp.status())


def test_split_job_stores_layers_once_and_finds_them_again(tmp_path, media):
    sp = make_splitter(tmp_path)
    src = media["speech"]
    before = sp.info(src, 0, 6)
    assert before["available"] and before["model"] and before["split"] is None and before["estimate_s"] >= 1
    sp.start(src, 0, 6)
    st = wait(sp)
    assert st["state"] == "ready", st
    after = sp.info(src, 1, 5)                         # a smaller part is covered by the bigger split
    assert after["split"] and after["split"]["id"] == st["id"]
    assert sp.info(src, 0, 8)["split"] is None         # a bigger one is not
    again = sp.start(src, 1, 4)                        # nothing to do: it is already there
    assert again["state"] == "ready"
    found = sp.store.resolve(st["id"])
    assert found and set(found["files"]) == set(S.LAYERS)
    assert sp.store.resolve("../../etc/passwd") is None and sp.store.resolve(st["id"] + "/x") is None
    assert sp.store.delete(st["id"]) > 0 and sp.store.find(file_fingerprint(src), 1, 5) is None


def test_split_without_sound_or_too_short_is_refused(tmp_path, media):
    sp = make_splitter(tmp_path)
    with pytest.raises(Exception) as e:
        sp.start(media["silent"], 0, 3)
    assert "no sound" in str(e.value)
    with pytest.raises(Exception) as e:
        sp.start(media["speech"], 1, 1.2)
    assert "too short" in str(e.value)


def test_model_download_is_checked_and_only_from_github(tmp_path, monkeypatch):
    sp = S.Splitter(tmp_path, engine_factory=lambda p: scalar_engine)
    assert not sp.model_ready()
    monkeypatch.setattr(S, "MODEL_SHA256", "")
    with pytest.raises(Exception) as e:
        sp._download_model()
    assert "not available" in str(e.value)
    monkeypatch.setattr(S, "MODEL_SHA256", "ab" * 32)
    monkeypatch.setattr(S, "MODEL_URL", "http://evil.example/model.onnx")
    with pytest.raises(Exception) as e:
        sp._download_model()
    assert "not available" in str(e.value)


# ---------------------------------------------------------------------------------------- mixing in the project and the export
@pytest.fixture(scope="module")
def web(tmp_path_factory):
    srv, state = make_server("127.0.0.1", 0, home=tmp_path_factory.mktemp("v16_home"))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield Client(state.port, state.token), state
    state.manager.shutdown()
    state.previews.shutdown()
    srv.shutdown()
    srv.server_close()


TONES = {"voices": 300, "music": 1000, "effects": 3000}


@pytest.fixture(scope="module")
def film(web, tmp_path_factory):
    """A 6 s clip whose sound is three tones (voices 300 Hz, music 1000 Hz, effects 3000 Hz), already 'split' into those layers."""
    c, state = web
    d = tmp_path_factory.mktemp("film")
    clip = d / "film.mp4"
    inputs = []
    for hz in TONES.values():
        inputs += ["-f", "lavfi", "-i", f"sine=frequency={hz}:duration=6"]
    run(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=6"] + inputs +
        ["-filter_complex", "[1:a][2:a][3:a]amix=inputs=3:normalize=0,volume=0.3,pan=stereo|c0=c0|c1=c0[a]", "-map", "0:v", "-map", "[a]",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "256k", "-shortest", str(clip)])
    fp = file_fingerprint(str(clip))
    folder = S.SplitStore(state.home).folder(fp, 0.0, 6.0)
    folder.mkdir(parents=True)
    for name, hz in TONES.items():
        run(["-f", "lavfi", "-i", f"sine=frequency={hz}:duration=6", "-af", "volume=0.3,pan=stereo|c0=c0|c1=c0", "-c:a", "flac", str(folder / (name + ".flac"))])
    S.SplitStore(state.home).write_meta(folder, 0.0, 6.0, 1.0, "fast")
    state.chooser = lambda kind, start: str(clip)
    fid = c.json("POST", "/api/choose", {"kind": "video"})[1]["id"]
    proj = c.json("POST", "/api/projects", {"source": fid, "interval": 0})[1]["project"]
    return {"clip": clip, "fid": fid, "proj": proj, "split": f"{fp}/{folder.name}", "folder": folder}


def export(c, film, settings, pieces=None, preview=True):
    p = dict(film["proj"], settings=settings)
    if pieces is not None:
        p["pieces"] = pieces
    assert c.json("PUT", f"/api/projects/{p['id']}", p)[0] == 200
    status, body = c.json("POST", f"/api/projects/{p['id']}/render", {"preview": preview})
    assert status in (200, 201, 202), body
    job = c.wait_jobs([body["id"]], 180)[0]
    return job


def test_layer_settings_are_cleaned():
    s = P.clean_settings({"mix_split": "../x", "mix_music": 9, "mix_voices": -3, "mix_effects": "loud"})
    assert s["mix_split"] == "" and s["mix_music"] == 2.0 and s["mix_voices"] == 0.0 and s["mix_effects"] == 1.0
    good = "a" * 32 + "/000000000-000006000"
    assert P.clean_settings({"mix_split": good})["mix_split"] == good


def test_turning_a_layer_off_removes_only_that_layer_from_the_export(web, film):
    c, state = web
    base = export(c, film, {})
    assert base["status"] == "done", base
    x = decode(base["output_path"])
    for hz in TONES.values():
        assert level(x, hz) > 0.03                     # the plain export keeps all three
    job = export(c, film, {"mix_split": film["split"], "mix_music": 0.0})
    assert job["status"] == "done", job
    y = decode(job["output_path"])
    assert level(y, 1000) < 0.003                      # music gone
    assert level(y, 300) > 0.03 and level(y, 3000) > 0.03
    job = export(c, film, {"mix_split": film["split"], "mix_voices": 2.0, "mix_effects": 0.5})
    z = decode(job["output_path"])
    assert level(z, 300) > 1.7 * level(x, 300) * 0.5 and level(z, 3000) < 0.7 * level(x, 3000)       # voices louder, effects quieter


def test_layers_follow_the_cuts_and_the_speed(web, film):
    c, state = web
    pieces = [{"start": 1.0, "end": 3.0}, {"start": 4.0, "end": 5.0, "speed": 2.0}]
    job = export(c, film, {"mix_split": film["split"], "mix_effects": 0.0}, pieces=pieces)
    assert job["status"] == "done", job
    y = decode(job["output_path"])
    assert abs(len(y) / 44100 - 2.5) < 0.2
    assert level(y[: 44100 * 2], 3000) < 0.003 and level(y[: 44100 * 2], 300) > 0.03


def test_a_part_outside_the_split_is_explained(web, film, tmp_path):
    c, state = web
    folder = S.SplitStore(state.home).folder(file_fingerprint(str(film["clip"])), 2.0, 4.0)
    folder.mkdir(parents=True)
    for name in S.LAYERS:
        run(["-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "flac", str(folder / (name + ".flac"))])
    S.SplitStore(state.home).write_meta(folder, 2.0, 4.0, 1.0, "fast")
    sid = f"{file_fingerprint(str(film['clip']))}/{folder.name}"
    p = dict(film["proj"], settings={"mix_split": sid, "mix_music": 0.0}, pieces=[{"start": 0.0, "end": 5.0}])
    c.json("PUT", f"/api/projects/{p['id']}", p)
    status, body = c.json("POST", f"/api/projects/{p['id']}/render", {"preview": True})
    assert status == 400 and "outside" in body["error"] and "Split again" in body["fix"]


def test_a_missing_split_falls_back_to_the_original_sound_with_a_note(web, film):
    c, state = web
    fake = film["split"].split("/")[0] + "/000000000-000099000"
    job = export(c, film, {"mix_split": fake, "mix_music": 0.0})
    assert job["status"] == "done"
    assert level(decode(job["output_path"]), 1000) > 0.03          # the original sound, music included


def test_layers_are_served_with_range_support_and_nothing_else(web, film):
    c, state = web
    q = urllib.parse.quote(film["split"], safe="")
    status, _, body = c.call("GET", f"/media?split={q}&layer=music", headers={"Range": "bytes=0-99"})
    assert status == 206 and len(body) == 100 and body[:4] == b"fLaC"
    assert c.call("GET", f"/media?split={q}&layer=bass")[0] == 404
    assert c.call("GET", "/media?split=..%2F..%2Fx&layer=music")[0] == 404


def test_split_endpoints_and_storage(web, film):
    c, state = web
    status, info = c.json("GET", f"/api/split?id={urllib.parse.quote(film['fid'], safe='')}")
    assert status == 200 and info["split"]["id"] == film["split"] and "estimate_s" in info
    status, st = c.json("GET", "/api/storage")
    assert st["sizes"]["stems"] > 0
    c.json("PUT", f"/api/projects/{film['proj']['id']}", dict(film["proj"], settings={"mix_split": film["split"]}))
    c.json("POST", "/api/storage/clean", {"what": "stems"})
    assert S.SplitStore(state.home).resolve(film["split"])         # the one a project uses stays
    assert S.SplitStore(state.home).resolve(film["split"].split("/")[0] + "/000002000-000004000") is None   # the unused one is removed


# ---------------------------------------------------------------------------------------- how clean the split is (honest report)
def test_split_quality_reports_the_shares_and_how_well_the_layers_add_back(tmp_path):
    src = tmp_path / "mix.wav"
    run(["-f", "lavfi", "-i", "sine=frequency=330:duration=8", "-ac", "2", str(src)])
    good = {}
    S.split_sound(str(src), 0.0, 8.0, tmp_path / "good", scalar_engine, stats=good)
    assert good["rebuild_db"] >= 40                                       # 50 + 30 + 20 adds back to the original
    assert good["share"]["voices"] > good["share"]["music"] > good["share"]["effects"]
    assert abs(sum(good["share"].values()) - 100) < 0.5 and good["benchmark_sdr"] == S.BENCHMARK_SDR
    lossy = {}
    S.split_sound(str(src), 0.0, 8.0, tmp_path / "lossy", lambda chunk, fast=True: np.stack([chunk * 0.3, chunk * 0.1, chunk * 0.1]), stats=lossy)
    assert 4 <= lossy["rebuild_db"] <= 8                                  # half the amplitude is missing: about 6 dB


# ------------------------------------------------------------------ 1.12: the installer downloads the AI models
def test_model_list_is_complete_and_the_installer_include_is_up_to_date(tmp_path):
    from editforge import modelpack
    import importlib.util
    root = Path(__file__).resolve().parent.parent
    names = {(f["model"], f["name"]) for f in modelpack.FILES}
    assert ("sound", "sound-split-1.onnx") in names
    assert {n for m, n in names if m == "captions"} == {"config.json", "model.bin", "tokenizer.json", "vocabulary.txt"}
    sound = next(f for f in modelpack.FILES if f["model"] == "sound")
    assert (sound["url"], sound["size"], sound["sha256"]) == ("https://github.com/nyenz/nyenz-video-edit/releases/download/sound-model-1/sound-split-1.onnx", 76080146, "b43c4978c07667b2c6e6aed8c3c1ad5b263a96f8fbc8faead2cec45971646d4d")
    import editforge.splitter as sp_
    assert sp_.MODEL_URL == sound["url"] and sp_.MODEL_SHA256 == sound["sha256"]
    for f in modelpack.FILES:
        assert str(f["url"]).startswith("https://github.com/nyenz/nyenz-video-edit/releases/download/")
        assert len(str(f["sha256"])) == 64 and int(f["size"]) > 0
    spec = importlib.util.spec_from_file_location("make_models_iss", root / "tools" / "make_models_iss.py")
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    assert (root / "packaging" / "models.iss").read_text(encoding="utf-8") == mod.build()    # run tools/make_models_iss.py if this fails
    assert '#include "models.iss"' in (root / "packaging" / "installer.iss").read_text(encoding="utf-8")


def test_captions_use_the_model_the_installer_put_in_place(tmp_path):
    from editforge import modelpack
    assert modelpack.local_whisper(tmp_path) is None                                  # nothing there yet: the first use downloads it
    folder = tmp_path / "models" / modelpack.WHISPER_DIR
    folder.mkdir(parents=True)
    for f in modelpack.FILES:
        if f["model"] == "captions":
            (folder / str(f["name"])).write_bytes(b"x" * int(f["size"]))
    assert modelpack.local_whisper(tmp_path) == str(folder)
    (folder / "model.bin").write_bytes(b"short")                                      # a broken copy is not used
    assert modelpack.local_whisper(tmp_path) is None


def test_missing_models_are_downloaded_checked_and_only_then_put_in_place(tmp_path, monkeypatch):
    import hashlib
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from editforge import modelpack
    good, bad = b"model bytes" * 50, b"wrong bytes" * 50

    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            body = good if self.path.endswith("good.bin") else bad
            self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

        def log_message(self, *a):
            pass
    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}/"
    try:
        monkeypatch.setattr(modelpack, "RELEASES", base)
        sha = hashlib.sha256(good).hexdigest()
        f1 = {"model": "t", "dir": "x", "name": "a.bin", "url": base + "good.bin", "size": len(good), "sha256": sha}
        f2 = {"model": "t", "dir": "x", "name": "b.bin", "url": base + "bad.bin", "size": len(good), "sha256": sha}
        monkeypatch.setattr(modelpack, "FILES", [f1, f2])
        assert modelpack.missing(tmp_path) == [f1, f2]
        seen = []
        modelpack.download(f1, tmp_path, seen.append)
        assert seen and seen[-1] == len(good) and modelpack.missing(tmp_path) == [f2]
        with pytest.raises(ValueError):
            modelpack.download(f2, tmp_path)                                   # wrong fingerprint: nothing is kept
        assert not (tmp_path / "models" / "x" / "b.bin").exists() and not list((tmp_path / "models" / "x").glob("*.part"))
        with pytest.raises(ValueError):
            modelpack.download(dict(f1, url="http://elsewhere.example/a.bin"), tmp_path)   # only from the releases
    finally:
        srv.shutdown()


def test_update_that_cannot_start_says_so_instead_of_hanging(tmp_path, monkeypatch):
    import editforge.updater as U
    u = U.Updater(tmp_path)
    u.job = {"state": "ready", "progress": 1.0, "error": "", "path": str(tmp_path / "missing-setup.exe")}

    def boom(*a, **k):
        raise OSError("cannot run it")
    monkeypatch.setattr(U.subprocess, "Popen", boom)
    quit_called = []
    u.install(lambda: False, lambda: quit_called.append(1))
    for _ in range(100):
        if u.status()["job"]["state"] == "failed":
            break
        time.sleep(0.02)
    assert u.status()["job"]["state"] == "failed" and "could not be started" in u.status()["job"]["error"]
    assert not quit_called                                                       # the app stays open


def test_the_light_copy_pass_also_makes_one_timeline_picture_per_second(tmp_path):
    from editforge.web.preview import PreviewMaker
    src = tmp_path / "six.mp4"
    subprocess.run([FFMPEG_EXE(), "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(src)], check=True)
    pm = PreviewMaker(tmp_path / "previews", tmp_path / "thumbs")
    pm.start(str(src))
    for _ in range(300):
        if pm.status(str(src))["state"] in ("ready", "failed"):
            break
        time.sleep(0.1)
    assert pm.status(str(src))["state"] == "ready" and pm.strip_done(str(src))
    pics = sorted((tmp_path / "thumbs").glob("*_s0*.jpg"))
    assert 6 <= len(pics) <= 7
    assert pm.strip_picture(str(src), 3.0) is not None and pm.strip_picture(str(src), 3.0).name.endswith("_s000003.jpg")
    # an older light copy without pictures gets them in a quick second pass
    for p in pics:
        p.unlink()
    next((tmp_path / "thumbs").glob("*_s.done")).unlink()
    pm.ensure_strip(str(src))
    for _ in range(200):
        if pm.strip_done(str(src)):
            break
        time.sleep(0.1)
    assert pm.strip_done(str(src)) and pm.strip_picture(str(src), 5.0) is not None
    pm.shutdown()


def FFMPEG_EXE():
    from editforge.core import ffmpeg as ff
    return ff.find_executable("ffmpeg")


def test_each_piece_can_have_its_own_layer_loudness(web, film):
    """1.19: the split sound tracks on the timeline: one piece mutes the music, the other keeps it (sliders all at 100%)."""
    c, state = web
    pieces = [{"start": 0.0, "end": 2.0, "mix": {"music": {"volume": 1.0, "mute": True}, "voices": {"volume": 1, "mute": False}}},
              {"start": 2.0, "end": 4.0}]
    job = export(c, film, {"mix_split": film["split"]}, pieces=pieces)
    assert job["status"] == "done", job
    saved = c.json("GET", f"/api/projects/{film['proj']['id']}")[1]["project"]
    assert saved["pieces"][0]["mix"] == {"music": {"volume": 1.0, "mute": True}}        # untouched layers are left out
    assert "mix" not in saved["pieces"][1]
    y = decode(job["output_path"])
    first, second = y[int(44100 * 0.3): int(44100 * 1.7)], y[int(44100 * 2.3): int(44100 * 3.7)]
    assert level(first, 1000) < 0.003 and level(first, 300) > 0.03 and level(first, 3000) > 0.03
    assert level(second, 1000) > 0.03
    # half loud voices on the second piece only
    pieces[1]["mix"] = {"voices": {"volume": 0.5, "mute": False}}
    job = export(c, film, {"mix_split": film["split"]}, pieces=pieces)
    z = decode(job["output_path"])
    a, b = z[int(44100 * 0.3): int(44100 * 1.7)], z[int(44100 * 2.3): int(44100 * 3.7)]
    assert 0.35 < level(b, 300) / level(a, 300) < 0.65


# ---------------------------------------------------------------------------------------- 1.20: sound design on the tracks
def test_locks_groups_and_group_marks_are_kept():
    s = P.clean_settings({"locks": {"music": True, "voices": 0, "junk": True},
                          "sound_groups": [{"id": "g1abc", "name": "Vocals in music", "locked": True}, {"id": "../x", "name": "bad"}]})
    assert s["locks"] == {"video": False, "sound": False, "voices": False, "music": True, "effects": False, "found": False, "found_voices": False, "found_music": False, "found_effects": False}
    assert s["sound_groups"] == [{"id": "g1abc", "name": "Vocals in music", "locked": True}]
    mix = P.clean_piece_mix({"music": {"volume": 1, "mute": False, "group": "g1abc"}, "voices": {"volume": 1, "group": "bad id"}})
    assert mix == {"music": {"volume": 1.0, "mute": False, "group": "g1abc"}}
    assert P.piece_layer_gain({"mix": mix}) is None                    # in a group, but at full loudness: nothing changes in the mix
    assert P.clean_settings({"mix_split": "a" * 32 + "/000000000-000006000~20261111120000"})["mix_split"].endswith("~20261111120000")


def test_parts_are_measured_for_normalise(web, film):
    c, state = web
    status, r = c.json("POST", "/api/split/levels", {"split": film["split"], "layer": "music", "ranges": [[0.5, 2.0], [3.0, 5.5]]})
    assert status == 200 and len(r["levels"]) == 2
    # a sine at 0.3 x 1/8 (FFmpeg's sine is at 1/8) has an RMS of 0.0375 / sqrt(2): about -31.5 dB
    assert all(abs(x["rms"] + 31.5) < 1.0 and abs(x["peak"] - 0.0375) < 0.004 for x in r["levels"])
    status, err = c.json("POST", "/api/split/levels", {"split": "nope", "layer": "music", "ranges": [[0, 1]]})
    assert status == 400


def test_separate_chosen_parts_again(web, film, monkeypatch):
    """Music parts with voices left in them: the parts are split once more; the clean part stays on Music, and what was
    pulled out (with the test model 50 % voices + 20 % effects) goes to a new track, 'found'. Voices, Effects, other parts and
    the first split are not touched."""
    c, state = web
    state.splitter.engine_factory = lambda path: scalar_engine
    state.splitter.model_ready = lambda: True
    proj = c.json("GET", f"/api/projects/{film['proj']['id']}")[1]["project"]
    proj["settings"]["mix_split"] = film["split"]
    c.json("PUT", f"/api/projects/{proj['id']}", proj)
    status, r = c.json("POST", f"/api/projects/{proj['id']}/resplit", {"layer": "music", "ranges": [[2.0, 4.0]]})
    assert status == 200 and r["state"] == "running"
    end = time.time() + 60
    while time.time() < end:
        r = c.json("GET", f"/api/projects/{proj['id']}/resplit")[1]
        if r["state"] != "running":
            break
        time.sleep(0.2)
    assert r["state"] == "done", r
    new = c.json("GET", f"/api/projects/{proj['id']}")[1]["project"]["settings"]["mix_split"]
    assert new == r["id"] and new != film["split"] and "~" in new
    got = state.splitter.store.resolve(new)
    files = got["files"]
    assert set(files) == {"voices", "music", "effects", "found_voices", "found_effects"} and got["found_from"] == ["music"]
    music, voices = decode(files["music"]), decode(files["voices"])
    fv, fe = decode(files["found_voices"]), decode(files["found_effects"])
    old_voices = decode(state.splitter.store.resolve(film["split"])["files"]["voices"])
    out_part, in_part = slice(int(44100 * 0.5), int(44100 * 1.5)), slice(int(44100 * 2.6), int(44100 * 3.4))
    A = level(music[out_part], 1000)                                     # the music tone as it was
    assert A > 0.02                                                      # outside: as it was
    # two passes (test model 50/30/20): inside, Music keeps only 0.3 x 0.3 = 9 %; what was found is sorted by kind
    assert abs(level(music[in_part], 1000) / A - 0.09) < 0.03
    assert abs(level(fv[in_part], 1000) / A - 0.65) < 0.06              # voices found: 0.5 + 0.3 x 0.5
    assert abs(level(fe[in_part], 1000) / A - 0.26) < 0.05              # effects found: 0.2 + 0.3 x 0.2
    assert level(fv[out_part], 1000) / A < 0.05 and level(fe[out_part], 1000) / A < 0.05   # ... and only there
    assert abs(level(voices[in_part], 300) - level(old_voices[in_part], 300)) < 0.01   # Voices is not touched
    info = state.splitter.info(str(film["clip"]), 0.0, 6.0, new)["split"]
    assert "found_voices" in info["layers"] and info["found_from"] == ["music"]
    assert c.json("GET", f"/api/peaks?split={new}&layer=found_voices")[0] in (200, 202)
    assert state.splitter.store.resolve(film["split"])                    # the first split is still there
    # only this project uses the cleaned copy: a new lookup of the video still gives the first split
    info = state.splitter.info(str(film["clip"]), 0.0, 6.0)
    assert info["split"]["id"] == film["split"]
    assert state.splitter.info(str(film["clip"]), 0.0, 6.0, new)["split"]["id"] == new
    # and it exports, the found tracks too (they were left out of the export before)
    job = export(c, film, {"mix_split": new, "mix_music": 1.0, "mix_voices": 0.0, "mix_effects": 0.0, "mix_found_effects": 0.0, "mix_found_voices": 0.0})
    assert job["status"] == "done", job
    y = decode(job["output_path"])
    assert level(y[int(44100 * 2.6): int(44100 * 3.4)], 1000) < 0.3 * level(y[int(44100 * 0.5): int(44100 * 1.5)], 1000)
    only = export(c, film, {"mix_split": new, "mix_music": 0.0, "mix_voices": 0.0, "mix_effects": 0.0, "mix_found_effects": 0.0, "mix_found_voices": 1.0})
    y = decode(only["output_path"])
    assert level(y[int(44100 * 2.6): int(44100 * 3.4)], 1000) > 10 * level(y[int(44100 * 0.5): int(44100 * 1.5)], 1000)   # only the found voices: inside


# ---------------------------------------------------------------- 1.21: music parts, going down under voices, found track, step ticks
def test_music_parts_and_ducking_are_cleaned_and_turned_into_filters():
    st = P.clean_settings({"layers": [{"file": "u/x/a.mp3", "volume": 1, "parts": [{"end": 2, "volume": 3}, {"end": 1}, {"end": 4, "mute": 1}, {"end": None, "volume": 0.5}],
                                       "duck": {"on": 1, "level": 9}, "locked": 1}, {"file": "u/x/b.mp3", "parts": [{"end": None}], "duck": {"on": 0}}]})
    a, b = st["layers"]
    assert a["parts"] == [{"end": 2.0, "volume": 2.0, "mute": False}, {"end": 4.0, "volume": 1.0, "mute": True}, {"end": None, "volume": 0.5, "mute": False}]
    assert a["duck"] == {"on": True, "level": 1.0} and a["locked"] is True
    assert "parts" not in b and "duck" not in b and "locked" not in b                       # nothing changed: nothing kept
    assert P.music_parts_spans(a["parts"], 5.0) == [(0.0, 2.0, 2.0), (2.0, 4.0, 0.0), (4.0, 5.0, 0.5)]
    assert P.duck_spans([(1.0, 1.5), (1.9, 2.5), (8.0, 9.0)], 10.0) == [(0.65, 3.3), (7.65, 9.8)]
    f = P.music_envelope(a["parts"], {"on": True, "level": 0.3}, [(1.0, 2.0)], 5.0)
    assert f.count("volume=") == 4 and "between(t,0.650,2.800)" in f and "1-0.7000*" in f

    class Seg:                                        # a 2 s piece of the source from 10 s, played at double speed, starting at 1 s
        kind, mute, reverse, speed, src_start_f, src_len_f, out_start = "clip", False, False, 2.0, 250, 50, 25
    assert P.map_ranges([[10.5, 11.0], [20, 30]], [Seg()], 25.0) == [(1.25, 1.5)]


def test_voices_are_found_on_the_voices_track(tmp_path):
    f = tmp_path / "v.flac"
    run(["-f", "lavfi", "-i", "sine=frequency=300:duration=6", "-af", "volume='if(between(t,1,2)+between(t,4,5),0.3,0)':eval=frame", "-c:a", "flac", str(f)])
    got = P.find_voice(str(f), 10.0)
    assert len(got) == 2 and abs(got[0][0] - 11.0) < 0.1 and abs(got[0][1] - 12.0) < 0.1 and abs(got[1][0] - 14.0) < 0.1


def test_music_goes_down_under_voices_and_muted_parts_are_silent_in_the_export(web, film, tmp_path):
    c, state = web
    # a split of the film whose Voices track only talks from 2 s to 2.6 s
    folder = film["folder"].parent / (film["folder"].name + "~20260101000000")
    folder.mkdir(exist_ok=True)
    for name in ("music", "effects"):
        shutil.copyfile(film["folder"] / (name + ".flac"), folder / (name + ".flac"))
    run(["-f", "lavfi", "-i", "sine=frequency=300:duration=6", "-af", "volume='if(between(t,2,2.6),0.3,0)':eval=frame,pan=stereo|c0=c0|c1=c0",
         "-c:a", "flac", str(folder / "voices.flac")])
    (folder / "split.json").write_text(json.dumps({"model": S.MODEL_ID, "start": 0.0, "end": 6.0, "derived": True}))
    sid = film["split"].split("/")[0] + "/" + folder.name
    song = tmp_path / "song.wav"
    run(["-f", "lavfi", "-i", "sine=frequency=500:duration=6", "-af", "volume=0.3", str(song)])
    mid = c.upload(song)
    st, body = c.json("GET", f"/api/projects/{film['proj']['id']}/voices")
    job = export(c, film, {"mix_split": sid,
                           "layers": [{"file": mid, "volume": 1.0, "parts": [{"end": 0.6}, {"end": 1.2, "mute": True}, {"end": None}],
                                       "duck": {"on": True, "level": 0.3}}]})
    assert job["status"] == "done", job
    st, body = c.json("GET", f"/api/projects/{film['proj']['id']}/voices")
    assert st == 200 and body["from"] == "voices" and len(body["ranges"]) == 1 and abs(body["ranges"][0][0] - 2.0) < 0.1
    y = decode(job["output_path"])
    lv = lambda a, b: level(y[int(44100 * a): int(44100 * b)], 500)
    A = lv(1.3, 1.6)                                      # after the fade-in and the muted part
    assert A > 0.01
    assert lv(0.75, 1.05) < 0.08 * A                     # the muted part
    assert 0.18 < lv(2.1, 2.5) / A < 0.45                 # while someone talks: about 30 %
    assert lv(3.6, 4.3) / A > 0.8                         # and back up after
    # the levels of a music file can be measured too (for Normalise)
    st, r = c.json("POST", "/api/split/levels", {"file": mid, "ranges": [[0, 1], [7, 8]]})
    assert st == 200 and len(r["levels"]) == 2 and r["levels"][0]["rms"] > -40 and abs(r["levels"][0]["rms"] - r["levels"][1]["rms"]) < 1.5


def test_edit_steps_already_done_are_remembered(web, film):
    c, state = web
    pid = film["proj"]["id"]
    assert P.step_flags({"rule": {"interval": 1, "group": 4, "action": "remove", "picks": [4]}})["thin"]
    assert P.step_flags({"steps": [{"rule": {"interval": 1, "group": 4, "action": "remove", "picks": [4]}}], "rule": {"scenes": True}}) == {"versions": False, "thin": True, "scenes": True}
    assert P.clean_rule({"interval": 0, "hand": True, "scenes": True, "thin": True})["thin"] is True
    st, r = c.json("POST", f"/api/projects/{pid}/sections", {"action": "versions"})
    assert st == 200, r
    rows = {p["id"]: p for p in c.json("GET", "/api/projects")[1]["projects"]}
    assert rows[pid]["done"]["made_versions"] is True and rows[pid]["done"]["versions"] is False
    odd = rows[r["versions"][0]["id"]]
    assert odd["done"]["versions"] is True and odd["done"]["made_versions"] is False


# ---------------------------------------------------------------- 1.22: even out, fades, sound check
def test_even_out_takes_loud_moments_down_and_quiet_ones_up_and_leaves_the_rest():
    import numpy as np
    from editforge.analysis import evenout as E
    sr = 8000
    t = np.arange(0, 40, 1 / sr)
    amp = np.where((t > 10) & (t < 15), 0.8, np.where((t > 22) & (t < 28), 0.05, np.where(t > 34, 0.0, 0.2)))
    x = amp * np.sin(2 * np.pi * 440 * t)
    for s, lo in ((1, -9.0), (2, -14.0)):
        g = E.gains(x, sr, s)
        at = lambda sec: g[int(sec / E.HOP)]
        assert lo <= at(12.5) < -3.0                    # loud: down
        assert at(25) > 1.0                             # quiet: up
        assert at(5) == 0.0 and at(31) == 0.0          # fine: untouched
        assert at(37) == 0.0                            # silence is never pulled up
    g1, g2 = E.gains(x, sr, 1), E.gains(x, sr, 2)
    assert g2[int(12.5 / E.HOP)] < g1[int(12.5 / E.HOP)]          # strong does more
    pts = E.simplify(g1)
    assert 3 < len(pts) < 80 and all(abs(E.at(pts, k * E.HOP) - g1[k]) < 0.45 for k in range(0, len(g1), 7))
    f = E.filters(pts, 9.0, 16.0, offset=9.0)
    assert f and all(x.startswith("volume='pow(10,(") for x in f)


def test_even_out_and_fades_are_kept_only_when_set():
    p = P.clean_piece({"start": 0, "end": 5, "even": 2, "fin": 1.25, "fout": 99, "mix": {"music": {"even": 1}, "voices": {"fin": 0.01}}}, 10)
    assert p["even"] == 2 and p["fin"] == 1.25 and p["fout"] == 10.0
    assert p["mix"] == {"music": {"volume": 1.0, "mute": False, "even": 1}}
    q = P.clean_piece({"start": 0, "end": 5, "even": 7}, 10)
    assert "even" not in q and "fin" not in q
    st = P.clean_settings({"layers": [{"file": "u/x/a.mp3", "auto": 1, "fade_in": 3, "fade_out": 0, "parts": [{"end": 2, "even": 0}, {"end": None, "even": 2, "fin": 0.5}]}]})
    x = st["layers"][0]
    assert x["auto"] == 1 and x["fade_in"] == 3.0 and x["fade_out"] == 0.0
    assert x["parts"][0]["even"] == 0 and x["parts"][1]["even"] == 2 and x["parts"][1]["fin"] == 0.5


@pytest.fixture(scope="module")
def bumpy(web, tmp_path_factory):
    """A 12 s clip whose sound is a steady tone, much louder from 5 s to 8 s."""
    c, state = web
    d = tmp_path_factory.mktemp("bumpy")
    clip = d / "bumpy.mp4"
    run(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=12", "-f", "lavfi", "-i", "sine=frequency=440:duration=12",
         "-filter_complex", "[1:a]volume='if(between(t,5,8),1.0,0.2)':eval=frame,pan=stereo|c0=c0|c1=c0[a]", "-map", "0:v", "-map", "[a]",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "256k", "-shortest", str(clip)])
    state.chooser = lambda kind, start: str(clip)
    fid = c.json("POST", "/api/choose", {"kind": "video"})[1]["id"]
    proj = c.json("POST", "/api/projects", {"source": fid, "interval": 0})[1]["project"]
    return {"clip": clip, "fid": fid, "proj": proj}


def test_even_out_and_fades_change_the_export_of_a_section(web, bumpy):
    c, state = web
    piece = dict(bumpy["proj"]["pieces"][0])
    base = export(c, bumpy, {}, [piece])
    even = export(c, bumpy, {}, [dict(piece, even=2, fin=2.0)])
    assert base["status"] == "done" and even["status"] == "done", (base, even)
    y0, y1 = decode(base["output_path"]), decode(even["output_path"])
    lv = lambda y, a, b: level(y[int(44100 * a): int(44100 * b)], 440)
    jump0 = lv(y0, 6, 7) / lv(y0, 2.5, 3.5)                # the loud part, next to the normal part
    jump1 = lv(y1, 6, 7) / lv(y1, 2.5, 3.5)
    assert jump0 > 3.5 and jump1 < 0.6 * jump0            # evened out: much closer together
    assert lv(y1, 0.1, 0.5) < 0.45 * lv(y1, 2.5, 3.5)     # fades in over the first 2 s
    # the live viewer gets the same curve
    st, r = c.json("GET", "/api/envelope?file=" + urllib.parse.quote(bumpy["fid"]) + "&s=2")
    assert st == 200 and min(g for _, g in r["points"]) < -5


def test_auto_level_evens_out_an_imported_song_and_the_sound_check_finds_loud_spots(web, bumpy, tmp_path):
    c, state = web
    song = tmp_path / "bumpy_song.wav"
    run(["-f", "lavfi", "-i", "sine=frequency=500:duration=12", "-af", "volume='if(between(t,5,8),0.9,0.1)':eval=frame", str(song)])
    mid = c.upload(song)
    piece = dict(bumpy["proj"]["pieces"][0])
    off = export(c, bumpy, {"original_sound": False, "layers": [{"file": mid, "volume": 1.0}]}, [piece])
    on = export(c, bumpy, {"original_sound": False, "layers": [{"file": mid, "volume": 1.0, "auto": 2}]}, [piece])
    lv = lambda y, a, b: level(y[int(44100 * a): int(44100 * b)], 500)
    y0, y1 = decode(off["output_path"]), decode(on["output_path"])
    assert lv(y1, 6, 7) / lv(y1, 2.5, 3.5) < 0.6 * (lv(y0, 6, 7) / lv(y0, 2.5, 3.5))
    st, cur = c.json("GET", f"/api/jobs/{off['id']}/curve")
    assert st == 200 and len(cur["points"]) > 15 and all(-70 <= v <= 0 for _, v in cur["points"])
    assert any(p["kind"] == "loud" for p in cur["problems"]) or any(p["kind"] == "quiet" for p in cur["problems"])


# ---------------------------------------------------------------- 1.23: go down on every track, song start, captions height, no leftovers
def test_going_down_settings_song_start_and_caption_height_are_cleaned():
    st = P.clean_settings({"ducks": {"music": {"on": 1, "level": 0.4}, "voices": {"on": 1}, "effects": {"on": 0}, "x": {"on": 1}},
                           "layers": [{"file": "u/x/a.mp3", "start": 75.5, "duck": {"on": 1, "under": "effects"}}, {"file": "u/x/b.mp3", "duck": {"on": 1, "under": "nope"}}],
                           "caption_height": 140})
    assert st["ducks"] == {"music": {"on": True, "level": 0.4, "under": "voices"}, "voices": {"on": True, "level": 0.35, "under": "music"}}
    assert st["layers"][0]["start"] == 75.5 and st["layers"][0]["duck"]["under"] == "effects"
    assert "under" not in st["layers"][1]["duck"] and "start" not in st["layers"][1]
    assert st["caption_height"] == 90.0 and "caption_height" not in P.clean_settings({})
    pts = P.duck_points([[2.0, 2.6]], 0.3)
    assert pts[0] == [1.65, 0.0] and abs(pts[-1][0] - 3.4) < 1e-6 and abs(pts[1][1] + 10.46) < 0.1
    from editforge.core.model import CaptionSpec
    from editforge.planner.captions import ass_header
    assert ",2,40,40,432,1" in ass_header(CaptionSpec(height_pct=40.0), 1920, 1080)       # 40 % of 1080 above the bottom
    assert ",2,40,40,70,1" in ass_header(CaptionSpec(margin=70.0), 1920, 1080)


def test_a_split_track_goes_down_under_another_and_a_song_can_start_in_its_middle(web, film, tmp_path):
    c, state = web
    folder = film["folder"].parent / (film["folder"].name + "~20260202000000")
    folder.mkdir(exist_ok=True)
    for name in ("music", "effects"):
        shutil.copyfile(film["folder"] / (name + ".flac"), folder / (name + ".flac"))
    run(["-f", "lavfi", "-i", "sine=frequency=300:duration=6", "-af", "volume='if(between(t,2,2.6),0.3,0)':eval=frame,pan=stereo|c0=c0|c1=c0",
         "-c:a", "flac", str(folder / "voices.flac")])
    (folder / "split.json").write_text(json.dumps({"model": S.MODEL_ID, "start": 0.0, "end": 6.0, "derived": True}))
    sid = film["split"].split("/")[0] + "/" + folder.name
    # the Music track goes down to 30 % while the Voices track is heard
    job = export(c, film, {"mix_split": sid, "ducks": {"music": {"on": True, "level": 0.3, "under": "voices"}}})
    assert job["status"] == "done", job
    y = decode(job["output_path"])
    lv = lambda a, b, f=1000: level(y[int(44100 * a): int(44100 * b)], f)
    A = lv(0.6, 1.4)
    assert A > 0.01 and 0.2 < lv(2.15, 2.5) / A < 0.42 and lv(4.0, 5.0) / A > 0.85
    st, body = c.json("GET", f"/api/projects/{film['proj']['id']}/voices?of=music")
    assert st == 200 and body["of"] == "music" and body["ranges"]
    # a song that is silent for its first 3 s: started at 3 s into the file, it is heard from the very start
    song = tmp_path / "late.wav"
    run(["-f", "lavfi", "-i", "sine=frequency=500:duration=8", "-af", "volume='if(gte(t,3),0.3,0)':eval=frame", str(song)])
    mid = c.upload(song)
    base = export(c, film, {"original_sound": False, "layers": [{"file": mid, "volume": 1.0, "fade_in": 0, "fade_out": 0}]})
    y0 = decode(base["output_path"])
    late = export(c, film, {"original_sound": False, "layers": [{"file": mid, "volume": 1.0, "fade_in": 0, "fade_out": 0, "start": 3.0}]})
    y1 = decode(late["output_path"])
    q = lambda y, a, b: level(y[int(44100 * a): int(44100 * b)], 500)
    assert q(y0, 0.5, 2.0) < 0.1 * q(y0, 3.5, 5.0)
    assert q(y1, 0.5, 2.0) > 0.7 * q(y1, 3.5, 4.5)
    shutil.rmtree(folder, ignore_errors=True)


def test_quick_previews_leave_no_leftover_files(web, film):
    c, state = web
    pid = film["proj"]["id"]
    a = export(c, film, {})
    st, b = c.json("POST", f"/api/projects/{pid}/render", {"preview": True, "replace": True})
    b = c.wait_jobs([b["id"]], 180)[0]
    assert b["status"] == "done" and Path(b["output_path"]).is_file()
    assert not Path(a["output_path"]).exists() and state.store.get(a["id"]) is None        # the older quick version is gone
    full = c.json("POST", f"/api/projects/{pid}/render", {"preview": False})[1]
    full = c.wait_jobs([full["id"]], 240)[0]
    assert state.drop_previews(pid) == 1 and Path(full["output_path"]).is_file()          # finished videos are never touched


# ---------------------------------------------------------------- 1.25: export size (4K by default), clips keep the movie's size
def test_the_export_is_4k_by_default_and_the_size_can_be_chosen(web, film):
    c, state = web
    from editforge.core.media import probe_media
    j = export(c, film, {}, preview=False)
    assert j["status"] == "done", j
    m = probe_media(j["output_path"])
    assert max(m.width, m.height) == 3840 and abs(m.width / m.height - 320 / 180) < 0.02
    j = export(c, film, {"export_size": "1080", "frame": {"ratio": "9:16"}}, preview=False)
    m = probe_media(j["output_path"])
    assert (m.width, m.height) == (1080, 1920)
    j = export(c, film, {"export_size": "source"}, preview=False)
    m = probe_media(j["output_path"])
    assert (m.width, m.height) == (320, 180)
    assert P.clean_settings({})["export_size"] == "4k" and P.clean_settings({"export_size": "8k"})["export_size"] == "4k"


def test_separate_again_works_on_effects_parts(web, film):
    """Effects parts with some voice in them: separated twice more; the voices found go to 'Voices found again'."""
    c, state = web
    state.splitter.engine_factory = lambda path: scalar_engine
    state.splitter.model_ready = lambda: True
    proj = c.json("GET", f"/api/projects/{film['proj']['id']}")[1]["project"]
    proj["settings"]["mix_split"] = film["split"]
    c.json("PUT", f"/api/projects/{proj['id']}", proj)
    status, r = c.json("POST", f"/api/projects/{proj['id']}/resplit", {"layer": "effects", "ranges": [[1.0, 3.0]]})
    assert status == 200, r
    end = time.time() + 60
    while time.time() < end and r.get("state") == "running":
        time.sleep(0.2)
        r = c.json("GET", f"/api/projects/{proj['id']}/resplit")[1]
    assert r["state"] == "done", r
    got = state.splitter.store.resolve(r["id"])
    assert got["found_from"] == ["effects"] and {"found_voices", "found_music"} <= set(got["files"]) and "found_effects" not in got["files"]
    fx, fv = decode(got["files"]["effects"]), decode(got["files"]["found_voices"])
    out_part, in_part = slice(int(44100 * 4.0), int(44100 * 5.0)), slice(int(44100 * 1.6), int(44100 * 2.4))
    A = level(fx[out_part], 3000)
    assert A > 0.02 and level(fv[in_part], 3000) / A > 0.5 and level(fv[out_part], 3000) / A < 0.05
    job = export(c, film, {"mix_split": r["id"], "mix_voices": 0.0, "mix_music": 0.0, "mix_effects": 0.0, "mix_found_music": 0.0})
    assert job["status"] == "done", job
    y = decode(job["output_path"])
    assert level(y[int(44100 * 1.6): int(44100 * 2.4)], 3000) > 10 * level(y[int(44100 * 4.0): int(44100 * 5.0)], 3000)


# ---------------------------------------------------------------- 1.26: Clean up suggestions, grouped exports
def test_clean_up_suggests_older_exports_previews_and_a_finished_video(web, film):
    c, state = web
    pid = film["proj"]["id"]
    a = export(c, film, {}, preview=False)
    b = export(c, film, {}, preview=False)
    pv = export(c, film, {}, preview=True)
    items = {x["key"]: x for x in c.json("GET", "/api/cleanup")[1]["items"]}
    assert "old:" + a["id"] in items and "old:" + b["id"] not in items          # the older export, never the newest
    assert "pre:" + pv["id"] in items and items["pre:" + pv["id"]]["size"] > 0
    jobs = {j["id"]: j for j in c.json("GET", "/api/jobs")[1]["jobs"]}
    assert jobs[b["id"]]["group"] == "final" and jobs[pv["id"]]["group"] == "preview"
    # a video whose Odd and Even are both exported
    st, r = c.json("POST", f"/api/projects/{pid}/sections", {"action": "versions"})
    assert st == 200, r
    for v in r["versions"]:
        f = c.json("POST", f"/api/projects/{v['id']}/to-final", {})[1]["project"]["id"]
        st, j = c.json("POST", f"/api/projects/{f}/render", {"preview": False})
        assert c.wait_jobs([j["id"]], 180)[0]["status"] == "done"
    items = [x for x in c.json("GET", "/api/cleanup")[1]["items"] if x["kind"] == "video"]
    assert len(items) == 1 and len(items[0]["act"]["projects"]) >= 5 and items[0]["stage"] == "final"
