"""TransNetV2: a neural network made only for finding where one shot ends and the next begins.

Soucek & Lokoc, "TransNet V2: An effective deep network architecture for fast shot transition detection" (2020), MIT
licence. It looks at every frame of the video (shrunk to 48 x 27) in windows of 100 frames, and for every frame it gives
the chance that a shot change happens there; it is trained on hard cuts and on dissolves and fades. Its weights were
converted to ONNX once (see .github/workflows/vision-models.yml) and run here with onnxruntime, which the sound splitter
already uses.

How it is used: the scene finder reads every frame once anyway (``shots.extract_all``); the same pass also gives these
48 x 27 frames, which go through the network while the video is read (``Streamer``). Windows of 100 frames step 50 frames at
a time (25 frames of context on each side, as the authors do), so a two-hour film never needs more than about 300 tiny frames
in memory. A change is where the chance is over 0.5; a run of such frames is one change (a dissolve when it is long). Hard
cuts are then put on their exact frame by looking at the full pictures again (``shots.refine_cut``).
"""

from __future__ import annotations

import subprocess
import threading
from pathlib import Path
from typing import Any, List, Optional, Tuple

from ..core.errors import Cancelled
from ..core.ffmpeg import get_tools

MODEL_NAME = "transnetv2.onnx"
W, H = 48, 27
WIN, STEP, PAD = 100, 50, 25
THRESHOLD = 0.5

_SESSIONS: dict = {}
_LOCK = threading.Lock()


def model_file(home: Optional[Path] = None) -> Path:
    from .. import splitter
    return splitter.models_dir(home) / MODEL_NAME


def available(home: Optional[Path] = None) -> bool:
    """The model file is in place (right size) and onnxruntime and numpy can be loaded."""
    try:
        import numpy  # noqa: F401
        import onnxruntime  # noqa: F401
    except Exception:
        return False
    from .. import modelpack
    f = next((x for x in modelpack.FILES if x["name"] == MODEL_NAME), None)
    p = model_file(home)
    return f is not None and p.is_file() and p.stat().st_size == int(f["size"])


def _session(path: Path) -> Any:
    with _LOCK:
        s = _SESSIONS.get(str(path))
        if s is None:
            import onnxruntime as ort
            opts = ort.SessionOptions()
            opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            s = ort.InferenceSession(str(path), sess_options=opts, providers=["CPUExecutionProvider"])
            _SESSIONS[str(path)] = s
        return s


class Streamer:
    """Runs the network while the frames arrive: push() blocks of (n, 27, 48, 3) uint8 frames, finish() gives the chance of a
    change at every frame. Only the current window (at most 100 + one block of frames) is kept in memory."""

    def __init__(self, model: Path):
        import numpy as np
        self.np = np
        self.sess = _session(model)
        self.inp = self.sess.get_inputs()[0].name
        outs = [o.name for o in self.sess.get_outputs()]
        self.single = outs.index("single") if "single" in outs else 0
        self.buf = None
        self.out: List[Any] = []
        self.count = 0
        self._thread: Optional[threading.Thread] = None
        self._error: Optional[BaseException] = None

    def _run(self) -> None:
        np = self.np
        x = self.buf[:WIN].astype(np.float32)[None]                   # [1, 100, 27, 48, 3], 0..255
        y = self.sess.run(None, {self.inp: x})[self.single]
        self.out.append(np.asarray(y, dtype=np.float32).reshape(-1)[PAD:PAD + STEP])
        self.buf = self.buf[STEP:]

    def push(self, block: Any) -> None:
        """Hand over the next frames. The network runs on its own thread, so reading the video goes on meanwhile."""
        import queue
        if self._error is not None:
            raise self._error
        if self._thread is None:
            self._queue: "queue.Queue[Any]" = queue.Queue(maxsize=16)
            self._thread = threading.Thread(target=self._work, name="editforge-transnet", daemon=True)
            self._thread.start()
        self._queue.put(self.np.array(block, dtype=self.np.uint8, copy=True))

    def _work(self) -> None:
        while True:
            block = self._queue.get()
            if block is None:
                return
            if self._error is None:
                try:
                    self._push(block)
                except BaseException as exc:  # noqa: BLE001 - given to the reader by push() / finish()
                    self._error = exc

    def _push(self, block: Any) -> None:
        np = self.np
        block = np.ascontiguousarray(block, dtype=np.uint8).reshape(-1, H, W, 3)
        if not len(block):
            return
        if self.buf is None:                                          # the start is padded with the first frame
            self.buf = np.repeat(block[:1], PAD, axis=0)
        self.buf = np.concatenate([self.buf, block])
        self.count += len(block)
        while len(self.buf) >= WIN:
            self._run()

    def close(self) -> None:
        """Stop the network's thread without waiting for an answer (the reading was stopped or failed)."""
        if self._thread is not None:
            self._error = self._error or RuntimeError("stopped")
            self._queue.put(None)
            self._thread = None

    def finish(self) -> Any:
        np = self.np
        if self._thread is not None:
            self._queue.put(None)
            self._thread.join()
            self._thread = None
        if self._error is not None:
            raise self._error
        if not self.count:
            return np.zeros(0, dtype=np.float32)
        last = self.buf[-1:]
        while sum(len(o) for o in self.out) < self.count:             # the end is padded with the last frame
            if len(self.buf) < WIN:
                self.buf = np.concatenate([self.buf, np.repeat(last, WIN - len(self.buf), axis=0)])
            self._run()
        return np.concatenate(self.out)[:self.count]


def predict(path: str, rate: float, *, model: Path, cancel: Optional[threading.Event] = None) -> Any:
    """The chance of a shot change at every frame of a video read at ``rate`` frames a second (its own reading pass)."""
    import numpy as np
    st = Streamer(model)
    cmd = [get_tools().ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-i", path, "-map", "0:v:0", "-an",
           "-vf", f"fps={rate:.6f},scale={W}:{H},format=rgb24", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
    assert proc.stdout is not None
    size = W * H * 3
    try:
        while True:
            if cancel is not None and cancel.is_set():
                raise Cancelled()
            raw = proc.stdout.read(size * 200)
            n = len(raw) // size
            if n:
                st.push(np.frombuffer(raw[:n * size], dtype=np.uint8).reshape(n, H, W, 3))
            if len(raw) < size * 200:
                break
    finally:
        try:
            proc.kill()
        except OSError:
            pass
        proc.wait()
    return st.finish()


def near(probs: Any, rate: float, t: float, frames: int = 3) -> float:
    """The highest chance of a change within a few frames of time t (0 when there is nothing there)."""
    if probs is None or not len(probs):
        return 0.0
    k = int(round(t * rate))
    lo, hi = max(0, k - frames), min(len(probs), k + frames + 1)
    return float(probs[lo:hi].max()) if hi > lo else 0.0


def changes(probs: Any, fps: float, threshold: float = THRESHOLD) -> List[Tuple[float, str, float, int]]:
    """(time, kind, strength, frames) of every change: a run of frames over the threshold is one change. Its time is the
    moment of the highest chance (a hard cut: next to that frame; ``shots.refine_fine`` then finds the exact pair of frames), or
    the middle of a long run (a dissolve)."""
    out: List[Tuple[float, str, float, int]] = []
    n = len(probs)
    i = 0
    while i < n:
        if probs[i] < threshold:
            i += 1
            continue
        j = i
        while j + 1 < n and probs[j + 1] >= threshold:
            j += 1
        peak = max(range(i, j + 1), key=lambda k: float(probs[k]))
        length = j - i + 1
        if length >= 4:
            out.append(((i + j + 1) / 2.0 / fps, "dissolve", float(probs[peak]), length))
        else:
            out.append(((peak + 0.5) / fps, "cut", float(probs[peak]), length))
        i = j + 1
    return out


KEEP = 0.1          # a change the older finder saw is kept only when the network also sees at least this chance there
APART = 0.8         # seconds: a change the older finder saw this close to one the network found is the same change


PAIR = 1.5          # seconds: two of the network's changes closer than this are looked at together
BRIEF = 0.6         # seconds: a picture that comes and goes this quickly is something in front of the lens, not a cut-away
SURE = 0.9          # a cut the network is this sure of stays, even when the pictures on both sides look alike


def combine(classic: List[Any], probs: Any, rate: float, threshold: float = THRESHOLD, feats: Any = None) -> List[Any]:
    """The network's changes, plus the older finder's changes that the network does not rule out (it saw at least a small
    chance there). Each checks the other: a cut the network is not sure of, with the same picture a quarter of a second
    before and after it (a flash), is dropped; two changes close together with the same picture around them (a hand, a dip
    to black) are no change; two around a plain picture with different scenes around them (a fade through black) are one. Together they miss less and invent less."""
    from . import shots
    from .shots import Cut
    raw = [Cut(round(t, 4), kind, score, 0, 0) for t, kind, score, _ in changes(probs, rate, threshold)]
    mine: List[Any] = []
    if feats is None or not len(feats):
        mine = raw
    else:
        i = 0
        while i < len(raw):
            a = raw[i]
            b = raw[i + 1] if i + 1 < len(raw) else None
            if b is not None and b.t - a.t < PAIR:
                # two changes close together: something came and went (a hand, a dip to black: no change at all), or the
                # picture went through black or white to a new scene (one change, in the middle)
                plain = _plain(feats, (a.t + b.t) / 2)
                same = not shots.picture_differs(feats, max(0.0, a.t - 0.25), b.t + 0.25)[0]
                if same and (plain or b.t - a.t < BRIEF):          # (a longer cut-away and back is two real cuts)
                    i += 2
                    continue
                if plain:
                    mine.append(Cut(round((a.t + b.t) / 2, 4), "black", max(a.score, b.score), 0, 0))
                    i += 2
                    continue
            if a.kind == "cut" and a.score < SURE and not shots.picture_differs(feats, max(0.0, a.t - 0.25), a.t + 0.25)[0]:
                i += 1                                  # a flash: the same picture just before and just after
                continue
            mine.append(a)
            i += 1
    out = list(mine)
    for c in classic:
        if any(abs(c.t - m.t) < APART for m in mine):
            continue
        reach = 3 if c.kind == "cut" else max(3, int(rate))
        if near(probs, rate, c.t, reach) >= KEEP:
            out.append(c)
    out.sort(key=lambda c: c.t)
    return out


def _plain(feats: Any, t: float) -> bool:
    """Is the picture at time t one flat colour (black, white, ...)?"""
    import numpy as np
    k = max(0, min(len(feats) - 1, feats.at(t)))
    return float(np.asarray(feats.thumbs[k], dtype=np.float32).std()) < 10.0
