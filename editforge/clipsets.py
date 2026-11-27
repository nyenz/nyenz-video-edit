"""Clip projects: one long video (a movie) and the many clips taken out of it.

Phase 1 of the work: open a movie, mark clips, and make (render) them. A clip can have several parts
(for example 1:02-1:20 and then 5:40-5:48), played one after the other as ONE clip. Each clip has its own
basic picture and sound settings. "Make" turns every clip into a small video file of its own; after that
the movie itself is no longer needed, and the app can free the space it takes.

Phase 2 (Edit) opens a made clip as an editor project, phase 3 (Final) lists finished videos.

A clip set is stored as JSON in <home>/clipsets/<id>.json. A clip remembers the export job that made it
(``made.job``) plus a fingerprint of everything that changes the picture or sound (``made.key``); when the
clip is changed afterwards, the old file is shown as "out of date".
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import project as project_mod
from .core.errors import EditForgeError

CLIPSET_ID = r"[0-9a-f]{12}"
CLIP_ID = re.compile(r"^[0-9a-f]{8}$")
JOB_ID = re.compile(r"^[0-9a-f]{12}$")
MAX_CLIPS = 300
MAX_PARTS = 60
MIN_PART = 0.04
SHAPES = ("original", "vertical", "vertical_blur", "square", "square_blur")
#: settings a clip may carry (the rest of the project settings stay at their defaults)
CLIP_SETTINGS = ("shape", "fade_in", "fade_out", "noise", "vocals", "voice_boost", "compress", "bass", "treble", "quality",
                 "mix_split", "mix_voices", "mix_music", "mix_effects")


def _num(value: Any, default: float, lo: float, hi: float) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    if v != v or v in (float("inf"), float("-inf")):
        return default
    return max(lo, min(hi, v))


def clean_parts(raw: Any, duration: float) -> List[Dict[str, float]]:
    parts: List[Dict[str, float]] = []
    for p in (raw if isinstance(raw, list) else [])[:MAX_PARTS]:
        if not isinstance(p, dict):
            continue
        try:
            a, b = float(p["start"]), float(p["end"])
        except (KeyError, TypeError, ValueError):
            continue
        if a != a or b != b:
            continue
        a, b = max(0.0, a), min(float(duration), b)
        if b - a >= MIN_PART:
            parts.append({"start": round(a, 3), "end": round(b, 3)})
    return parts


def clean_clip(raw: Any, duration: float, n: int) -> Optional[Dict[str, Any]]:
    """A safe copy of one clip, or None when it has no usable part."""
    if not isinstance(raw, dict):
        return None
    parts = clean_parts(raw.get("parts"), duration)
    if not parts:
        return None
    cid = str(raw.get("id") or "")
    if not CLIP_ID.match(cid):
        cid = secrets.token_hex(4)
    name = " ".join(str(raw.get("name") or "").split())[:60] or f"clip{n:02d}"
    color = raw.get("color") if isinstance(raw.get("color"), dict) else {}
    settings_raw = raw.get("settings") if isinstance(raw.get("settings"), dict) else {}
    full = project_mod.clean_settings({k: settings_raw[k] for k in CLIP_SETTINGS if k in settings_raw})
    settings = {k: full[k] for k in CLIP_SETTINGS}
    if settings["shape"] not in SHAPES:
        settings["shape"] = "original"
    made = raw.get("made") if isinstance(raw.get("made"), dict) else {}
    made = {"job": str(made.get("job")), "key": str(made.get("key") or "")[:40]} if JOB_ID.match(str(made.get("job") or "")) else None
    return {"id": cid, "name": name, "parts": parts,
            "color": {"brightness": round(_num(color.get("brightness"), 0.0, -1.0, 1.0), 3),
                      "contrast": round(_num(color.get("contrast"), 1.0, 0.0, 3.0), 3),
                      "saturation": round(_num(color.get("saturation"), 1.0, 0.0, 3.0), 3)},
            "speed": round(_num(raw.get("speed"), 1.0, 0.25, 4.0), 3),
            "volume": round(_num(raw.get("volume"), 1.0, 0.0, 4.0), 3),
            "mute": bool(raw.get("mute")), "settings": settings, "made": made}


def clean_clipset(raw: Any, duration: float) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        raise EditForgeError("That clip project could not be read.", "Reload the page and try again.")
    clips_raw = raw.get("clips") if isinstance(raw.get("clips"), list) else []
    if len(clips_raw) > MAX_CLIPS:
        raise EditForgeError(f"A clip project can have at most {MAX_CLIPS} clips.", "Start a second clip project for the rest.")
    clips: List[Dict[str, Any]] = []
    seen = set()
    for n, c in enumerate(clips_raw, 1):
        clip = clean_clip(c, duration, n)
        if clip is None:
            continue
        while clip["id"] in seen:
            clip["id"] = secrets.token_hex(4)
        seen.add(clip["id"])
        clips.append(clip)
    name = " ".join(str(raw.get("name") or "").split())[:80] or "My clips"
    return {"name": name, "source": str(raw.get("source") or "")[:300], "clips": clips}


def clip_key(source: str, clip: Dict[str, Any]) -> str:
    """Fingerprint of everything that changes the made file (not the name)."""
    spec = {"s": source, "p": clip["parts"], "c": clip["color"], "v": clip["speed"], "vol": clip["volume"], "m": clip["mute"],
            "st": clip["settings"]}
    return hashlib.sha1(json.dumps(spec, sort_keys=True).encode()).hexdigest()


def clip_length(clip: Dict[str, Any]) -> float:
    return sum(p["end"] - p["start"] for p in clip["parts"]) / (clip.get("speed") or 1.0)


def clip_project(clipset: Dict[str, Any], clip: Dict[str, Any], duration: float) -> Dict[str, Any]:
    """The editor project that makes one clip: its parts in order, each with the clip's look and sound."""
    pieces = [{"start": p["start"], "end": p["end"], "speed": clip["speed"], "volume": clip["volume"], "mute": clip["mute"],
               "color": clip["color"]} for p in clip["parts"]]
    st = dict(clip["settings"], export_size="source")                   # clips keep the movie's own size
    if st.get("quality", "best") == "best":
        st["quality"] = "master"           # a clip is edited and made again later: made almost lossless, nothing is lost twice
    return project_mod.clean_project({"name": clip["name"], "source": clipset["source"], "pieces": pieces, "settings": st}, duration)


# ------------------------------------------------------------------------------------------------ scenes
SCENE_VERSION = 2          # raise it when the scene finder gets better: older saved results are then found again
NET_VERSION = 3            # results made with the shot-change network (transnet.py); once the network is in place, older results are found again


def _net_model(home: Optional[Path]) -> Optional[Path]:
    """The shot-change network's file when it can be used, else None."""
    try:
        from .analysis import transnet
        return transnet.model_file(home) if transnet.available(home) else None
    except Exception:  # noqa: BLE001 - never stops the scene finder
        return None


class SceneFinder:
    """Finds the scene changes of a video once (in the background) and keeps them in <home>/scenes/<fingerprint>.json.

    Next to the list of changes it keeps a small picture fingerprint of every sampled frame (<fingerprint>.npz), so a
    project can later compare the pictures on both sides of any join without reading the video again.

    Several videos can be asked for at once: they wait in a queue and SLOTS of them are looked at at the same time
    (looking at a movie uses the whole computer). on_done(src) is called when one is finished (or failed)."""

    THRESHOLD = 0.3        # only used when numpy is missing (FFmpeg's own score)
    MIN_SCENE = 0.6

    def __init__(self, folder: Path, fingerprint: Callable[[str], str], *, read_from: Optional[Callable[[str, float], Optional[str]]] = None,
                 on_done: Optional[Callable[[str], None]] = None, slots: Optional[int] = None, home: Optional[Path] = None):
        self.folder = Path(folder)
        self.home = home                         # where the models folder is (None: the usual place)
        self.folder.mkdir(parents=True, exist_ok=True)
        self.fingerprint = fingerprint
        self.read_from = read_from               # a smaller copy of the same video, quicker to read (None: the video itself)
        self.on_done = on_done
        self._lock = threading.Lock()
        self._jobs: Dict[str, Dict[str, Any]] = {}
        cpus = os.cpu_count() or 2
        self._slots = threading.Semaphore(slots or (2 if cpus >= 8 else 1))

    def _file(self, src: str) -> Path:
        return self.folder / (self.fingerprint(src) + ".json")

    def status(self, src: str) -> Dict[str, Any]:
        f = self._file(src)
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            if int(data.get("v") or 1) >= self.version():
                return {"state": "ready", "progress": 1.0, "scenes": data["scenes"], "kinds": data.get("kinds") or [], "error": ""}
        except (OSError, ValueError, KeyError, TypeError):
            pass
        with self._lock:
            job = self._jobs.get(str(f))
            out = {k: v for k, v in job.items() if k != "cancel"} if job else {"state": "none", "progress": 0.0, "error": ""}
            if out.get("state") == "queued":
                waiting = sorted((j["since"], k) for k, j in self._jobs.items() if j.get("state") == "queued")
                out["place"] = 1 + [k for _, k in waiting].index(str(f))
        out["scenes"] = []
        return out

    def version(self) -> int:
        """Saved results older than this are found again."""
        return NET_VERSION if _net_model(self.home) else SCENE_VERSION

    def chances(self, src: str) -> Tuple[Any, float]:
        """The network's chance of a change at every frame, and that frame rate ((None, 0) when it was not used)."""
        try:
            import numpy as np
            z = np.load(str(self._file(src).with_suffix(".npz")))
            if "net" in z.files:
                return z["net"].astype(np.float32), float(z["net_rate"])
        except Exception:  # noqa: BLE001 - no file
            pass
        return None, 0.0

    def jobs(self) -> List[Dict[str, Any]]:
        """Every video being looked at or waiting (for the Activity list)."""
        with self._lock:
            return [{k: v for k, v in j.items() if k != "cancel"} for j in self._jobs.values() if j.get("state") in ("queued", "running")]

    def features(self, src: str) -> Any:
        """The saved picture fingerprints (None when there are none: numpy missing, or not found yet)."""
        try:
            import numpy as np
            from .analysis.shots import Features
            z = np.load(str(self._file(src).with_suffix(".npz")))
            return Features(float(z["fps"]), z["thumbs"], z["hist"])
        except Exception:  # noqa: BLE001 - no file, or not readable
            return None

    def start(self, src: str, duration: float, has_video: bool) -> Dict[str, Any]:
        if not has_video:
            raise EditForgeError("This file has no picture, so it has no scenes.", "Choose a video.")
        st = self.status(src)
        if st["state"] in ("ready", "running", "queued"):
            return st
        f = self._file(src)
        with self._lock:
            self._jobs[str(f)] = {"state": "queued", "progress": 0.0, "error": "", "since": time.time(), "src": src,
                                  "name": Path(src).name, "duration": duration, "cancel": threading.Event()}
        threading.Thread(target=self._run, args=(src, duration, f), name="editforge-scenes", daemon=True).start()
        return self.status(src)

    PART = 300.0               # seconds per part of a long video
    OVERLAP = 4.0              # each part also reads a little before it, so nothing at the joins is missed

    def _parts_dir(self, src: str) -> Path:
        return self.folder / "parts" / self._file(src).stem

    def _drop_parts(self, src: str) -> None:
        import shutil
        shutil.rmtree(self._parts_dir(src), ignore_errors=True)

    def _in_parts(self, src: str, duration: float, quick: Optional[str], model: Any, cancel: threading.Event,
                  prog: Callable[[float], None]) -> Tuple[Any, Any, Any]:
        """Look at a long video in parts of PART seconds; each finished part is saved, so a restart goes on from there.
        Every part gives exactly the frames of its own stretch, so the parts join without any drift."""
        import json
        import numpy as np
        from .analysis import shots
        d = self._parts_dir(src)
        d.mkdir(parents=True, exist_ok=True)
        rate = shots._native_rate(quick or src)
        fps = shots.FPS
        n = int(np.ceil(duration / self.PART))
        key = {"rate": round(rate, 4), "net": model is not None, "v": NET_VERSION, "part": self.PART, "duration": round(duration, 2)}
        meta = d / "meta.json"
        try:
            if json.loads(meta.read_text()) != key:
                self._drop_parts(src)
                d.mkdir(parents=True, exist_ok=True)
        except (OSError, ValueError):
            pass
        meta.write_text(json.dumps(key))
        T, H_, J, P = [], [], [], []

        def fit(arr: Any, want: int) -> Any:
            if len(arr) >= want:
                return arr[:want]
            pad = np.repeat(arr[-1:], want - len(arr), axis=0) if len(arr) else np.zeros((want,) + arr.shape[1:], dtype=arr.dtype)
            return np.concatenate([arr, pad])
        for k in range(n):
            a, b = k * self.PART, min(duration, (k + 1) * self.PART)
            pf = d / f"{k:04d}.npz"
            if pf.is_file():
                try:
                    z = np.load(str(pf))
                    T.append(z["thumbs"]); H_.append(z["hist"]); J.append(z["jump"])
                    if model is not None:
                        P.append(z["net"])
                    prog(0.97 * b / duration)
                    continue
                except Exception:  # noqa: BLE001 - a half-written part: look at it again
                    pf.unlink(missing_ok=True)
            a0, b1 = max(0.0, a - self.OVERLAP), min(duration, b + self.OVERLAP)     # a little before and after: the joins are seen
            stream = None
            if model is not None:
                from .analysis import transnet
                stream = transnet.Streamer(model)

            def part_prog(t: float, a=a, a0=a0, b=b) -> None:
                prog(0.97 * min(b, a0 + t) / duration)
            try:
                try:
                    feats, fine = shots.extract_all(src, b1 - a0, read_from=quick, cancel=cancel, start=a0,
                                                    on_big=stream.push if stream else None, progress=part_prog)
                except Exception:  # noqa: BLE001 - the smaller copy could not be read: the video itself
                    if not quick:
                        raise
                    if stream is not None:
                        stream.close()
                        stream = transnet.Streamer(model)
                    feats, fine = shots.extract_all(src, b1 - a0, cancel=cancel, start=a0, on_big=stream.push if stream else None, progress=part_prog)
                probs = stream.finish() if stream is not None else None
            except BaseException:
                if stream is not None:
                    stream.close()
                raise
            skip_t, skip_f = int(round((a - a0) * fps)), int(round((a - a0) * rate))
            want_t = int(round(b * fps)) - int(round(a * fps))
            want_f = int(round(b * rate)) - int(round(a * rate))
            th = fit(feats.thumbs[skip_t:], want_t)
            hi = fit(feats.hist[skip_t:], want_t)
            ju = fit(fine.jump[max(0, skip_f - 1):], want_f - (1 if k == 0 else 0))     # the jump into each frame of this part
            out = {"thumbs": th, "hist": hi, "jump": ju}
            if probs is not None:
                out["net"] = fit(probs[skip_f:], want_f)
            tmp = d / f"{k:04d}.tmp.npz"
            np.savez_compressed(str(tmp), **out)
            tmp.replace(pf)
            T.append(th); H_.append(hi); J.append(ju)
            if probs is not None:
                P.append(out["net"])
        feats = shots.Features(fps, np.concatenate(T), np.concatenate(H_))
        fine = shots.Fine(rate, np.concatenate(J))
        return feats, fine, (np.concatenate(P) if model is not None else None)

    def stop(self, src: str) -> bool:
        """Stop looking at this video (or take it out of the queue)."""
        f = self._file(src)
        with self._lock:
            job = self._jobs.get(str(f))
            if not job or job.get("state") not in ("queued", "running"):
                return False
            job["cancel"].set()
            job["state"] = "stopped"
            return True

    def _run(self, src: str, duration: float, f: Path) -> None:
        from .analysis import shots
        from .core.cache import atomic_write_json
        from .core.errors import Cancelled
        key = str(f)
        with self._lock:
            job = self._jobs[key]
            cancel = job["cancel"]

        def mine() -> bool:                       # a stopped job may have been started again meanwhile: that one is not ours
            return self._jobs.get(key) is job
        self._slots.acquire()
        try:
            if cancel.is_set():
                raise Cancelled()
            with self._lock:
                job.update(state="running", started=time.time())

            def prog(k: float) -> None:
                with self._lock:
                    job["progress"] = round(min(0.99, k), 3)
            if shots.available():
                quick = None
                if self.read_from:
                    try:
                        quick = self.read_from(src, duration)
                    except Exception:  # noqa: BLE001 - then the video itself
                        quick = None
                model = _net_model(self.home)
                net: List[Any] = []
                if duration > self.PART * 1.5:
                    # a long video is looked at in parts of 5 minutes, each kept as it is done: after a power cut or a
                    # restart it goes on from the last part instead of from the start
                    feats, fine, probs = self._in_parts(src, duration, quick, model, cancel, prog)
                    parted = True
                    if probs is not None:
                        net.append(None)
                else:
                    parted = False

                def read(where: Optional[str]) -> Tuple[Any, Any]:
                    net.clear()
                    stream = None
                    if model is not None:
                        from .analysis import transnet
                        stream = transnet.Streamer(model)
                        net.append(stream)
                    try:
                        return shots.extract_all(src, duration, read_from=where, cancel=cancel, on_big=stream.push if stream else None,
                                                 progress=lambda t: prog(0.97 * t / max(duration, 0.1)))
                    except BaseException:
                        if stream is not None:
                            stream.close()
                        raise
                if not parted:
                    try:
                        feats, fine = read(quick)
                    except Cancelled:
                        raise
                    except Exception:                         # noqa: BLE001 - the smaller copy could not be read: the video itself
                        if not quick:
                            raise
                        feats, fine = read(None)
                found = shots.find_cuts(feats)
                import numpy as np
                extra: Dict[str, Any] = {}
                if net:
                    from .analysis import transnet
                    probs = net[0].finish() if net[0] is not None else probs
                    found = transnet.combine(found, probs, fine.rate, feats=feats)
                    extra = {"net": probs.astype(np.float16), "net_rate": fine.rate}
                cuts = shots.refine_fine(found, fine)
                self._drop_parts(src)
                tmp = f.with_suffix(".tmp.npz")
                np.savez_compressed(str(tmp), fps=feats.fps, thumbs=feats.thumbs, hist=feats.hist, **extra)
                tmp.replace(f.with_suffix(".npz"))
                atomic_write_json(f, {"v": NET_VERSION if net else SCENE_VERSION, "scenes": [round(float(c.t), 4) for c in cuts], "kinds": [c.kind for c in cuts],
                                      "duration": duration, "when": time.time()})
            else:
                from .analysis.scenes import detect_scene_scores, scenes_from_scores
                scores = detect_scene_scores(src, 0.08, progress=lambda t: prog(t / max(duration, 0.1)))
                scenes = scenes_from_scores(scores, self.THRESHOLD, self.MIN_SCENE, duration)
                atomic_write_json(f, {"v": SCENE_VERSION, "scenes": scenes, "kinds": [], "duration": duration, "when": time.time()})
            with self._lock:
                if mine():
                    self._jobs.pop(key, None)
        except Cancelled:
            with self._lock:
                if mine():
                    self._jobs.pop(key, None)
            return
        except Exception as exc:  # noqa: BLE001 - shown to the person
            with self._lock:
                if mine():
                    self._jobs[key] = {"state": "failed", "progress": 0.0, "error": getattr(exc, "message", None) or str(exc),
                                   "since": time.time(), "src": src, "name": Path(src).name, "cancel": threading.Event()}
        finally:
            self._slots.release()
        if self.on_done:
            try:
                self.on_done(src)
            except Exception:  # noqa: BLE001 - a project that cannot be updated must not stop the finder
                pass


def scene_ranges(bounds: List[float], duration: float) -> List[Tuple[float, float]]:
    edges = [0.0] + [b for b in bounds if 0 < b < duration] + [duration]
    return [(edges[i], edges[i + 1]) for i in range(len(edges) - 1)]
