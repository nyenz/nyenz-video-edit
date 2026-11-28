"""The real way a song gets into a video: Final project, sound split, song added with the Add music button (a linked
file, as in the desktop app), then Quick preview file and Export pressed in the Export window. The song must be heard
in both files, about as loud as the app plays it."""

from __future__ import annotations

import subprocess

import numpy as np
import pytest

from editforge import splitter as SP
from editforge.core import ffmpeg as ff
from editforge.core.fingerprint import file_fingerprint

TONES = {"voices": 300, "music": 1000, "effects": 3000}
SONG_HZ = 5000


def run(args):
    subprocess.run([ff.find_executable("ffmpeg"), "-v", "error", "-y"] + args, check=True)


def decode(path):
    raw = subprocess.run([ff.find_executable("ffmpeg"), "-v", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", "44100", "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32)


def level(x, hz, sr=44100):
    t = np.arange(len(x)) / sr
    return float(abs(np.mean(x * np.exp(-2j * np.pi * hz * t)))) * 2


@pytest.fixture(scope="module")
def setup(live, tmp_path_factory):
    d = tmp_path_factory.mktemp("songexp")
    clip = d / "Film clip.webm"
    ins = []
    for hz in TONES.values():
        ins += ["-f", "lavfi", "-i", f"sine=frequency={hz}:duration=12"]
    run(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=12"] + ins +
        ["-filter_complex", "[1:a][2:a][3:a]amix=inputs=3:normalize=0,volume=0.3,pan=stereo|c0=c0|c1=c0[a]", "-map", "0:v", "-map", "[a]",
         "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-pix_fmt", "yuv420p", "-c:a", "libopus", "-shortest", str(clip)])
    fp = file_fingerprint(str(clip))
    store = SP.SplitStore(live.state.home)
    folder = store.folder(fp, 0.0, 12.0)
    folder.mkdir(parents=True, exist_ok=True)
    for name, hz in TONES.items():
        run(["-f", "lavfi", "-i", f"sine=frequency={hz}:duration=12", "-af", "volume=0.3,pan=stereo|c0=c0|c1=c0", "-c:a", "flac", str(folder / (name + ".flac"))])
    store.write_meta(folder, 0.0, 12.0, 1.0, "fast")
    song = d / "mp3 (4).mp3"
    run(["-f", "lavfi", "-i", f"sine=frequency={SONG_HZ}:duration=200", "-ac", "2", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "192k", str(song)])
    return {"clip": str(clip), "song": str(song), "split": f"{fp}/{folder.name}"}


def test_the_song_is_in_the_quick_preview_and_the_export(live, page, setup):
    st = live.state
    st.chooser = lambda kind, start: setup["clip"]
    fid = live.call("POST", "/api/choose", {"kind": "video"})["id"]
    pid = live.call("POST", "/api/projects", {"source": fid, "name": "Song test", "stage": "final"})["project"]["id"]
    page.goto(f"{live.base}/final?p={pid}")
    page.wait_for_function("() => typeof S !== 'undefined' && S.proj && S.info && document.querySelector('#laneV .clipb')", timeout=30000)
    # the sound is split and mixed like the person's project: Music 2 %, Effects 44 %, 9:16
    page.evaluate("(sid) => { change(() => { Object.assign(S.proj.settings, { mix_split: sid, mix_music: 0.02, mix_effects: 0.44, shape: 'vertical' }); }, { keepVideo: true }); }", setup["split"])
    # Add music, the real button, the desktop file window answers with a linked file
    st.chooser = lambda kind, start: setup["song"]
    page.evaluate("() => openPanel('sound')")
    page.click("#musicAdd")
    page.wait_for_function("() => (S.proj.settings.layers || []).length === 1", timeout=15000)
    page.wait_for_timeout(1500)                                     # its level is set by itself
    page.evaluate("() => saveNow()")
    saved = live.call("GET", f"/api/projects/{pid}")["project"]["settings"]["layers"]
    print("LAYER", saved)
    assert len(saved) == 1 and saved[0]["file"].startswith("l/")
    outs = {}
    for which in ("Quick preview file", "Export"):
        page.evaluate("() => { exportDialog(); }")
        page.wait_for_selector(".dialog[aria-label=Export], .dialog:has-text('already')")
        if page.locator(".dialog:has-text('already')").count():
            page.locator(".dialog:has-text('already') button:has-text('Start another')").click()
        dlg = page.locator(".dialog[aria-label=Export]")
        assert "mp3 (4).mp3" in dlg.locator(".ex-sound").inner_text()          # the window says which song goes in
        dlg.locator(f".btns button:has-text('{which}')").click()
        page.wait_for_function("() => !document.querySelector('.dialog[aria-label=Export]')", timeout=60000)
        jobs = [j for j in live.call("GET", "/api/jobs")["jobs"] if j.get("project_id") == pid and j["preview"] == (which != "Export")]
        jid = jobs[0]["id"]
        for _ in range(600):
            j = [x for x in live.call("GET", "/api/jobs")["jobs"] if x["id"] == jid][0]
            if j["status"] in ("done", "failed", "cancelled"):
                break
            page.wait_for_timeout(500)
        assert j["status"] == "done", j
        assert j["songs"] == ["mp3 (4).mp3"], j.get("songs")
        y = decode(j["output_path"])
        outs[which] = (level(y, SONG_HZ), level(y, TONES["voices"]), level(y, TONES["effects"]))
    print("OUT", outs)
    for which, (song, voice, fx) in outs.items():
        assert song > 0.003, (which, outs)
        assert song > voice * 0.03, (which, outs)                 # not buried far under the film either
    assert page.errors == []
