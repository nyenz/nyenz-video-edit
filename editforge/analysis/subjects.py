"""Who (or what) a tall or square video follows: the most visible person or thing in each shot.

A detector (YOLOX-S, Apache-2.0, from OpenCV's model zoo; it knows people, animals, cars and 77 other kinds of things)
looks at a few frames a second. Its boxes are joined into tracks; in every shot the frame follows the one that stands out
most (big, sure, a person before a thing). When that one leaves the picture, the frame moves on to whoever stands out most
then. With nothing found, it stays in the middle. Then the path is made calm (Steady) or quick (Lively), and with
*space in front* it leaves room on the side the subject moves to.

Finds are saved per video, so a second export, or a change of shape, does not look again.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import subprocess
import threading
import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from ..core.errors import Cancelled, EditForgeError
from ..core.ffmpeg import get_tools

BASE = "https://github.com/nyenz/nyenz-video-edit/releases/download/subject-model-1/"
MODEL = {"name": "subjects-yolox.onnx", "size": 35858002, "sha256": "c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063"}
FACES = {"name": "faces-yunet.onnx", "size": 232589, "sha256": "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"}
SIZE = 640
FPS = 3.0                       # frames looked at per second
VERSION = 1
PERSON = 0
ANIMALS = set(range(14, 24))    # bird ... giraffe
VEHICLES = {1, 2, 3, 4, 5, 6, 7, 8}
WHO = ("auto", "people", "faces", "biggest")
FEELS = {"steady": (2.4, 0.05), "lively": (0.8, 0.02)}       # seconds of smoothing (centred, so it never lags), dead zone
_LOCK = threading.Lock()
_SESSION: Dict[str, Any] = {}

Box = List[float]               # [x0, y0, x1, y1 (fractions), kind, sureness]


def _models_dir(home: Optional[Path] = None) -> Path:
    from ..splitter import models_dir
    return models_dir(home)


def ready(home: Optional[Path] = None) -> bool:
    p = _models_dir(home) / MODEL["name"]
    return p.is_file() and p.stat().st_size == MODEL["size"]


def download(home: Optional[Path] = None, progress: Optional[Callable[[float], None]] = None) -> Path:
    """Download the detector once (36 MB) and check its fingerprint."""
    dest = _models_dir(home) / MODEL["name"]
    if ready(home):
        return dest
    if os.environ.get("EDITFORGE_NO_DOWNLOAD"):
        raise EditForgeError("The tracking model is not here and downloads are switched off.", "Put subjects-yolox.onnx in the models folder.")
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".part")
    h = hashlib.sha256()
    try:
        with urllib.request.urlopen(BASE + MODEL["name"], timeout=60) as r, open(tmp, "wb") as f:
            got = 0
            while True:
                buf = r.read(1 << 20)
                if not buf:
                    break
                f.write(buf)
                h.update(buf)
                got += len(buf)
                if progress:
                    progress(min(1.0, got / MODEL["size"]))
    except Exception as exc:  # noqa: BLE001
        tmp.unlink(missing_ok=True)
        raise EditForgeError("The tracking model could not be downloaded.", "Check the internet connection and try again. (" + str(exc)[:100] + ")")
    if h.hexdigest() != MODEL["sha256"]:
        tmp.unlink(missing_ok=True)
        raise EditForgeError("The tracking model that was downloaded is not the right file.", "Try again later.")
    os.replace(tmp, dest)
    return dest


def _session(home: Optional[Path] = None) -> Any:
    path = str(_models_dir(home) / MODEL["name"])
    with _LOCK:
        if path not in _SESSION:
            import onnxruntime as ort
            o = ort.SessionOptions()
            o.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            n = os.cpu_count() or 2
            o.intra_op_num_threads = n if n <= 4 else n - 1
            o.add_session_config_entry("session.intra_op.allow_spinning", "0")
            _SESSION[path] = ort.InferenceSession(path, o, providers=["CPUExecutionProvider"])
        return _SESSION[path]


def _grids(np: Any) -> Tuple[Any, Any]:
    grids, strides = [], []
    for s in (8, 16, 32):
        n = SIZE // s
        yv, xv = np.meshgrid(np.arange(n), np.arange(n), indexing="ij")
        grids.append(np.stack((xv, yv), 2).reshape(-1, 2))
        strides.append(np.full((n * n, 1), s))
    return np.concatenate(grids).astype(np.float32), np.concatenate(strides).astype(np.float32)


def detect_frame(sess: Any, rgb: Any, min_score: float = 0.35) -> List[Box]:
    """Boxes in one frame (H, W, 3 uint8 RGB), as fractions of the frame."""
    import numpy as np
    h, w = rgb.shape[:2]
    r = min(SIZE / h, SIZE / w)
    nh, nw = int(round(h * r)), int(round(w * r))
    ys = (np.arange(nh) / r).astype(int).clip(0, h - 1)
    xs = (np.arange(nw) / r).astype(int).clip(0, w - 1)
    img = np.full((SIZE, SIZE, 3), 114, dtype=np.uint8)
    img[:nh, :nw] = rgb[ys][:, xs][:, :, ::-1]                           # the model reads BGR, padded at the bottom right
    x = img.transpose(2, 0, 1)[None].astype(np.float32)
    out = sess.run(None, {sess.get_inputs()[0].name: x})[0][0]
    g, s = _grids(np)
    out[:, :2] = (out[:, :2] + g) * s
    out[:, 2:4] = np.exp(out[:, 2:4]) * s
    scores = out[:, 4:5] * out[:, 5:]
    kind = scores.argmax(1)
    best = scores[np.arange(len(kind)), kind]
    keep = best >= min_score
    if not keep.any():
        return []
    b, kind, best = out[keep, :4], kind[keep], best[keep]
    x0, y0 = (b[:, 0] - b[:, 2] / 2) / r, (b[:, 1] - b[:, 3] / 2) / r
    x1, y1 = (b[:, 0] + b[:, 2] / 2) / r, (b[:, 1] + b[:, 3] / 2) / r
    order = best.argsort()[::-1]
    picked: List[Box] = []
    for i in order:                                                       # one box per thing (overlaps of the same kind go)
        bx = [float(x0[i] / w), float(y0[i] / h), float(x1[i] / w), float(y1[i] / h), int(kind[i]), float(best[i])]
        if all(p[4] != bx[4] or _iou(p, bx) < 0.5 for p in picked):
            picked.append([round(v, 4) if isinstance(v, float) else v for v in bx])
        if len(picked) >= 12:
            break
    return picked


def _iou(a: Sequence[float], b: Sequence[float]) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / u if u > 0 else 0.0


class Finder:
    """Looks at a video's frames FPS times a second and remembers what it found (per video, on disk)."""

    def __init__(self, folder: Path, home: Optional[Path] = None):
        self.folder = Path(folder)
        self.home = home
        self.folder.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _file(self, fp: str) -> Path:
        return self.folder / f"{fp}.json"

    def _load(self, fp: str) -> Dict[str, List[Box]]:
        try:
            d = json.loads(self._file(fp).read_text(encoding="utf-8"))
            return d["dets"] if d.get("v") == VERSION and d.get("fps") == FPS else {}
        except (OSError, ValueError, KeyError):
            return {}

    def _save(self, fp: str, dets: Dict[str, List[Box]]) -> None:
        from ..core.cache import atomic_write_json
        atomic_write_json(self._file(fp), {"v": VERSION, "fps": FPS, "dets": dets})

    def find(self, src: str, fp: str, ranges: Sequence[Tuple[float, float]], width: int, height: int,
             progress: Optional[Callable[[float], None]] = None, cancel: Optional[threading.Event] = None) -> Dict[float, List[Box]]:
        """What is seen at every look time inside the ranges (source seconds). Only times not seen before are looked at."""
        import numpy as np
        with self._lock:
            dets = self._load(fp)
        want: List[Tuple[float, float]] = []
        for a, b in sorted(ranges):
            k0, k1 = int(math.floor(a * FPS)), int(math.ceil(b * FPS))
            missing = [k for k in range(k0, k1 + 1) if f"{k / FPS:.3f}" not in dets]
            if missing:
                want.append((missing[0] / FPS, missing[-1] / FPS))
        total = sum(b - a for a, b in want) or 1.0
        done = 0.0
        if want:
            if not ready(self.home):
                download(self.home)
            sess = _session(self.home)
            sw = 480
            sh = max(2, int(round(height * sw / max(width, 1) / 2)) * 2)
            for a, b in want:
                cmd = [get_tools().ffmpeg, "-nostdin", "-v", "error", "-ss", f"{max(0.0, a):.3f}", "-t", f"{b - a + 0.5 / FPS:.3f}",
                       "-i", src, "-map", "0:v:0", "-an", "-vf", f"fps={FPS},scale={sw}:{sh}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
                proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                n, size = 0, sw * sh * 3
                try:
                    while True:
                        if cancel is not None and cancel.is_set():
                            raise Cancelled()
                        raw = proc.stdout.read(size)
                        if len(raw) < size:
                            break
                        t = a + n / FPS
                        n += 1
                        key = f"{round(t * FPS) / FPS:.3f}"
                        if key not in dets:
                            dets[key] = detect_frame(sess, np.frombuffer(raw, dtype=np.uint8).reshape(sh, sw, 3))
                        if progress:
                            progress(min(1.0, (done + n / FPS) / total))
                        if n % 30 == 0:
                            with self._lock:
                                self._save(fp, dets)                  # kept as it goes: a restart goes on from here
                finally:
                    proc.kill()
                    proc.wait()
                done += b - a
            with self._lock:
                self._save(fp, dets)
        out: Dict[float, List[Box]] = {}
        for a, b in ranges:
            for k in range(int(math.floor(a * FPS)), int(math.ceil(b * FPS)) + 1):
                key = f"{k / FPS:.3f}"
                if key in dets and a - 0.5 <= k / FPS <= b + 0.5:
                    out[k / FPS] = dets[key]
        return out


# ------------------------------------------------------------------------------------------------- choosing who to follow
def _weight(kind: int, who: str) -> float:
    if who == "people" or who == "faces":
        return 1.0 if kind == PERSON else 0.0
    if who == "biggest":
        return 1.0
    return 1.0 if kind == PERSON else 0.75 if kind in ANIMALS else 0.55 if kind in VEHICLES else 0.4


def _score(b: Box, who: str) -> float:
    area = max(0.0, (b[2] - b[0]) * (b[3] - b[1]))
    centre = 1.0 - min(1.0, abs((b[0] + b[2]) / 2 - 0.5) * 1.2)
    sure = b[5] if who != "biggest" else 1.0
    return math.sqrt(area) * sure * _weight(int(b[4]), who) * (0.85 + 0.3 * centre)


def _point(b: Box, who: str) -> Tuple[float, float]:
    cx = (b[0] + b[2]) / 2
    if int(b[4]) == PERSON:                      # a person: the head and shoulders, not the belly
        return cx, b[1] + (b[3] - b[1]) * (0.18 if who == "faces" else 0.3)
    return cx, (b[1] + b[3]) / 2


def _calm(times: Sequence[float], xs: Sequence[Optional[float]], win: float, dead: float) -> List[Tuple[float, float]]:
    """A calm camera path: gaps hold the last place, then an average over ``win`` seconds centred on each moment (so the
    view does not trail behind), then small moves (under ``dead``) are ignored so the picture does not wobble."""
    first = next(x for x in xs if x is not None)
    held, last = [], first
    for x in xs:
        last = last if x is None else x
        held.append(last)
    sm = []
    for i, t in enumerate(times):
        w = [held[j] * (1.0 - abs(times[j] - t) / (win / 2 + 1e-6)) for j in range(len(times)) if abs(times[j] - t) < win / 2]
        k = [1.0 - abs(times[j] - t) / (win / 2 + 1e-6) for j in range(len(times)) if abs(times[j] - t) < win / 2]
        sm.append(sum(w) / sum(k) if sum(k) > 0 else held[i])
    out, pos = [], sm[0]
    for t, x in zip(times, sm):
        if abs(x - pos) > dead:
            pos = x - (dead * 0.5 if x > pos else -dead * 0.5)
        out.append((round(t, 4), round(pos, 5)))
    return out


def subject_path(samples: Dict[float, List[Box]], a: float, b: float, who: str = "auto", feel: str = "steady",
                 room: bool = False) -> List[Tuple[float, float]]:
    """(source time, centre x 0..1) keyframes for one shot, from what was seen between a and b. Empty: nothing to follow."""
    from .facepath import simplify
    times = sorted(t for t in samples if a - 0.4 <= t <= b + 0.4)
    if not times:
        return []
    # join the boxes into tracks
    tracks: List[Dict[str, Any]] = []
    for t in times:
        for bx in samples[t]:
            if _score(bx, who) <= 0:
                continue
            best, bi = 0.3, None
            for tr in tracks:
                if tr["last"] >= t - 1.01 and tr["kind"] == int(bx[4]):
                    o = _iou(tr["box"], bx)
                    if o > best:
                        best, bi = o, tr
            if bi is None:
                bi = {"kind": int(bx[4]), "pts": {}, "score": 0.0}
                tracks.append(bi)
            bi["box"], bi["last"] = bx, t
            bi["pts"][t] = (_point(bx, who), _score(bx, who))
            bi["score"] += _score(bx, who)
    if not tracks:
        return []
    # follow the one that stands out most; when it is gone for a second, the one that stands out most then
    cur: Optional[Dict[str, Any]] = None
    gone_since: Optional[float] = None
    xs: List[Optional[float]] = []
    for t in times:
        here = [tr for tr in tracks if t in tr["pts"]]
        if cur is None:
            cur = max(tracks, key=lambda tr: tr["score"]) if t == times[0] else (max(here, key=lambda tr: tr["pts"][t][1]) if here else None)
        if cur is not None and t in cur["pts"]:
            gone_since = None
        elif cur is not None:
            gone_since = t if gone_since is None else gone_since
            if t - gone_since >= 1.0 and here:
                cur = max(here, key=lambda tr: tr["pts"][t][1])
                gone_since = None
        xs.append(cur["pts"][t][0][0] if cur is not None and t in cur["pts"] else None)
    if all(x is None for x in xs):
        return []
    win, dead = FEELS.get(feel, FEELS["steady"])
    path = _calm(times, xs, win, dead)
    if room and len(path) > 1:                    # space in front: the subject sits a little behind the direction it moves
        out = []
        for i, (t, x) in enumerate(path):
            j0, j1 = max(0, i - 2), min(len(path) - 1, i + 2)
            v = (path[j1][1] - path[j0][1]) / max(1e-6, path[j1][0] - path[j0][0])
            out.append((t, max(0.0, min(1.0, x + max(-0.08, min(0.08, v * 0.25))))))
        path = out
    return simplify(path)


def range_path(samples: Dict[float, List[Box]], a: float, b: float, cuts: Sequence[float], who: str, feel: str, room: bool) -> List[Tuple[float, float]]:
    """The path for a stretch of source time: every shot inside it (between scene changes) looks for its own subject,
    and the frame jumps at the cut instead of gliding across it."""
    path: List[Tuple[float, float]] = []
    edges = [a] + [c for c in cuts if a + 0.3 < c < b - 0.3] + [b]
    for lo, hi in zip(edges, edges[1:]):
        part = subject_path(samples, lo, hi, who, feel, room)
        if not part:
            part = [(lo, path[-1][1])] if path else []
        if len(part) == 1:
            part = [(lo, part[0][1]), (hi, part[0][1])]
        if path and part:
            path.append((lo - 0.001, path[-1][1]))
        path += [p for p in part if lo - 0.001 <= p[0] <= hi + 0.4]
    return sorted(set(path))


def fill_subject_paths(segs: Sequence[Any], planner: Any) -> None:
    """Planner hook: every segment of a following tall or square shape gets the path of the most visible subject of its
    own shot (each cut looks for its own subject). Falls back to the faces (or the middle) when the model is missing."""
    from ..core.fingerprint import file_fingerprint
    from ..core.model import ReframeSpec
    from ..core.cache import home_dir
    opts = getattr(planner, "follow_opts", None) or {"who": "auto", "feel": "steady", "room": False}
    F = planner.F
    ranges = [(s.src_start_f / F, (s.src_start_f + s.src_len_f) / F) for s in segs]
    try:
        finder = Finder(home_dir() / "subjects")
        samples = finder.find(planner.media.path, file_fingerprint(planner.media.path), ranges, planner.media.width, planner.media.height,
                              cancel=getattr(planner.an, "cancel", None))
    except Cancelled:
        raise
    except Exception as exc:  # noqa: BLE001 - no model, no internet: faces then (or the middle)
        planner.warn("Following people and things needs its model (" + (getattr(exc, "message", None) or str(exc))[:120] + "), so faces are followed instead.")
        for s in segs:
            s.reframe = ReframeSpec(s.reframe.aspect, "face", s.reframe.smooth)
        return
    cuts = _scene_cuts(home_dir() / "scenes", file_fingerprint(planner.media.path))
    found = 0
    for s, (a, b) in zip(segs, ranges):
        who = "faces" if s.reframe.mode == "subject:faces" else opts.get("who", "auto")
        path = range_path(samples, a, b, cuts, who, opts.get("feel", "steady"), bool(opts.get("room")))
        if path:
            found += 1
            s.reframe = ReframeSpec(s.reframe.aspect, "subject", s.reframe.smooth, path)
        else:
            s.reframe = ReframeSpec(s.reframe.aspect, "center", s.reframe.smooth, None)
    planner.notes.append(f"Tracking: a subject was followed in {found} of {len(segs)} shot(s); the others stay in the middle.")


def _scene_cuts(folder: Path, fp: str) -> List[float]:
    """The scene changes found for this video (Clips or Edit), when there are any."""
    try:
        return [float(t) for t in json.loads((folder / f"{fp}.json").read_text(encoding="utf-8")).get("scenes") or []]
    except (OSError, ValueError, TypeError):
        return []
