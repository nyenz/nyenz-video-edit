"""Following something with the camera: a face, or any object you draw a box around.

Both give a path of (source time, x, y) with x and y as fractions of the picture (0..1). The planner
turns that into a zoomed view that glides after the subject.

* Faces come from the face detector (several times a second) and are smoothed so the view is calm.
* Objects are followed by points (optical flow, checked forwards and back), a picture match that corrects
  them, and a search of the whole frame when the thing is lost (see ``track_object``). No model download.
"""

from __future__ import annotations

import subprocess
import threading
from typing import Any, List, Optional, Sequence, Tuple

from ..core.errors import Cancelled, EditForgeError, FeatureUnavailable
from ..core.ffmpeg import get_tools
from .facepath import Face, track_all

Point = Tuple[float, float, float]

TRACK_FPS = 15.0
TRACK_WIDTH = 480
MAX_TRACK_SECONDS = 300.0
LOST_SCORE = 0.35


def face_points(samples: Sequence[Tuple[float, Sequence[Face]]], smooth: float = 0.6) -> List[Point]:
    """A calm (time, x, y) path that follows the face seen the most. Empty when no face was found."""
    times = [t for t, _ in samples]
    tracks = track_all(samples)
    if not tracks or not times:
        return []
    main = max(tracks, key=lambda tr: len(tr.samples))
    xs: List[Optional[float]] = []
    ys: List[Optional[float]] = []
    for t in times:
        near = [(abs(ts - t), f) for ts, f in main.samples if abs(ts - t) <= 1.0]
        if near:
            f = min(near, key=lambda x: x[0])[1]
            xs.append(f.cx)
            ys.append(min(1.0, f.cy + 0.15 * f.h))       # a little below the middle of the face keeps the chin and neck in view
        else:
            xs.append(None)
            ys.append(None)
    known = [v for v in xs if v is not None]
    if not known:
        return []
    last_x, last_y = known[0], next(v for v in ys if v is not None)
    points: List[Point] = []
    for t, x, y in zip(times, xs, ys):            # when the face is not seen for a moment the view waits where it was
        if x is not None and y is not None:
            last_x, last_y = x, y
        points.append((t, last_x, last_y))
    return calm(points, smooth)                   # smoothed both ways, so the view is calm but does not lag behind


def value_at(path: Sequence[Point], t: float) -> Tuple[float, float]:
    """The (x, y) of a path at time ``t`` (held at the first and last point outside the path)."""
    if t <= path[0][0]:
        return path[0][1], path[0][2]
    for (t0, x0, y0), (t1, x1, y1) in zip(path, path[1:]):
        if t <= t1:
            k = (t - t0) / (t1 - t0) if t1 > t0 else 0.0
            return x0 + (x1 - x0) * k, y0 + (y1 - y0) * k
    return path[-1][1], path[-1][2]


def window(path: Sequence[Point], lo: float, hi: float, max_points: int = 24) -> List[Point]:
    """The part of a path between two times, with exact points at both ends and at most ``max_points`` points."""
    if not path:
        return []
    inside = [p for p in path if lo < p[0] < hi]
    if len(inside) > max_points - 2:
        step = len(inside) / float(max_points - 2)
        inside = [inside[int(i * step)] for i in range(max_points - 2)]
    x0, y0 = value_at(path, lo)
    x1, y1 = value_at(path, hi)
    return [(round(lo, 4), round(x0, 5), round(y0, 5))] + [(round(t, 4), round(x, 5), round(y, 5)) for t, x, y in inside] + \
        [(round(hi, 4), round(x1, 5), round(y1, 5))]


def calm(points: Sequence[Point], strength: float = 0.5) -> List[Point]:
    """Smooth a path forwards and then backwards, so the view does not shake and does not lag behind."""
    if len(points) < 3:
        return list(points)
    a = max(0.05, min(1.0, 1.0 - strength))
    xs, ys = [p[1] for p in points], [p[2] for p in points]
    for seq in (xs, ys):
        for i in range(1, len(seq)):
            seq[i] = seq[i - 1] + a * (seq[i] - seq[i - 1])
        for i in range(len(seq) - 2, -1, -1):
            seq[i] = seq[i + 1] + a * (seq[i] - seq[i + 1])
    return [(p[0], round(x, 5), round(y, 5)) for p, x, y in zip(points, xs, ys)]


def view_position(centre: float, zoom: float) -> float:
    """Where the zoomed view must sit (0 = far left/top, 1 = far right/bottom) so ``centre`` is in its middle."""
    if zoom <= 1.0001:
        return 0.5
    return max(0.0, min(1.0, (centre - 0.5 / zoom) / (1.0 - 1.0 / zoom)))


def object_tracking_available() -> bool:
    try:
        import cv2
        import numpy  # noqa: F401
        return hasattr(cv2, "matchTemplate")
    except Exception:
        return False


def _read_frames(path: str, start: float, end: float, w: int, h: int, cancel: Optional[threading.Event]) -> List[Any]:
    import numpy as np
    cmd = [get_tools().ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-ss", f"{start:.3f}", "-t", f"{max(0.1, end - start):.3f}",
           "-i", path, "-an", "-vf", f"fps={TRACK_FPS},scale={w}:{h},format=gray", "-f", "rawvideo", "-pix_fmt", "gray", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
    frames: List[Any] = []
    size = w * h
    assert proc.stdout is not None
    try:
        while True:
            if cancel is not None and cancel.is_set():
                raise Cancelled()
            buf = proc.stdout.read(size)
            if len(buf) < size:
                break
            frames.append(np.frombuffer(buf, dtype=np.uint8).reshape(h, w))
    finally:
        try:
            proc.kill()
        except OSError:
            pass
        proc.wait()
    return frames


def track_object(path: str, at: float, box: Sequence[float], start: float, end: float, src_w: int, src_h: int,
                 cancel: Optional[threading.Event] = None) -> Tuple[List[Point], float]:
    """Follow the thing inside ``box`` (x, y, w, h as fractions of the picture, seen at time ``at``) from ``start`` to ``end``.

    Three methods work together, every frame (15 a second, on a 480-pixel copy):
    1. points: up to 80 small corners inside the box are followed from frame to frame (optical flow); each one is also
       followed BACK, and a point that does not come back to where it started is not trusted. The box moves by the
       middle (median) of the trusted points, so a few wrong ones do not pull it away.
    2. picture: the box's picture is looked for near that new place; a good match corrects the position (and keeps
       slowly learning how the thing looks, so turning and lighting changes are followed).
    3. finding it again: when both lose it (covered, out of the picture), the whole frame is searched every few frames
       and following goes on when it is found again; meanwhile the view waits where it last saw it.

    Returns (path, found): ``path`` is (time, x, y) of the middle of the thing, 15 times a second, smoothed; ``found``
    is the share of the time it was followed with confidence.
    """
    if not object_tracking_available():
        raise FeatureUnavailable("Following an object is switched off because the free 'opencv-python-headless' add-on is not installed.",
                                 "Install it with:  pip install 'opencv-python-headless<5'")
    import cv2
    import numpy as np
    if end - start > MAX_TRACK_SECONDS:
        raise EditForgeError(f"That is {end - start:.0f} seconds to follow; the most is {MAX_TRACK_SECONDS:.0f}.",
                             "Pick fewer pieces, and follow the object in each group separately.")
    if not (start - 0.05 <= at <= end + 0.05):
        raise EditForgeError("The moment you drew the box is not inside the picked pieces.",
                             "Pause the video inside one of the picked pieces, then draw the box again.")
    bx, by, bw, bh = (float(v) for v in box)
    bx, by = max(0.0, min(0.98, bx)), max(0.0, min(0.98, by))
    bw, bh = max(0.02, min(1.0 - bx, bw)), max(0.02, min(1.0 - by, bh))
    w = TRACK_WIDTH
    h = max(2, int(round(w * src_h / src_w / 2)) * 2)
    frames = _read_frames(path, start, end, w, h, cancel)
    if len(frames) < 2:
        raise EditForgeError("I could not read that part of the video.", "Try other pieces.")
    k0 = max(0, min(len(frames) - 1, int(round((at - start) * TRACK_FPS))))
    tw, th = max(10, int(round(bw * w))), max(10, int(round(bh * h)))
    x0, y0 = max(0, min(w - tw, int(round(bx * w)))), max(0, min(h - th, int(round(by * h))))
    first = frames[k0][y0:y0 + th, x0:x0 + tw].astype(np.float32)
    if float(first.std()) < 2.0:
        raise EditForgeError("The box is on a plain area with nothing to recognise.", "Draw the box tightly around something with a clear shape.")
    lk = dict(winSize=(21, 21), maxLevel=3, criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01))
    near = max(8, int(round(0.06 * w)))               # how far the picture match may correct the points
    pos = {k0: (float(x0), float(y0), 1.0)}

    def corners(img: Any, x: float, y: float) -> Any:
        m = np.zeros_like(img)
        xi, yi = int(round(x)), int(round(y))
        m[max(0, yi):max(0, yi) + th, max(0, xi):max(0, xi) + tw] = 255
        return cv2.goodFeaturesToTrack(img, maxCorners=80, qualityLevel=0.01, minDistance=3, mask=m, blockSize=5)

    def match(img: Any, tpl: Any, x: float, y: float, reach: int) -> Tuple[float, float, float]:
        ax, ay = int(max(0, x - reach)), int(max(0, y - reach))
        zx, zy = int(min(w, x + tw + reach)), int(min(h, y + th + reach))
        area = img[ay:zy, ax:zx].astype(np.float32)
        if area.shape[0] < th or area.shape[1] < tw:
            return x, y, -1.0
        res = cv2.matchTemplate(area, tpl, cv2.TM_CCOEFF_NORMED)
        _, score, _, loc = cv2.minMaxLoc(res)
        if score != score:
            return x, y, -1.0
        return float(ax + loc[0]), float(ay + loc[1]), float(score)

    def run(order: Sequence[int]) -> None:
        tpl = first.copy()
        x, y = float(x0), float(y0)
        prev = frames[k0]
        pts = corners(prev, x, y)
        vx = vy = 0.0                                       # how it was moving (used while it is lost)
        lost = 0
        for k in order:
            if cancel is not None and cancel.is_set():
                raise Cancelled()
            img = frames[k]
            nx, ny, conf = x + vx, y + vy, 0.0
            moved = False
            if pts is not None and len(pts) >= 4:          # 1. points, checked back
                p1, st1, _ = cv2.calcOpticalFlowPyrLK(prev, img, pts, None, **lk)
                if p1 is not None:
                    p0r, st2, _ = cv2.calcOpticalFlowPyrLK(img, prev, p1, None, **lk)
                    if p0r is not None:
                        fb = np.abs(pts - p0r).reshape(-1, 2).max(axis=1)
                        good = (st1.reshape(-1) == 1) & (st2.reshape(-1) == 1) & (fb < 1.0)
                        if int(good.sum()) >= 4:
                            dxy = np.median((p1 - pts).reshape(-1, 2)[good], axis=0)
                            nx, ny = x + float(dxy[0]), y + float(dxy[1])
                            moved = True
            mx, my, score = match(img, tpl, nx, ny, near)   # 2. picture
            if score >= 0.55:
                nx, ny = (mx, my) if not moved else (0.5 * nx + 0.5 * mx, 0.5 * ny + 0.5 * my)
                conf = score
            elif moved and score >= LOST_SCORE:
                conf = score
            elif not moved:
                lost += 1
                if lost % 3 == 0:                               # 3. look for it in the whole frame
                    gx, gy, gs = match(img, tpl, w / 2 - tw / 2, h / 2 - th / 2, max(w, h))
                    if gs >= 0.65:
                        nx, ny, conf = gx, gy, gs
            nx, ny = max(0.0, min(w - tw, nx)), max(0.0, min(h - th, ny))
            if conf >= LOST_SCORE:
                vx, vy = 0.7 * vx + 0.3 * (nx - x), 0.7 * vy + 0.3 * (ny - y)
                lost = 0
                if conf >= 0.7:                                 # sure: let the picture of the thing adapt slowly
                    xi, yi = int(round(nx)), int(round(ny))
                    patch = img[yi:yi + th, xi:xi + tw].astype(np.float32)
                    if patch.shape == tpl.shape:
                        tpl = 0.9 * tpl + 0.1 * patch
            else:
                vx, vy = 0.8 * vx, 0.8 * vy                     # lost: slow down and wait
                if lost > 3:
                    nx, ny = x, y
            pos[k] = (nx, ny, conf)
            if conf >= LOST_SCORE and (pts is None or len(pts) < 20 or k % 5 == 0):
                pts = corners(img, nx, ny)
            elif pts is not None and moved:
                pts = p1.reshape(-1, 1, 2)[good.reshape(-1)] if int(good.sum()) >= 4 else pts
            x, y, prev = nx, ny, img

    run(range(k0 + 1, len(frames)))
    run(range(k0 - 1, -1, -1))
    points = [(round(start + k / TRACK_FPS, 4), (pos[k][0] + tw / 2.0) / w, (pos[k][1] + th / 2.0) / h) for k in range(len(frames))]
    found = sum(1 for k in range(len(frames)) if pos[k][2] >= LOST_SCORE) / float(len(frames))
    return calm(points, 0.35), round(found, 3)
