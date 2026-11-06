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
    return project_mod.clean_project({"name": clip["name"], "source": clipset["source"], "pieces": pieces,
                                      "settings": dict(clip["settings"])}, duration)


# ------------------------------------------------------------------------------------------------ scenes
SCENE_VERSION = 2          # raise it when the scene finder gets better: older saved results are then found again


class SceneFinder:
    """Finds the scene changes of a video once (in the background) and keeps them in <home>/scenes/<fingerprint>.json.

    Next to the list of changes it keeps a small picture fingerprint of every sampled frame (<fingerprint>.npz), so a
    project can later compare the pictures on both sides of any join without reading the video again.

    Several videos can be asked for at once: they wait in a queue and SLOTS of them are looked at at the same time
    (looking at a movie uses the whole computer). on_done(src) is called when one is finished (or failed)."""

    THRESHOLD = 0.3        # only used when numpy is missing (FFmpeg's own score)
    MIN_SCENE = 0.6

    def __init__(self, folder: Path, fingerprint: Callable[[str], str], *, read_from: Optional[Callable[[str, float], Optional[str]]] = None,
                 on_done: Optional[Callable[[str], None]] = None, slots: Optional[int] = None):
        self.folder = Path(folder)
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
            if int(data.get("v") or 1) >= SCENE_VERSION:
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
                try:
                    feats, fine = shots.extract_all(src, duration, read_from=quick, cancel=cancel,
                                                    progress=lambda t: prog(0.97 * t / max(duration, 0.1)))
                except Cancelled:
                    raise
                except Exception:                         # noqa: BLE001 - the smaller copy could not be read: the video itself
                    if not quick:
                        raise
                    feats, fine = shots.extract_all(src, duration, cancel=cancel, progress=lambda t: prog(0.97 * t / max(duration, 0.1)))
                cuts = shots.refine_fine(shots.find_cuts(feats), fine)
                import numpy as np
                tmp = f.with_suffix(".tmp.npz")
                np.savez_compressed(str(tmp), fps=feats.fps, thumbs=feats.thumbs, hist=feats.hist)
                tmp.replace(f.with_suffix(".npz"))
                atomic_write_json(f, {"v": SCENE_VERSION, "scenes": [round(float(c.t), 4) for c in cuts], "kinds": [c.kind for c in cuts],
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
