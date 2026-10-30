"""Finds where a new scene begins, by looking at the pictures on both sides of every possible cut.

Why not just FFmpeg's scene score: one frame jumping is not a new scene (a flash, a hand across the lens, fast
action, a camera shake all make it jump). A real scene change has these three marks:

1. the picture jumps more than the frames around it do (a peak, not a busy stretch),
2. the picture AFTER the jump stays different from the picture BEFORE it (it does not come back), and
3. for slow changes (dissolves, fades through black) the picture before and the picture after are far apart,
   each of them is calm, and no single frame jumps.

Everything works on tiny copies of the frames (32x18, sampled 12 times a second, see ``extract_features``), so it is
quick, and it is cached once per video. The exact frame of a hard cut is then found again at the video's own frame
rate (``refine_cut``). ``separate`` applies the result to the pieces of a project: it also looks at every JOIN
between two pieces, because after cutting and removing, a join can put two different scenes next to each other.
"""

from __future__ import annotations

import re
import subprocess
import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from ..core.errors import Cancelled, FeatureUnavailable
from ..core.ffmpeg import get_tools

FPS = 12.0                    # frames looked at per second
W, H = 32, 18                 # size of the tiny frame
TW, TH = 16, 9                # size of the picture fingerprint kept for every frame
BINS = 4                      # colour bins per channel (4 x 4 x 4 = 64)

HARD_MIN = 0.16               # a hard cut jumps at least this much (0..1)
HARD_RATIO = 2.2              # ... and this many times more than the frames around it
STAY = 0.55                   # the picture after must stay at least this share of the jump away from the picture before
STAY_MIN = 0.13
SOFT_MIN = 0.34               # a dissolve: the picture before and after are at least this far apart
SOFT_CALM = 0.07              # ... and each side is calm (no frame jumps more than this)
BLACK = 0.035                 # a frame darker than this is "black"
RETURN_S = 0.5               # a jump that is undone within this many seconds is not a scene change
MIN_SCENE = 0.4               # seconds; two cuts closer than this are one (the stronger stays)
COVER_CUT = 0.2               # share of the picture that must change at a hard cut ...
COVER_SOFT = 0.4              # ... and across a dissolve
JOIN_HIST = 0.27              # two pieces joined: different scenes when their colours differ by this much ...
JOIN_ALL = 0.38               # ... or their whole picture differs by this much


def available() -> bool:
    try:
        import numpy  # noqa: F401
        return True
    except Exception:
        return False


@dataclass
class Features:
    """What is kept of every sampled frame: a 16x9 colour fingerprint, and a 64-bin colour histogram."""
    fps: float
    thumbs: Any            # (N, 432) uint8
    hist: Any              # (N, 64) float32, each row adds up to 1

    def __len__(self) -> int:
        return int(self.thumbs.shape[0])

    def at(self, t: float) -> int:
        return max(0, min(len(self) - 1, int(round(t * self.fps))))


# ------------------------------------------------------------------------------------------------ reading frames
def _tiny_frames(args: List[str], count_hint: int, cancel: Optional[threading.Event],
                 progress: Optional[Callable[[float], None]] = None):
    """Run FFmpeg and yield (n x 32x18x3 uint8) blocks of tiny frames."""
    import numpy as np
    size = W * H * 3
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
    assert proc.stdout is not None
    done = 0
    try:
        while True:
            if cancel is not None and cancel.is_set():
                raise Cancelled()
            buf = proc.stdout.read(size * 240)
            if not buf:
                break
            n = len(buf) // size
            if n == 0:
                break
            if len(buf) % size:                                   # a partial frame at the very end: read the rest of it
                buf = buf[: n * size]
            done += n
            if progress:
                progress(done)
            yield np.frombuffer(buf, dtype=np.uint8).reshape(n, H, W, 3)
    finally:
        try:
            proc.kill()
        except OSError:
            pass
        proc.wait()


def _summarise(block: Any) -> Tuple[Any, Any]:
    """(n,18,32,3) uint8 -> fingerprints (n,432) uint8 and histograms (n,64) float32."""
    import numpy as np
    n = block.shape[0]
    f = block.astype(np.float32)
    small = f.reshape(n, TH, H // TH, TW, W // TW, 3).mean(axis=(2, 4))
    q = (block.astype(np.int32) * BINS) // 256
    idx = (q[..., 0] * BINS + q[..., 1]) * BINS + q[..., 2]
    hist = np.zeros((n, BINS ** 3), dtype=np.float32)
    flat = idx.reshape(n, -1)
    for i in range(n):
        hist[i] = np.bincount(flat[i], minlength=BINS ** 3)
    hist /= float(H * W)
    return np.rint(small).astype(np.uint8).reshape(n, -1), hist


def extract_features(path: str, duration: float, *, fps: float = FPS, cancel: Optional[threading.Event] = None,
                     progress: Optional[Callable[[float], None]] = None) -> Features:
    import numpy as np
    if not available():
        raise FeatureUnavailable("Finding scenes needs the 'numpy' add-on.", "Install it with:  pip install numpy")
    args = [get_tools().ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-i", path, "-map", "0:v:0", "-an",
            "-vf", f"fps={fps:g},scale={W}:{H}:flags=area,format=rgb24", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    thumbs: List[Any] = []
    hists: List[Any] = []
    for block in _tiny_frames(args, int(duration * fps), cancel,
                              (lambda n: progress(n / fps)) if progress else None):
        t, h = _summarise(block)
        thumbs.append(t)
        hists.append(h)
    if not thumbs:
        raise FeatureUnavailable("No picture could be read from this video.", "Choose a video that has a picture.")
    return Features(fps, np.concatenate(thumbs), np.concatenate(hists))


# ------------------------------------------------------------------------------------------------ distances
def _dist(ta: Any, ha: Any, tb: Any, hb: Any) -> Any:
    """How different two pictures are, 0 (the same) to 1 (nothing alike). Works on rows or on single frames."""
    import numpy as np
    t = np.abs(ta.astype(np.float32) - tb.astype(np.float32)).mean(axis=-1) / 255.0
    h = 0.5 * np.abs(ha - hb).sum(axis=-1)
    return np.minimum(1.0, 0.5 * np.minimum(1.0, t * 3.0) + 0.5 * h)


def _hist_dist(ha: Any, hb: Any) -> Any:
    import numpy as np
    return 0.5 * np.abs(ha - hb).sum(axis=-1)


def _window_median(a: Any, lo: int, hi: int) -> Any:
    """Median of rows lo..hi (inclusive) of a, with the ends held (so it works next to the start and the end)."""
    import numpy as np
    n = a.shape[0]
    idx = np.clip(np.arange(lo, hi + 1), 0, n - 1)
    return np.median(a[idx].astype(np.float32), axis=0)


def _medians(a: Any, lo: int, hi: int) -> Any:
    """For every row i, the median of rows i+lo .. i+hi (clamped). Done in blocks to keep memory small."""
    import numpy as np
    n = a.shape[0]
    out = np.empty((n,) + a.shape[1:], dtype=np.float32)
    step = 2000
    for s in range(0, n, step):
        e = min(n, s + step)
        rows = np.arange(s, e)[:, None] + np.arange(lo, hi + 1)[None, :]
        out[s:e] = np.median(a[np.clip(rows, 0, n - 1)].astype(np.float32), axis=1)
    return out


def _local_max(x: Any, r: int) -> Any:
    import numpy as np
    n = len(x)
    pad = np.pad(x, (r, r), constant_values=-1.0)
    from numpy.lib.stride_tricks import sliding_window_view
    return sliding_window_view(pad, 2 * r + 1).max(axis=1)[:n]


def _baseline(d: Any, r: int = 6) -> Any:
    """How much the frames around each jump are themselves jumping (the average, leaving out the two next to it)."""
    import numpy as np
    from numpy.lib.stride_tricks import sliding_window_view
    n = len(d)
    pad = np.pad(d, (r, r), mode="edge")
    win = sliding_window_view(pad, 2 * r + 1)[:n]
    total = win.sum(axis=1) - win[:, r - 1] - win[:, r] - win[:, r + 1]
    return total / (2 * r + 1 - 3)


# ------------------------------------------------------------------------------------------------ finding the cuts
@dataclass
class Cut:
    t: float                 # seconds: where the new scene starts
    kind: str                # "cut", "dissolve", "black"
    score: float
    frame: int = 0           # sampled frame after which it happens (hard cuts)
    span: int = 0            # dissolves: how many frames on each side were compared


def find_cuts(feats: Features) -> List[Cut]:
    """Every scene change of the video, in time order."""
    import numpy as np
    n = len(feats)
    if n < 6:
        return []
    T, Hh, fps = feats.thumbs, feats.hist, feats.fps
    d = _dist(T[:-1], Hh[:-1], T[1:], Hh[1:])                        # d[i]: frame i -> i+1
    cands: List[Cut] = []

    # 1. hard cuts: a peak, that is much higher than its neighbours, and the new picture stays
    k = 3
    before_t, before_h = _medians(T, -(k - 1), 0), _medians(Hh, -(k - 1), 0)
    after_t, after_h = _medians(T, 1, k), _medians(Hh, 1, k)
    w = _dist(before_t, before_h, after_t, after_h)[:-1]
    base = _baseline(d)
    peak = d >= _local_max(d, 2) - 1e-9
    ok = peak & (d >= HARD_MIN) & (d >= HARD_RATIO * np.maximum(base, 0.03)) & (w >= np.maximum(STAY_MIN, STAY * d))
    lum = T.reshape(n, -1).astype(np.float32).mean(axis=1) / 255.0
    for i in np.flatnonzero(ok):
        if lum[i] <= BLACK or lum[min(n - 1, i + 1)] <= BLACK:       # into or out of black: judged below, as a whole
            continue
        if _comes_back(T, Hh, int(i), fps):
            continue
        cands.append(Cut((i + 1.0) / fps, "cut", float(d[i]), int(i)))

    d_full = np.append(d, 0.0)                                      # one value per frame (the last frame has no next one)
    # 2. slow changes: calm picture, then a long change, then a calm picture again
    for span in (4, 8, 14):
        calm = 3
        lo_t, lo_h = _medians(T, -span - calm, -span), _medians(Hh, -span - calm, -span)
        hi_t, hi_h = _medians(T, span + 1, span + 1 + calm), _medians(Hh, span + 1, span + 1 + calm)
        far = _dist(lo_t, lo_h, hi_t, hi_h)
        # movement inside the calm parts and inside the change itself
        calm_before = _rolling_max(d_full, -span - calm, -span - 1)
        calm_after = _rolling_max(d_full, span + 1, span + calm)
        inside = _rolling_max(d_full, -span, span)
        valid = np.zeros(n, dtype=bool)
        valid[span + calm + 1: n - span - calm - 2] = True
        good = valid & (far >= SOFT_MIN) & (calm_before <= SOFT_CALM) & (calm_after <= SOFT_CALM) & (inside <= 0.6 * far)
        peak2 = far >= _local_max(far, span) - 1e-9
        for i in np.flatnonzero(good & peak2):
            cands.append(Cut((i + 0.5) / fps, "dissolve", float(far[i]), int(i), span))

    # 3. through black: picture, black, a different picture (a blink or a dark moment in one scene does not count)
    dark = lum <= BLACK
    i = 0
    while i < n:
        if not dark[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and dark[j + 1]:
            j += 1
        if j - i + 1 >= 2 and i >= 2 and j + 3 < n:
            a = _norm(T[max(0, i - 7)])
            b = _norm(T[min(n - 1, j + 7)])
            diff = float(np.abs(a - b).mean() / 255.0)
            hd = float(_hist_dist(Hh[max(0, i - 7)], Hh[min(n - 1, j + 7)]))
            if diff >= 0.2 or hd >= 0.3:
                cands.append(Cut(((i + j) / 2.0) / fps, "black", max(diff * 3, hd), int((i + j) // 2)))
        i = j + 1

    # a real scene change changes most of the picture; a line of typing, a light turning on or an object moving does not
    cells = T.reshape(n, TH * TW, 3).astype(np.float32)
    kept = []
    for c in cands:
        if c.kind == "cut":
            i0, i1, need = c.frame, c.frame + 1, COVER_CUT
        elif c.kind == "dissolve":
            i0, i1, need = c.frame - c.span, c.frame + c.span + 1, COVER_SOFT
        else:
            kept.append(c)
            continue
        a = np.median(cells[max(0, i0 - 2): i0 + 1], axis=0)
        b = np.median(cells[min(n - 1, i1): min(n, i1 + 3)], axis=0)
        if float((np.abs(a - b).mean(axis=1) / 255.0 > 0.12).mean()) >= need:
            kept.append(c)
    out = _thin(kept, MIN_SCENE, feats)
    for c in out:
        if c.kind == "dissolve":
            c.t = _dissolve_centre(feats, c)
    return out


def _comes_back(T: Any, Hh: Any, i: int, fps: float) -> bool:
    """A jump after which the old picture is back within half a second, or that comes from a picture like the new one a
    moment ago, is a hand, a flash or a dip to black inside one scene, not a new scene."""
    import numpy as np
    n, reach = len(T), max(3, int(round(RETURN_S * fps)))
    a0, a1 = max(0, i - 2), i + 1                         # the picture before the jump
    b0, b1 = i + 1, min(n, i + 4)                         # the picture after it
    ta, ha = np.median(T[a0:a1].astype(np.float32), axis=0), np.median(Hh[a0:a1], axis=0)
    tb, hb = np.median(T[b0:b1].astype(np.float32), axis=0), np.median(Hh[b0:b1], axis=0)
    jump = float(_dist(ta, ha, tb, hb))
    for m in range(3, reach + 1):                        # the old picture again, later
        j0, j1 = i + m, min(n, i + m + 3)
        if j1 - j0 >= 2 and float(_dist(ta, ha, np.median(T[j0:j1].astype(np.float32), axis=0), np.median(Hh[j0:j1], axis=0))) < 0.35 * jump:
            return True
    for m in range(3, reach + 1):                        # the new picture, earlier
        j1 = i - m + 1
        j0 = max(0, j1 - 3)
        if j1 - j0 >= 2 and float(_dist(tb, hb, np.median(T[j0:j1].astype(np.float32), axis=0), np.median(Hh[j0:j1], axis=0))) < 0.35 * jump:
            return True
    return False


def _rolling_max(d: Any, lo: int, hi: int) -> Any:
    """For every i, the biggest d[i+lo .. i+hi] (outside the video counts as 0)."""
    import numpy as np
    n = len(d)
    out = np.zeros(n)
    for s in range(lo, hi + 1):
        if s >= n or -s >= n:
            continue
        if s >= 0:
            out[: n - s] = np.maximum(out[: n - s], d[s:])
        else:
            out[-s:] = np.maximum(out[-s:], d[: n + s])
    return out


def _norm(thumb: Any) -> Any:
    """A fingerprint with its brightness evened out, to compare a faded picture with a normal one."""
    import numpy as np
    f = thumb.astype(np.float32)
    m = float(f.mean())
    return f * (110.0 / max(m, 18.0))


def _thin(cands: List[Cut], gap: float, feats: Features) -> List[Cut]:
    """Keep one of cuts that are too close. A fade through black wins (its steps look like cuts), then hard cuts; of slow changes the sharper (smaller span) comes first."""
    rank = {"black": 0, "cut": 1}
    order = sorted(cands, key=lambda c: (rank.get(c.kind, 2), c.span, -c.score))
    kept: List[Cut] = []
    for c in order:
        ok = True
        for o in kept:
            need = gap if (c.kind == "cut" and o.kind == "cut") else (2.5 if (c.kind != "cut" and o.kind != "cut") else 1.0)
            if abs(c.t - o.t) < need:
                ok = False
                break
        if ok:
            kept.append(c)
    return sorted(kept, key=lambda c: c.t)


def _dissolve_centre(feats: Features, c: Cut) -> float:
    """The moment halfway through a dissolve: where the picture is as far from the old scene as from the new one."""
    import numpy as np
    n, calm, span, i = len(feats), 3, c.span, c.frame
    lo, hi = max(0, i - span - calm), min(n - 1, i + span + 1 + calm)
    ia, ib = np.arange(lo, max(lo, i - span) + 1), np.arange(min(n - 1, i + span + 1), hi + 1)
    ta, ha = np.median(feats.thumbs[ia].astype(np.float32), axis=0), np.median(feats.hist[ia], axis=0)
    tb, hb = np.median(feats.thumbs[ib].astype(np.float32), axis=0), np.median(feats.hist[ib], axis=0)
    ks = np.arange(max(0, i - span), min(n, i + span + 2))
    da = _dist(feats.thumbs[ks], feats.hist[ks], ta, ha)
    db = _dist(feats.thumbs[ks], feats.hist[ks], tb, hb)
    for j in range(len(ks)):
        if da[j] >= db[j]:
            return float(ks[j]) / feats.fps
    return c.t


# ------------------------------------------------------------------------------------------------ the exact frame
_PTS = re.compile(r"pts_time:\s*(-?[\d.]+)")


def refine_cut(path: str, t: float, *, radius: float = 0.3, cancel: Optional[threading.Event] = None) -> float:
    """Look again at the video's own frames around a hard cut and return the time between the last frame of the
    old scene and the first frame of the new one."""
    import numpy as np
    start = max(0.0, t - radius)
    args = [get_tools().ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "info", "-ss", f"{start:.3f}", "-t", f"{2 * radius:.3f}",
            "-i", path, "-map", "0:v:0", "-an", "-vf", f"showinfo,scale={W}:{H}:flags=area,format=rgb24", "-vsync", "passthrough",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    try:
        proc = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return t
    size = W * H * 3
    n = len(proc.stdout) // size
    times = [start + float(m.group(1)) for m in _PTS.finditer(proc.stderr.decode("utf-8", "replace"))]
    if n < 3 or len(times) < n:
        return t
    block = np.frombuffer(proc.stdout[: n * size], dtype=np.uint8).reshape(n, H, W, 3)
    th, hi = _summarise(block)
    d = _dist(th[:-1], hi[:-1], th[1:], hi[1:])
    # the biggest jump nearest the guess
    best = max(range(len(d)), key=lambda i: d[i] - 0.02 * abs((times[i] + times[i + 1]) / 2 - t))
    if d[best] < HARD_MIN * 0.8:
        return t
    return round((times[best] + times[best + 1]) / 2, 4)


def refine_all(path: str, cuts: Sequence[Cut], cancel: Optional[threading.Event] = None,
               progress: Optional[Callable[[float], None]] = None) -> List[Cut]:
    out: List[Cut] = []
    for k, c in enumerate(cuts):
        if cancel is not None and cancel.is_set():
            raise Cancelled()
        t = refine_cut(path, c.t, cancel=cancel) if c.kind == "cut" else c.t
        out.append(Cut(round(t, 4), c.kind, c.score, c.frame))
        if progress:
            progress((k + 1) / max(1, len(cuts)))
    return out


# ------------------------------------------------------------------------------------------------ in the project
def picture_differs(feats: Features, t_before: float, t_after: float) -> Tuple[bool, float]:
    """Are the pictures at these two moments different scenes? (the last frames of one piece, the first of the next)"""
    import numpy as np
    a, b = feats.at(t_before), feats.at(t_after)
    ia = np.arange(max(0, a - 1), a + 1)
    ib = np.arange(b, min(len(feats), b + 2))
    ta, ha = np.median(feats.thumbs[ia].astype(np.float32), axis=0), np.median(feats.hist[ia], axis=0)
    tb, hb = np.median(feats.thumbs[ib].astype(np.float32), axis=0), np.median(feats.hist[ib], axis=0)
    whole = float(_dist(ta, ha, tb, hb))
    colours = float(_hist_dist(ha, hb))
    return (colours >= JOIN_HIST or whole >= JOIN_ALL), max(colours, whole)


def _first_last(p: Dict[str, Any]) -> Tuple[float, float]:
    """Parent times of the first and the last picture of a piece as it plays."""
    return (p["end"], p["start"]) if p.get("reverse") else (p["start"], p["end"])


def separate(pieces: Sequence[Dict[str, Any]], cuts: Sequence[float], feats: Optional[Features],
             min_piece: float = 0.1, snap: float = 0.08) -> Tuple[List[Dict[str, Any]], int]:
    """Cut the kept pieces at the scene changes inside them, and number the scenes (``unit``): a scene change is a
    detected cut inside a piece, or a join between two pieces whose pictures are different scenes.
    Removed pieces are carried along unchanged. Returns (pieces, number of scenes)."""
    import copy
    ts = sorted(float(c) for c in cuts)
    out: List[Dict[str, Any]] = []
    scene = -1
    prev_last: Optional[Tuple[float, Dict[str, Any]]] = None
    first = True
    for p in pieces:
        if p.get("off"):
            q = copy.deepcopy(p)
            q.pop("unit", None)
            out.append(q)
            continue
        inner = [t for t in ts if p["start"] + snap < t < p["end"] - snap]
        edges = [p["start"]] + inner + [p["end"]]
        parts = []
        for a, b in zip(edges, edges[1:]):
            q = copy.deepcopy(p)
            q["start"], q["end"], q["off"] = round(a, 4), round(b, 4), False
            if q["end"] - q["start"] >= min_piece:
                parts.append(q)
        if p.get("reverse"):
            parts.reverse()
        for j, q in enumerate(parts):
            f_t, l_t = _first_last(q)
            if first:
                scene = 0
                first = False
            elif j > 0:
                scene += 1                                     # a detected cut inside the piece
            elif prev_last is not None:
                joined = abs(prev_last[0] - f_t) <= snap * 0.5     # the piece continues straight on: no join to look at
                if not joined:
                    differs = True if feats is None else picture_differs(feats, prev_last[0], f_t)[0]
                    if differs:
                        scene += 1
            q["unit"] = max(scene, 0)
            out.append(q)
            prev_last = (l_t, q)
    return out, scene + 1 if not first else 0
