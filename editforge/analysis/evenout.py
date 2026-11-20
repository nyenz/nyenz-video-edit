"""Even out: loud moments a little down, quiet moments a little up, slowly and smoothly (a 'volume rider').

This is what people usually expect from 'normalise': the sound inside a part becomes more even. It never squashes or
distorts the sound like a compressor can, because the loudness only changes gradually (over about a second), and
moments that are already fine are left exactly as they are.

envelope(path, strength) -> [[seconds, dB], ...]: the change of loudness over the file, simplified to few points.
Strength 1 = gentle (most of the way to the usual level), 2 = strong (all the way, quickly). The result is kept on disk, so a long film is only listened to once.
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
    # win: how long a moment is measured (hops of 0.1 s); hi / lo: how far over / under the usual level is still fine (dB);
    # down / up: how much of the rest is taken away; max_down / max_up: the limits; fast: a sudden loud burst (a shot, a
    # shout, a door) is also taken down this far over the usual level (dB), within a tenth of a second; attack / glide:
    # how many hops it starts going down before a loud moment, and how smoothly it changes (hops)
    1: {"win": 10, "hi": 1.5, "lo": 2.5, "down": 0.8, "up": 0.75, "max_down": -18.0, "max_up": 12.0, "fast": 8.0, "attack": 4, "glide": 5},
    2: {"win": 5, "hi": 0.5, "lo": 1.0, "down": 1.0, "up": 0.95, "max_down": -30.0, "max_up": 18.0, "fast": 4.0, "attack": 2, "glide": 3},
}
_LOCK = threading.Lock()
_MEM: Dict[str, List[List[float]]] = {}


def _key(path: str, strength: int) -> str:
    st = os.stat(path)
    return hashlib.sha1(f"{os.path.abspath(path)}|{st.st_size}|{int(st.st_mtime)}|{strength}|v2".encode()).hexdigest()[:24]


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
    """dB change for every HOP of the sound x (mono, -1..1): every moment is brought close to the usual level of the
    sound (gentle: most of the way, strong: all the way), and sudden loud bursts are caught within a tenth of a second.
    Silence (and the quiet hiss between words) is never pulled up."""
    import numpy as np
    p = STRENGTHS[2 if strength >= 2 else 1]
    step = int(sr * HOP)
    n = len(x) // step
    if n < 5:
        return np.zeros(max(n, 0))
    frames = x[: n * step].reshape(n, step)
    power = np.mean(frames * frames, axis=1)
    now = 10 * np.log10(np.maximum(power, 1e-12))                          # each tenth of a second
    short = 10 * np.log10(np.maximum(_moving(power, p["win"]), 1e-12))      # each moment (0.5 s strong, 1 s gentle)
    loud = float(np.percentile(short, 95))
    silent = short < max(-60.0, loud - 35.0)
    if np.all(silent):
        return np.zeros(n)
    ref = float(np.median(short[~silent]))                                  # the usual level of this sound
    g = np.zeros(n)
    over = short > ref + p["hi"]
    g[over] = -(short[over] - ref - p["hi"]) * p["down"]
    under = (short < ref - p["lo"]) & ~silent
    g[under] = (ref - p["lo"] - short[under]) * p["up"]
    # quiet ends of words next to silence are lifted only as far as the moment around them, so hiss is not pulled up
    g = np.where(g > 0, np.minimum(g, np.maximum(0.0, short - max(-60.0, loud - 35.0))), g)
    # a sudden burst: down within a tenth of a second, as far as needed to stay near the usual level
    burst = np.where(now > ref + p["fast"], -(now - ref - p["fast"]), 99.0)
    g = np.minimum(g, burst)
    g = np.clip(g, p["max_down"], p["max_up"])
    # the final limiter catches what is left, but never lift a moment so far that it would have to work hard
    peak = _moving(np.max(np.abs(frames), axis=1), 5, "max")
    room = 20 * np.log10(1.4 / np.maximum(peak, 1e-6))
    g = np.where(g > 0, np.minimum(g, np.maximum(room, 0.0)), g)
    # gradual: start going down a little before a loud moment, then glide (fast enough to follow, never jumpy)
    g = np.minimum(g, _moving(g, 2 * p["attack"] + 1, "min"))
    g = _moving(_moving(g, p["glide"]), p["glide"])
    g = np.minimum(g, _moving(burst, 3, "min"))            # bursts stay caught after the smoothing
    g = np.clip(g, p["max_down"], p["max_up"])
    g[np.abs(g) < 0.25] = 0.0
    return g


def simplify(g: Sequence[float], hop: float = HOP, tol: float = 0.4) -> List[List[float]]:
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
