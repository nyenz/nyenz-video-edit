"""Measures how loud a finished file really is (EBU R128 / ITU-R BS.1770, the same measure YouTube uses)."""

from __future__ import annotations

import re
import threading
from typing import Dict, Optional

from ..core.errors import Cancelled
from ..core.ffmpeg import run_ffmpeg

STANDARD_LUFS = -14.0          # YouTube's loudness target
STANDARD_PEAK = -1.0           # the highest true peak we allow, in dBTP
LUFS_TOLERANCE = 0.8           # "meets the standard": within this many LU of the target (quieter is fine for YouTube)
_I = re.compile(r"^\s*I:\s*(-?[\d.]+|-inf)\s*LUFS", re.M)
_LRA = re.compile(r"^\s*LRA:\s*(-?[\d.]+)\s*LU", re.M)
_PEAK = re.compile(r"^\s*Peak:\s*(-?[\d.]+|-inf)\s*dBFS", re.M)


def parse_ebur128(text: str) -> Optional[Dict[str, float]]:
    """Read the summary that FFmpeg's ebur128 filter prints at the end. None when the sound is silent."""
    i = _I.findall(text)
    p = _PEAK.findall(text)
    if not i or not p or i[-1] == "-inf":
        return None
    lra = _LRA.findall(text)
    return {"lufs": round(float(i[-1]), 1), "true_peak": round(float(p[-1]) if p[-1] != "-inf" else -99.0, 1),
            "lra": round(float(lra[-1]), 1) if lra else 0.0}


def judge(m: Optional[Dict[str, float]]) -> Optional[Dict[str, object]]:
    """Add whether it meets the YouTube standard."""
    if not m:
        return None
    ok = m["lufs"] <= STANDARD_LUFS + LUFS_TOLERANCE and m["lufs"] >= STANDARD_LUFS - 1.5 * LUFS_TOLERANCE and m["true_peak"] <= STANDARD_PEAK + 0.05
    return dict(m, target=STANDARD_LUFS, peak_limit=STANDARD_PEAK, ok=bool(ok))


def measure_file(path: str, *, cancel: Optional[threading.Event] = None) -> Optional[Dict[str, object]]:
    """Integrated loudness (LUFS), true peak (dBTP) and loudness range of the sound in a file; None when it has no sound."""
    result = run_ffmpeg(["-i", path, "-map", "0:a:0", "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"], cancel=cancel,
                        loglevel="info", tail_bytes=8000)
    if result.cancelled:
        raise Cancelled()
    if result.returncode != 0:
        return None
    return judge(parse_ebur128(result.stderr_tail))
