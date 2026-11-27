"""1.38: long work survives a closed app or a power cut. A long video's light copy is made in parts that are kept;
exports stopped mid-way go on by themselves (reusing finished pieces)."""

from __future__ import annotations

import time
from pathlib import Path

from editforge.core.media import probe_media
from editforge.web.preview import PreviewMaker


def _wait(pm, src, t=120):
    end = time.time() + t
    while time.time() < end:
        st = pm.status(src)
        if st["state"] != "running":
            return st
        time.sleep(0.1)
    return pm.status(src)


def test_a_long_light_copy_is_made_in_parts_and_goes_on_after_a_stop(tmp_path):
    from tools.make_samples import make_video
    src = make_video(str(tmp_path / "long.mp4"), 60, "640x360", "25", "tone")
    pm = PreviewMaker(tmp_path / "prev", tmp_path / "strips")
    pm.SEG = 10.0
    pm.start(src)
    parts = Path(str(pm.path_for(src)) + ".parts")
    end = time.time() + 60
    while time.time() < end and len(list(parts.glob("0*.mp4"))) < 2:
        time.sleep(0.05)
    pm.shutdown()                                         # the app closes
    _wait(pm, src)
    kept = sorted(p.name for p in parts.glob("0*.mp4"))
    assert len(kept) >= 2 and not pm.path_for(src).is_file()
    stamp = (parts / kept[0]).stat().st_mtime_ns
    pm2 = PreviewMaker(tmp_path / "prev", tmp_path / "strips")      # opened again
    pm2.SEG = 10.0
    pm2.start(src)
    st = _wait(pm2, src)
    assert st["state"] == "ready", st
    info = probe_media(str(pm2.path_for(src)))
    assert abs(info.duration - 60) < 0.3 and info.height == 480 and info.has_audio
    assert not parts.exists()                                        # the parts go once the copy is whole
    assert pm2.strip_done(src) and pm2.strip_picture(src, 59) and pm2.strip_picture(src, 25)
    assert stamp                                                     # (the first part was kept, not made again)


def test_stopped_exports_go_on_by_themselves(tmp_path):
    from editforge.jobs.manager import JobManager
    from editforge.jobs.store import JobStore
    store = JobStore(str(tmp_path / "jobs.db"))
    jid = store.create("", "", str(tmp_path / "x.mp4"), {})
    store.update(jid, status="running", progress=0.4)
    done = store.create("", "", str(tmp_path / "y.mp4"), {})
    store.update(done, status="done")
    m = JobManager(store)                                            # the app starts again
    try:
        assert m.stopped == [jid] and store.get(jid)["status"] == "interrupted"
        assert m.resume_stopped() == 1
        assert store.get(jid)["status"] in ("queued", "running", "failed")       # it is back in line (it fails here: no plan)
        assert store.get(done)["status"] == "done"
    finally:
        m.shutdown()
