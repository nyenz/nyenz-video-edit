"""Even out: loud moments a little down, quiet moments a little up, slowly and smoothly (a 'volume rider').

This is what people usually expect from 'normalise': the sound inside a part becomes more even. It never squashes or
distorts the sound like a compressor can, because the loudness only changes gradually (over about a second), and
moments that are already fine are left exactly as they are.

envelope(path, strength) -> [[seconds, dB], ...]: the change of loudness over the file, simplified to few points.
Strength 1 = gentle, 2 = strong. The result is kept on disk, so a long film is only listened to once.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

HOP = 0.1                      # seconds between loudness values
STRENGTHS = {
    # how far from the usual level is still fine (dB up / dB down), how much of the rest is taken away, and the limits
    1: {"hi": 3.0, "lo": 6.0, "down": 0.6, "up": 0.5, "max_down": -9.0, "max_up": 6.0},
    2: {"hi": 1.5, "lo": 3.0, "down": 0.85, "up": 0.75, "max_down": -14.0, "max_up": 10.0},
}
_LOCK = threading.Lock()
_MEM: Dict[str, List[List[float]]] = {}


def _key(path: str, strength: int) -> str:
    st = os.stat(path)
    return hashlib.sha1(f"{os.path.abspath(path)}|{st.st_size}|{int(st.st_mtime)}|{strength}|v1".encode()).hexdigest()[:24]


def _decode(path: str) -> Any:
    import numpy as np
    from ..core.ffmpeg import get_tools
    raw = subprocess.run([get_tools().ffmpeg, "-nostdin", "-v", "error", "-i", path, "-map", "0:a:0", "-vn", "-ac", "1",
                          "-af", "highpass=f=60,aresample=8000", "-f", "s16le", "-"], capture_output=True, check=False).stdout
    return np.frombuffer(raw[: len(raw) // 2 * 2], dtype="<i2").astype(np.float64) / 32768.0


def _moving(x: Any, n: int, how: str = "mean") -> Any:
    import numpy as np
    if n <= 1 or len(x) == 0:
        return x.copy()
    pad = np.pad(x, (n // 2, n - 1 - n // 2), mode="edge")
    if how == "mean":
        c = np.cumsum(np.insert(pad, 0, 0.0))
        return (c[n:] - c[:-n]) / n
    from numpy.lib.stride_tricks import sliding_window_view
    w = sliding_window_view(pad, n)
    return w.min(axis=1) if how == "min" else w.max(axis=1)


def gains(x: Any, sr: int, strength: int) -> Any:
    """dB change for every HOP of the sound x (mono, -1..1)."""
    import numpy as np
    p = STRENGTHS[2 if strength >= 2 else 1]
    step = int(sr * HOP)
    n = len(x) // step
    if n < 5:
        return np.zeros(max(n, 0))
    frames = x[: n * step].reshape(n, step)
    power = np.mean(frames * frames, axis=1)
    peak = _moving(np.max(np.abs(frames), axis=1), 9, "max")
    short = 10 * np.log10(np.maximum(_moving(power, 30), 1e-12))         # loudness over about 3 s
    loud = float(np.percentile(short, 95))
    silent = short < max(-60.0, loud - 40.0)
    if np.all(silent):
        return np.zeros(n)
    ref = float(np.median(short[~silent]))                                  # the usual level of this sound
    g = np.zeros(n)
    over = short > ref + p["hi"]
    g[over] = -(short[over] - ref - p["hi"]) * p["down"]
    under = (short < ref - p["lo"]) & ~silent
    g[under] = (ref - p["lo"] - short[under]) * p["up"]
    g = np.clip(g, p["max_down"], p["max_up"])
    # never lift a moment so far that its peaks would clip
    room = 20 * np.log10(0.97 / np.maximum(peak, 1e-6))
    g = np.where(g > 0, np.minimum(g, np.maximum(room, 0.0)), g)
    # gradual: go down a little before a loud moment, and glide between levels (about a second)
    g = np.minimum(g, _moving(g, 7, "min"))
    g = _moving(_moving(g, 9), 9)
    g[np.abs(g) < 0.25] = 0.0
    return g


def simplify(g: Sequence[float], hop: float = HOP, tol: float = 0.3) -> List[List[float]]:
    """Few points that follow the changes closely enough (straight lines in between); 0 dB stretches become two points."""
    n = len(g)
    if n == 0 or all(abs(v) < 1e-9 for v in g):
        return []
    out = [[0.0, round(float(g[0]), 2)]]
    i = 0
    while i < n - 1:
        j = i + 1
        while j + 1 < n:                       # stretch the line from i as far as it stays close to every value
            a, b = float(g[i]), float(g[j + 1])
            if any(abs(a + (b - a) * (k - i) / (j + 1 - i) - float(g[k])) > tol for k in range(i + 1, j + 1)) or j + 1 - i > 600:
                break
            j += 1
        out.append([round(j * hop, 2), round(float(g[j]), 2)])
        i = j
    return out


def envelope(path: str, strength: int, cache_dir: Optional[str] = None) -> List[List[float]]:
    """[[seconds of the file, dB], ...] (empty: nothing to change, or numpy is missing). Kept on disk in cache_dir."""
    strength = 2 if strength >= 2 else 1
    try:
        key = _key(path, strength)
    except OSError:
        return []
    with _LOCK:
        if key in _MEM:
            return _MEM[key]
    f = Path(cache_dir) / f"even_{key}.json" if cache_dir else None
    if f is not None and f.is_file():
        try:
            pts = json.loads(f.read_text(encoding="utf-8"))
            with _LOCK:
                _MEM[key] = pts
            return pts
        except (OSError, ValueError):
            pass
    try:
        pts = simplify(gains(_decode(path), 8000, strength))
    except ImportError:
        return []
    with _LOCK:
        if len(_MEM) > 64:
            _MEM.clear()
        _MEM[key] = pts
    if f is not None:
        try:
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(json.dumps(pts), encoding="utf-8")
        except OSError:
            pass
    return pts


def at(points: Sequence[Sequence[float]], t: float) -> float:
    """dB of an envelope at time t (straight lines between the points, 0 outside)."""
    if not points or t <= points[0][0] or t >= points[-1][0]:
        return float(points[0][1]) if points and t <= points[0][0] and abs(t - points[0][0]) < 1e-9 else 0.0
    lo, hi = 0, len(points) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if points[mid][0] <= t:
            lo = mid
        else:
            hi = mid
    (t0, g0), (t1, g1) = points[lo], points[hi]
    return g0 + (g1 - g0) * (t - t0) / max(1e-9, t1 - t0)


def shifted(points: Sequence[Sequence[float]], offset: float) -> List[List[float]]:
    return [[round(t + offset, 3), g] for t, g in points]


def window(points: Sequence[Sequence[float]], a: float, b: float) -> List[Tuple[float, float]]:
    """The points between a and b, with the values at a and b added (so the line is exact inside the window)."""
    if not points:
        return []
    inner = [(float(t), float(g)) for t, g in points if a < t < b]
    out = [(a, at(points, a))] + inner + [(b, at(points, b))]
    return out if any(abs(g) > 0.01 for _, g in out) else []


def filters(points: Sequence[Sequence[float]], a: float, b: float, offset: float = 0.0, per: int = 40) -> List[str]:
    """FFmpeg 'volume' filters that follow the envelope between times a and b of the points' clock. Inside the filter graph
    the time is t + offset on that clock (offset: where the stream's t = 0 lies). Split into several filters of at most
    `per` straight pieces each, so no single expression gets too long."""
    pts = window(points, a, b)
    out = []
    for k in range(0, max(0, len(pts) - 1), per):
        chunk = pts[k: k + per + 1]
        terms = []
        for (t0, g0), (t1, g1) in zip(chunk, chunk[1:]):
            if t1 - t0 < 1e-6:
                continue
            u0, u1 = t0 - offset, t1 - offset
            terms.append(f"gte(t,{u0:.3f})*lt(t,{u1:.3f})*({g0:.2f}+({g1 - g0:.2f})*(t-{u0:.3f})/{u1 - u0:.3f})")
        if terms and any(abs(g) > 0.01 for _, g in chunk):
            lo, hi = chunk[0][0] - offset, chunk[-1][0] - offset
            out.append(f"volume='pow(10,({'+'.join(terms)})/20)':eval=frame:enable='between(t,{lo:.3f},{hi:.3f})'")
    return out
