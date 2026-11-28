"""Separate again: pull one kind of sound out of a split track (voices out of the music, effects out of the music,
music out of the effects ...) and put it on its own track, where it belongs.

* **Voices** are pulled out with a model made only for voices (Kim Vocal 2, an MDX-Net model from Ultimate Vocal
  Remover's public models). It is much more thorough with voices than the three-way model the first split uses.
* **Music** and **effects** are pulled out with the three-way model (BandIt Plus, the one the first split uses), on the
  chosen track only.

Strength: *gentle* goes over the sound once; *aggressive* goes over what is left once more, so less hides behind.
Quality: *fast* (quickest), *balanced* (each moment heard twice: the sound and its mirror image, averaged, which takes
out the model's own noise) and *thorough* (balanced, and one more time over what is left).

Everything is streamed in chunks of about 6 seconds, so a long track does not need much memory.
"""

from __future__ import annotations

import hashlib
import os
import threading
import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from .core.errors import EditForgeError

MODEL_ID = "voice-split-1"
MODEL_FILE = MODEL_ID + ".onnx"
MODEL_URL = "https://github.com/nyenz/nyenz-video-edit/releases/download/voice-model-1/voice-split-1.onnx"
MODEL_SHA256 = "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b"
MODEL_SIZE = 66759214
MODEL_CREDIT = ("Kim Vocal 2, an MDX-Net voice model by KimberleyJensen, from the public models of Ultimate Vocal Remover "
                "(Anjok07 and aufr33).")

SAMPLE_RATE = 44100
N_FFT = 7680
HOP = 1024
DIM_F = 3072
DIM_T = 256
CHUNK = HOP * (DIM_T - 1)            # 261 120 samples, about 5.9 s
TRIM = N_FFT // 2                     # the edges of each chunk are only context
GEN = CHUNK - 2 * TRIM                # what each chunk gives
COMPENSATE = 1.009                    # this model's output is a little quiet (its makers' number)
QUALITIES = ("fast", "balanced", "thorough")
STRENGTHS = ("gentle", "aggressive")


def passes(quality: str, strength: str) -> int:
    """How many times the sound is gone over."""
    return (2 if strength == "aggressive" else 1) + (1 if quality == "thorough" else 0)


def model_path(home: Optional[Path] = None) -> Path:
    from .splitter import models_dir
    return models_dir(home) / MODEL_FILE


def model_ready(home: Optional[Path] = None) -> bool:
    p = model_path(home)
    return p.is_file() and p.stat().st_size == MODEL_SIZE


def download_model(home: Optional[Path] = None, progress: Optional[Callable[[float], None]] = None,
                   cancel: Optional[threading.Event] = None) -> Path:
    """Download the voice model once (66 MB) and check its fingerprint."""
    dest = model_path(home)
    if model_ready(home):
        return dest
    if os.environ.get("EDITFORGE_NO_DOWNLOAD"):
        raise EditForgeError("The voice model is not here and downloads are switched off.", "Put voice-split-1.onnx in the models folder.")
    tmp = dest.with_suffix(".part")
    h = hashlib.sha256()
    try:
        with urllib.request.urlopen(MODEL_URL, timeout=60) as r, open(tmp, "wb") as f:
            got = 0
            while True:
                if cancel is not None and cancel.is_set():
                    raise EditForgeError("Stopped.", "")
                buf = r.read(1 << 20)
                if not buf:
                    break
                f.write(buf)
                h.update(buf)
                got += len(buf)
                if progress:
                    progress(min(1.0, got / MODEL_SIZE))
    except EditForgeError:
        tmp.unlink(missing_ok=True)
        raise
    except Exception as exc:  # noqa: BLE001
        tmp.unlink(missing_ok=True)
        raise EditForgeError("The voice model could not be downloaded.", "Check the internet connection and try again. (" + str(exc)[:120] + ")")
    if h.hexdigest() != MODEL_SHA256:
        tmp.unlink(missing_ok=True)
        raise EditForgeError("The voice model that was downloaded is not the right file.", "Try again later.")
    os.replace(tmp, dest)
    return dest


# --------------------------------------------------------------------------------------------- the voice model
def _window(np):
    n = np.arange(N_FFT, dtype=np.float64)
    return (0.5 - 0.5 * np.cos(2 * np.pi * n / N_FFT)).astype(np.float32)          # periodic Hann (as torch.hann_window)


def stft(x, np):
    """(channels, CHUNK) -> (1, 4, DIM_F, DIM_T): real and imaginary parts of each channel (torch.stft, center=True)."""
    win = _window(np)
    pad = N_FFT // 2
    xp = np.pad(x, ((0, 0), (pad, pad)), mode="reflect")
    idx = np.arange(N_FFT)[None, :] + HOP * np.arange(DIM_T)[:, None]
    out = np.empty((1, 4, DIM_F, DIM_T), dtype=np.float32)
    for c in range(2):
        spec = np.fft.rfft(xp[c][idx] * win, axis=-1).T[:DIM_F]                  # (DIM_F, DIM_T)
        out[0, 2 * c] = spec.real
        out[0, 2 * c + 1] = spec.imag
    return out


def istft(spec, np):
    """(1, 4, DIM_F, DIM_T) -> (2, CHUNK). The missing high bins are zero."""
    win = _window(np)
    bins = N_FFT // 2 + 1
    pad = N_FFT // 2
    total = HOP * (DIM_T - 1) + N_FFT
    w2 = np.zeros(total, dtype=np.float64)
    for t in range(DIM_T):
        w2[t * HOP:t * HOP + N_FFT] += win.astype(np.float64) ** 2
    out = np.zeros((2, CHUNK), dtype=np.float32)
    for c in range(2):
        comp = np.zeros((bins, DIM_T), dtype=np.complex64)
        comp[:DIM_F] = spec[0, 2 * c] + 1j * spec[0, 2 * c + 1]
        frames = np.fft.irfft(comp.T, n=N_FFT, axis=-1) * win                     # (DIM_T, N_FFT)
        buf = np.zeros(total, dtype=np.float64)
        for t in range(DIM_T):
            buf[t * HOP:t * HOP + N_FFT] += frames[t]
        out[c] = (buf / np.maximum(w2, 1e-8))[pad:pad + CHUNK]
    return out


class VoiceEngine:
    """Kim Vocal 2 with onnxruntime on the CPU: (2, CHUNK) -> the voices in it (2, CHUNK)."""

    def __init__(self, path: str, threads: Optional[int] = None):
        import numpy as np
        import onnxruntime as ort
        self.np = np
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = threads or max(1, (os.cpu_count() or 2) - 1)
        opts.inter_op_num_threads = 1
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = ort.InferenceSession(str(path), opts, providers=["CPUExecutionProvider"])
        self.input = self.session.get_inputs()[0].name

    def __call__(self, chunk, mirror: bool = True):
        np = self.np
        if float(np.abs(chunk).max()) < 1e-4:
            return np.zeros_like(chunk)
        spec = stft(chunk, np)
        pred = self.session.run(None, {self.input: spec})[0]
        if mirror:                                   # the sound and its mirror image, averaged: the model's own noise cancels
            pred = 0.5 * pred - 0.5 * self.session.run(None, {self.input: -spec})[0]
        return istft(pred, np) * COMPENSATE


# --------------------------------------------------------------------------------------------- pulling out
def pull_out(source: str, start: float, end: float, out_dir: Path, what: str, *, layer: str, quality: str = "balanced",
             strength: str = "gentle", voice_engine: Optional[Callable] = None, three_engine: Optional[Callable] = None,
             progress: Optional[Callable[[float], None]] = None, cancel: Optional[threading.Event] = None) -> Dict[str, str]:
    """Pull ``what`` ('voices', 'music' or 'effects') out of ``source`` (a split track, ``layer``) from start to end seconds.
    Writes out_dir/pulled.flac (what was pulled out) and out_dir/rest.flac (the track without it), both from ``start``.
    The two always add up to the sound that went in."""
    import numpy as np
    from .splitter import LAYERS, _Reader, _Writer, Cancelled
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    n_pass = passes(quality, strength)
    duration = max(0.05, end - start)
    total = int(round(duration * SAMPLE_RATE))
    if what == "voices":
        if voice_engine is None:
            raise EditForgeError("The voice model is not ready.", "Try again: it is downloaded first.")
        size, gen, trim = CHUNK, GEN, TRIM

        def find(chunk):
            return voice_engine(chunk, mirror=quality != "fast")
    else:
        if three_engine is None:
            raise EditForgeError("The sound splitter is not ready.", "Split the sound once first.")
        from .splitter import CHUNK as BCHUNK
        size, trim = BCHUNK, BCHUNK // 10
        gen = size - 2 * trim
        k = LAYERS.index(what)

        def find(chunk):
            return three_engine(chunk, fast=quality == "fast")[k]
    reader = _Reader(source, start, duration)
    parts = {k: str(out_dir / (k + ".flac.part")) for k in ("pulled", "rest")}
    writers = {k: _Writer(v) for k, v in parts.items()}
    buf = np.zeros((2, trim), dtype=np.float32)          # the context before the first chunk is silence
    eof, done = False, 0
    try:
        while done < total:
            if cancel is not None and cancel.is_set():
                raise Cancelled()
            while buf.shape[1] < size and not eof:
                raw = reader.read(size - buf.shape[1])
                if not raw:
                    eof = True
                    break
                buf = np.concatenate([buf, np.frombuffer(raw[: len(raw) // 8 * 8], dtype=np.float32).reshape(-1, 2).T], axis=1)
            have = buf.shape[1]
            if have <= trim:
                break
            chunk = buf if have >= size else np.pad(buf, ((0, 0), (0, size - have)))
            chunk = np.ascontiguousarray(chunk[:, :size], dtype=np.float32)
            rest, pulled = chunk, np.zeros_like(chunk)
            for _ in range(n_pass):                      # aggressive / thorough: go over what is left again
                got = find(rest)
                pulled = pulled + got
                rest = chunk - pulled
            emit = min(gen, have - trim, total - done)
            for name, arr in (("pulled", pulled), ("rest", rest)):
                part = np.clip(arr[:, trim:trim + emit], -1.0, 1.0)
                writers[name].write(np.ascontiguousarray(part.T, dtype=np.float32))
            done += emit
            if progress:
                progress(min(0.999, done / max(total, 1)))
            buf = buf[:, gen:]
        reader.close()
        for w in writers.values():
            w.close()
        if done == 0:
            raise EditForgeError("There is no sound in that part to separate.", "Choose parts that have sound.")
        out = {}
        for k, p in parts.items():
            os.replace(p, str(out_dir / (k + ".flac")))
            out[k] = str(out_dir / (k + ".flac"))
        return out
    except BaseException:
        reader.close()
        for w in writers.values():
            w.abort()
        for p in parts.values():
            try:
                os.remove(p)
            except OSError:
                pass
        raise


def credits() -> Dict[str, Any]:
    return {"model": MODEL_ID, "credit": MODEL_CREDIT}
