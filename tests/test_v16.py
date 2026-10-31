"""Version 1.6: split a video's sound into voices / music / effects and mix the layers."""

from __future__ import annotations

import json
import subprocess
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
