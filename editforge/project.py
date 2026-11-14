"""Projects: a video cut into pieces that can be removed, re-ordered, stretched and given edits one by one.

The script language works on ranges of the source in time order. A project is freer: pieces can be
moved, repeated and made longer so they overlap. So a project is turned straight into the engine's
internal :class:`~editforge.core.model.Timeline` (the renderer only ever reads that model).

A project is plain JSON::

    {"name": "...", "source": "<file id>",
     "pieces": [{"start": 0.0, "end": 2.0, "off": false, "speed": 1.0, "reverse": false, "mute": false,
                 "volume": 1.0, "fx": ["hflip"], "zoom": {"mode": "in", "amount": 1.3},
                 "color": {"brightness": 0.0, "contrast": 1.0, "saturation": 1.0}}, ...],
     "settings": {"shape": "original", "transition": "none", "transition_s": 0.3, "music": "", "music_volume": 0.25,
                  "duck": true, "original_sound": true, "even_loudness": false, "fade_in": 0.0, "fade_out": 0.0,
                  "quality": "best"}}
"""

from __future__ import annotations

import math
import os
import re
import threading
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from .analysis import follow as follow_mod
from .analysis.faces import make_face_provider
from .analysis.manager import Analyzer
from .analysis.speech import Word, import_transcript
from .api import Plan, default_output_path
from .core.errors import EditForgeError, FeatureUnavailable, ScriptError
from .core.fingerprint import source_identity
from .core.media import MediaInfo, probe_media
from .core.model import (AudioSpec, CameraSpec, CaptionSpec, ColorSpec, EffectSpec, JoinSpec, MusicSpec, ReframeSpec, Segment,
                         TextOverlay, Timeline)
from .dsl.loader import load_script
from .dsl.registry import EFFECT_NAMES, XFADE
from .planner.captions import group_lines
from .planner.files import FileResolver, find_font
from .planner.planner import Planner
from .presets.presets import resolve_output

MAX_PIECES = 5000
MIN_PIECE_SECONDS = 0.04
ZOOM_MODES = ("none", "in", "out", "hold")
FOLLOW_MODES = ("none", "face", "object")
MAX_FOLLOW_POINTS = 600
MAX_TEXTS = 50
TEXT_POSITIONS = ("top", "center", "bottom", "top_left", "top_right", "bottom_left", "bottom_right")
TEXT_SIZES = {"small": 40.0, "medium": 64.0, "large": 96.0, "huge": 140.0}
TEXT_COLORS = {"white": "#ffffff", "black": "#000000", "yellow": "#ffe600", "red": "#ff3030", "blue": "#3090ff", "green": "#30d060"}
CAPTION_STYLES = ("karaoke", "plain", "boxed")
CAPTION_SIZES = {"small": 42.0, "medium": 56.0, "large": 76.0}
#: shape name -> (output preset, crop aspect or None, follow faces?, fit)
SHAPES: Dict[str, tuple] = {
    "original": ("original", None, False, None),
    "vertical": ("shorts", "9:16", False, None),
    "vertical_follow": ("shorts", "9:16", True, None),
    "vertical_blur": ("shorts", None, False, "blur"),
    "square": ("instagram_square", "1:1", False, None),
    "square_follow": ("instagram_square", "1:1", True, None),
    "square_blur": ("instagram_square", None, False, "blur"),
}
#: quality name -> (CRF, x264 preset). Lower CRF is better; "medium" squeezes more quality into each megabyte than "veryfast".
QUALITIES: Dict[str, tuple] = {"best": (17, "medium"), "high": (20, "veryfast"), "small": (23, "veryfast")}
#: the long side of the exported picture. 4K is the default: YouTube gives 4K uploads its best quality, also for viewers on 1080p.
EXPORT_SIZES: Dict[str, Optional[int]] = {"4k": 3840, "1440": 2560, "1080": 1920, "source": None}
DEFAULT_SETTINGS: Dict[str, Any] = {
    "shape": "original", "transition": "none", "transition_s": 0.3, "music": "", "music_volume": 0.25, "duck": True,
    "original_sound": True, "even_loudness": False, "fade_in": 0.0, "fade_out": 0.0, "quality": "best",
    "captions": "off", "caption_style": "karaoke", "caption_position": "bottom", "caption_size": "medium",
    # sound clean-up
    "noise": "off", "vocals": "keep", "voice_boost": False, "compress": False, "bass": 0.0, "treble": 0.0,
    # the three sound layers (voices / music / effects) of a split video: which split to use, and how loud each layer is
    "mix_split": "", "mix_voices": 1.0, "mix_music": 1.0, "mix_effects": 1.0, "mix_found": 1.0, "mix_found_voices": 1.0, "mix_found_music": 1.0, "mix_found_effects": 1.0,
    # extra music layers: [{"file": id, "volume": 0..2, "mute": bool, "solo": bool}], and which of the video's own layers are muted / soloed
    "layers": [], "mute": [], "solo": [],
    # the frame: canvas shape, background layer, move / scale / turn, mask (see clean_frame)
    "frame": None,
}
MIX_LAYERS = ("voices", "music", "effects")
STEM_KEYS = MIX_LAYERS + ("found", "found_voices", "found_music", "found_effects")   # what Separate again pulled out of chosen parts
SOUND_KEYS = ("original",) + STEM_KEYS          # the video's own sound (as one piece), or its three layers once split
MAX_LAYERS = 8
#: the final mix of every video meets the YouTube standard: -14 LUFS, and no peak above -1 dB (true peak)
FINAL_LOUDNESS = {"target": -14.0, "true_peak": -1.5, "lra": 11.0}
#: the canvas shapes (CapCut's list); "5.8in" is a tall phone screen
FRAME_RATIOS: Dict[str, Optional[tuple]] = {"original": None, "16:9": (16, 9), "4:3": (4, 3), "2.35:1": (2.35, 1), "2:1": (2, 1),
                                             "1.85:1": (1.85, 1), "9:16": (9, 16), "3:4": (3, 4), "1:1": (1, 1), "4:5": (4, 5),
                                             "5.8in": (9, 19.5)}
FRAME_BGS = ("black", "white", "blur")
MASK_SHAPES = ("none", "strip", "vstrip", "rect", "circle", "split")
DEFAULT_FRAME: Dict[str, Any] = {"ratio": "original", "bg": "blur", "blur": 50.0, "scale": 1.0, "x": 0.0, "y": 0.0, "rotate": 0.0, "edge": 0.0,
                                 "mask": {"shape": "none", "x": 0.5, "y": 0.5, "w": 1.0, "h": 0.35, "feather": 20.0, "invert": False, "rot": 0.0}}
SPLIT_ID = re.compile(r"^[0-9a-f]{32}/\d{9}-\d{9}(~\d{14})?$")      # ~stamp: a project's cleaned-up copy (Separate again)
NOISE_LEVELS = {"off": 0.0, "light": 10.0, "medium": 18.0, "strong": 28.0}
VOCALS = ("keep", "remove", "voice")


def _num(value: Any, default: float, lo: float, hi: float) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    if v != v or v in (float("inf"), float("-inf")):
        return default
    return max(lo, min(hi, v))


def clean_piece(raw: Any, duration: float) -> Optional[Dict[str, Any]]:
    """Return a safe, complete copy of one piece, or None if it is not usable."""
    if not isinstance(raw, dict):
        return None
    try:
        start, end = float(raw["start"]), float(raw["end"])
    except (KeyError, TypeError, ValueError):
        return None
    if start != start or end != end:
        return None
    start, end = max(0.0, start), min(float(duration), end)
    if end - start < MIN_PIECE_SECONDS:
        return None
    fx_raw = raw.get("fx") if isinstance(raw.get("fx"), list) else []
    fx: List[str] = []
    for name in fx_raw:
        if name in EFFECT_NAMES and name not in fx:
            fx.append(name)
    zoom_raw = raw.get("zoom") if isinstance(raw.get("zoom"), dict) else {}
    mode = zoom_raw.get("mode") if zoom_raw.get("mode") in ZOOM_MODES else "none"
    color_raw = raw.get("color") if isinstance(raw.get("color"), dict) else {}
    follow_raw = raw.get("follow") if isinstance(raw.get("follow"), dict) else {}
    follow_mode = follow_raw.get("mode") if follow_raw.get("mode") in FOLLOW_MODES else "none"
    points: List[List[float]] = []
    if follow_mode == "object" and isinstance(follow_raw.get("path"), list):
        for pt in follow_raw["path"][:MAX_FOLLOW_POINTS]:
            try:
                t, x, y = float(pt[0]), float(pt[1]), float(pt[2])
            except (TypeError, ValueError, IndexError):
                continue
            if t == t and x == x and y == y and abs(t) < 1e7:
                points.append([round(t, 3), round(max(0.0, min(1.0, x)), 4), round(max(0.0, min(1.0, y)), 4)])
        points.sort()
    if follow_mode == "object" and len(points) < 2:
        follow_mode = "none"
    extra: Dict[str, Any] = {}
    unit = raw.get("unit")
    if isinstance(unit, int) and not isinstance(unit, bool) and 0 <= unit <= 10 * MAX_PIECES:
        extra["unit"] = unit                  # pieces cut from one new piece in a later step share a unit (see recut)
    place = clean_place(raw.get("place"))
    if place:
        extra["place"] = place                # this piece's own position of the video layer (Final, Picture)
    mix = clean_piece_mix(raw.get("mix"))
    if mix:
        extra["mix"] = mix                    # this piece's own loudness / mute of each split sound layer (Final, Sound)
    extra.update(clean_shape(raw))            # even out, fade in / out of this section's own sound
    return {**extra,
        "start": round(start, 4), "end": round(end, 4), "off": bool(raw.get("off")),
        "speed": round(_num(raw.get("speed"), 1.0, 0.1, 16.0), 4), "reverse": bool(raw.get("reverse")),
        "mute": bool(raw.get("mute")), "volume": round(_num(raw.get("volume"), 1.0, 0.0, 4.0), 3), "fx": fx,
        "zoom": {"mode": mode, "amount": round(_num(zoom_raw.get("amount"), 1.3, 1.0, 4.0), 3)},
        "color": {"brightness": round(_num(color_raw.get("brightness"), 0.0, -1.0, 1.0), 3),
                  "contrast": round(_num(color_raw.get("contrast"), 1.0, 0.0, 3.0), 3),
                  "saturation": round(_num(color_raw.get("saturation"), 1.0, 0.0, 3.0), 3)},
        "follow": {"mode": follow_mode, "zoom": round(_num(follow_raw.get("zoom"), 1.6, 1.1, 4.0), 3),
                   "path": points if follow_mode == "object" else []},
    }


MAX_FADE = 10.0


def clean_shape(raw: Any) -> Dict[str, Any]:
    """Even out (0 off, 1 gentle, 2 strong) and gentle fade in / out (seconds) of a part's sound; only what is set."""
    out: Dict[str, Any] = {}
    if not isinstance(raw, dict):
        return out
    try:
        ev = int(raw.get("even") or 0)
    except (TypeError, ValueError):
        ev = 0
    if ev in (1, 2):
        out["even"] = ev
    for k in ("fin", "fout"):
        v = round(_num(raw.get(k), 0.0, 0.0, MAX_FADE), 2)
        if v >= 0.05:
            out[k] = v
    return out


def clean_piece_mix(raw: Any) -> Optional[Dict[str, Dict[str, Any]]]:
    """A piece's own loudness of the split sound layers: {'voices': {'volume': 0..2, 'mute': bool}, ...}.
    Layers left at full loudness and not muted are left out."""
    if not isinstance(raw, dict):
        return None
    out: Dict[str, Dict[str, Any]] = {}
    for layer in STEM_KEYS:
        v = raw.get(layer)
        if not isinstance(v, dict):
            continue
        vol, mute = round(_num(v.get("volume"), 1.0, 0.0, 2.0), 3), bool(v.get("mute"))
        group = str(v.get("group") or "")
        shape = clean_shape(v)
        if mute or abs(vol - 1.0) > 0.001 or re.fullmatch(r"g[0-9a-z]{1,10}", group) or shape:
            out[layer] = {"volume": vol, "mute": mute, **shape}
            if re.fullmatch(r"g[0-9a-z]{1,10}", group):
                out[layer]["group"] = group
    return out or None


def piece_layer_gain(piece: Dict[str, Any]) -> Optional[Dict[str, float]]:
    mix = piece.get("mix")
    if not mix:
        return None
    return {k: 0.0 if v.get("mute") else float(v.get("volume", 1.0)) for k, v in mix.items()
            if v.get("mute") or abs(float(v.get("volume", 1.0)) - 1.0) > 0.001} or None


def clean_place(raw: Any) -> Optional[Dict[str, float]]:
    """A piece's own position of the video layer: {x, y, scale, rotate} (the same meaning as in the frame)."""
    if not isinstance(raw, dict):
        return None
    return {"x": round(_num(raw.get("x"), 0.0, -2.0, 2.0), 4), "y": round(_num(raw.get("y"), 0.0, -2.0, 2.0), 4),
            "scale": round(_num(raw.get("scale"), 1.0, 0.1, 4.0), 3), "rotate": round(_num(raw.get("rotate"), 0.0, -180.0, 180.0), 2)}


def clean_texts(raw: Any) -> List[Dict[str, Any]]:
    """Words to show on the picture. Times are seconds of the FINISHED video; an end of 0 means "until the end"."""
    out: List[Dict[str, Any]] = []
    for item in (raw if isinstance(raw, list) else [])[:MAX_TEXTS]:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or "").replace("\r", "").strip()[:200]
        if not text:
            continue
        start = round(_num(item.get("start"), 0.0, 0.0, 1e6), 3)
        end = round(_num(item.get("end"), 0.0, 0.0, 1e6), 3)
        out.append({"text": text, "start": start, "end": end if end > start else 0.0,
                    "position": item.get("position") if item.get("position") in TEXT_POSITIONS else "bottom",
                    "size": item.get("size") if item.get("size") in TEXT_SIZES else "medium",
                    "color": item.get("color") if item.get("color") in TEXT_COLORS else "white",
                    "box": bool(item.get("box", True))})
    return out


def clean_settings(raw: Any) -> Dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    s = dict(DEFAULT_SETTINGS)
    if raw.get("shape") in SHAPES:
        s["shape"] = raw["shape"]
    if raw.get("transition") == "none" or raw.get("transition") in XFADE:
        s["transition"] = raw["transition"]
    s["transition_s"] = round(_num(raw.get("transition_s"), 0.3, 0.1, 3.0), 3)
    s["music"] = str(raw.get("music") or "")[:300]
    s["music_volume"] = round(_num(raw.get("music_volume"), 0.25, 0.0, 2.0), 3)
    for key in ("duck", "original_sound", "even_loudness"):
        if key in raw:
            s[key] = bool(raw[key])
    s["fade_in"] = round(_num(raw.get("fade_in"), 0.0, 0.0, 10.0), 3)
    s["fade_out"] = round(_num(raw.get("fade_out"), 0.0, 0.0, 10.0), 3)
    if raw.get("quality") in QUALITIES:
        s["quality"] = raw["quality"]
    s["export_size"] = raw.get("export_size") if raw.get("export_size") in EXPORT_SIZES else "4k"
    s["captions"] = str(raw.get("captions") or "off")[:300]          # "off", "auto" (listen to the speech) or a subtitle file id
    if raw.get("caption_style") in CAPTION_STYLES:
        s["caption_style"] = raw["caption_style"]
    if raw.get("caption_position") in ("top", "center", "bottom"):
        s["caption_position"] = raw["caption_position"]
    if raw.get("caption_size") in CAPTION_SIZES:
        s["caption_size"] = raw["caption_size"]
    if raw.get("caption_height") is not None and raw.get("caption_height") != "":
        s["caption_height"] = round(_num(raw.get("caption_height"), 6.0, 0.0, 90.0), 1)   # by hand: % above the bottom edge
    if raw.get("noise") in NOISE_LEVELS:
        s["noise"] = raw["noise"]
    if raw.get("vocals") in VOCALS:
        s["vocals"] = raw["vocals"]
    for key in ("voice_boost", "compress"):
        if key in raw:
            s[key] = bool(raw[key])
    s["bass"] = round(_num(raw.get("bass"), 0.0, -12.0, 12.0), 1)
    s["treble"] = round(_num(raw.get("treble"), 0.0, -12.0, 12.0), 1)
    layers = []
    for x in (raw.get("layers") if isinstance(raw.get("layers"), list) else [])[:MAX_LAYERS]:
        if isinstance(x, dict) and str(x.get("file") or ""):
            y = {"file": str(x["file"])[:300], "volume": round(_num(x.get("volume"), 0.5, 0.0, 2.0), 3),
                 "mute": bool(x.get("mute")), "solo": bool(x.get("solo"))}
            parts = clean_music_parts(x.get("parts"))
            if parts:
                y["parts"] = parts
            dk = x.get("duck") if isinstance(x.get("duck"), dict) else {}
            if dk.get("on"):
                y["duck"] = {"on": True, "level": round(_num(dk.get("level"), DUCK_LEVEL, 0.0, 1.0), 3)}
                if dk.get("under") in ("music", "effects"):
                    y["duck"]["under"] = dk["under"]      # what it goes down under (voices when not said)
            skip = round(_num(x.get("start"), 0.0, 0.0, 36000.0), 2)
            if skip >= 0.05:
                y["start"] = skip                         # where in the song it starts (seconds into the file)
            if x.get("locked"):
                y["locked"] = True
            try:
                auto = int(x.get("auto") or 0)
            except (TypeError, ValueError):
                auto = 0
            if auto in (1, 2):
                y["auto"] = auto              # Auto level: the song evened out by itself (gentle / strong)
            for k, d in (("fade_in", 0.5), ("fade_out", 1.5)):
                if x.get(k) is not None:
                    y[k] = round(_num(x.get(k), d, 0.0, MAX_FADE), 2)
            layers.append(y)
    s["layers"] = layers
    for key in ("mute", "solo"):
        s[key] = [k for k in SOUND_KEYS if k in (raw.get(key) if isinstance(raw.get(key), list) else [])]
    sid = str(raw.get("mix_split") or "")
    s["mix_split"] = sid if SPLIT_ID.match(sid) else ""
    for layer in STEM_KEYS:
        s["mix_" + layer] = round(_num(raw.get("mix_" + layer), 1.0, 0.0, 2.0), 3)
    ducks: Dict[str, Dict[str, Any]] = {}                 # split tracks that go down while another one is heard
    rd = raw.get("ducks") if isinstance(raw.get("ducks"), dict) else {}
    for layer in STEM_KEYS:
        dk = rd.get(layer) if isinstance(rd.get(layer), dict) else {}
        under = dk.get("under") if dk.get("under") in MIX_LAYERS else ("voices" if layer != "voices" else "music")
        if dk.get("on") and under != layer:
            ducks[layer] = {"on": True, "level": round(_num(dk.get("level"), DUCK_LEVEL, 0.0, 1.0), 3), "under": under}
    s["ducks"] = ducks
    fr = clean_frame(raw.get("frame")) if isinstance(raw.get("frame"), dict) else None
    s["frame"] = fr if frame_active(fr) else None
    lk = raw.get("locks") if isinstance(raw.get("locks"), dict) else {}
    s["locks"] = {k: bool(lk.get(k)) for k in ("video", "sound") + STEM_KEYS}   # locked tracks (like CapCut)
    groups = []
    for g in raw.get("sound_groups") if isinstance(raw.get("sound_groups"), list) else []:
        if isinstance(g, dict) and re.fullmatch(r"g[0-9a-z]{1,10}", str(g.get("id") or "")) and len(groups) < 50:
            groups.append({"id": str(g["id"]), "name": str(g.get("name") or "Group")[:40], "locked": bool(g.get("locked"))})
    s["sound_groups"] = groups                # named groups of sound parts (pieces[].mix[layer].group)
    return s


DUCK_LEVEL = 0.35           # how loud the music stays while someone talks (35 %)
DUCK_DOWN, DUCK_UP = 0.35, 0.8   # seconds to go down before the voice, and back up after it (gradually)
MAX_MUSIC_PARTS = 2000


def clean_music_parts(raw: Any) -> Optional[List[Dict[str, Any]]]:
    """The parts of a music track, cut like the video sections: [{'end': s or None, 'volume': 0..2, 'mute': bool}], in
    order; each part ends at 'end' (finished-video time) and the last one (end None) goes on to the end of the video."""
    if not isinstance(raw, list):
        return None
    out: List[Dict[str, Any]] = []
    last = 0.0
    for x in raw[:MAX_MUSIC_PARTS]:
        if not isinstance(x, dict):
            continue
        end = x.get("end")
        e = None if end is None else round(_num(end, 0.0, 0.0, 1e6), 3)
        if e is not None and e <= last + 0.02:
            continue
        part = {"end": e, "volume": round(_num(x.get("volume"), 1.0, 0.0, 2.0), 3), "mute": bool(x.get("mute"))}
        part.update(clean_shape(x))
        if x.get("even") == 0 and x.get("even") is not False:
            part["even"] = 0                   # Even out switched off here, also when the track has Auto level
        if re.fullmatch(r"g[0-9a-z]{1,10}", str(x.get("group") or "")):
            part["group"] = str(x["group"])
        out.append(part)
        if e is None:
            break
        last = e
    if out and out[-1]["end"] is not None:
        out.append({"end": None, "volume": 1.0, "mute": False})
    if all(abs(p["volume"] - 1.0) < 0.001 and not p["mute"] and len(p) == 3 for p in out) and len(out) <= 1:
        return None
    return out or None


def music_parts_spans(parts: Optional[List[Dict[str, Any]]], total: float) -> List[tuple]:
    """(start, end, gain) of the music parts that are not at full loudness, in finished-video time."""
    out, a = [], 0.0
    for p in parts or []:
        b = total if p["end"] is None else min(total, float(p["end"]))
        g = 0.0 if p["mute"] else float(p["volume"])
        if b > a and abs(g - 1.0) > 0.001:
            out.append((a, b, g))
        a = b
        if a >= total:
            break
    return out


def duck_spans(voice: List[tuple], total: float) -> List[tuple]:
    """Voice times (finished video) -> the stretches where the music goes down: a little before the voice, back up a
    little after it. Close ones are joined, so the music does not pump up and down between words."""
    out: List[List[float]] = []
    for a, b in sorted(voice):
        a, b = max(0.0, a - DUCK_DOWN), min(total, b + DUCK_UP)
        if b <= a:
            continue
        if out and a <= out[-1][1] + 0.3:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return [(a, b) for a, b in out]


def music_envelope(parts: Optional[List[Dict[str, Any]]], duck: Optional[Dict[str, Any]], voice: List[tuple], total: float) -> str:
    """FFmpeg filters (after the track's own loudness) for the music parts' loudness and for going down under voices."""
    chain = []
    for a, b, g in music_parts_spans(parts, total):
        # short slopes at the cuts (none at the very start or end), so a cut never clicks
        lo = f"(t-{a:.3f})/0.04" if a > 0.001 else "1"
        hi = f"({b:.3f}-t)/0.04" if b < total - 0.001 else "1"
        chain.append(f"volume='1+({g:.4f}-1)*clip(min({lo},{hi}),0,1)':eval=frame:enable='between(t,{a:.3f},{b:.3f})'")
    if duck and duck.get("on") and voice:
        low = float(duck.get("level", DUCK_LEVEL))
        for a, b in duck_spans(voice, total):
            # 1 at the edges, `low` inside; straight slopes of DUCK_DOWN / DUCK_UP seconds
            env = f"clip(min((t-{a:.3f})/{DUCK_DOWN:g},({b:.3f}-t)/{DUCK_UP:g}),0,1)"
            chain.append(f"volume='1-{1 - low:.4f}*{env}':eval=frame:enable='between(t,{a:.3f},{b:.3f})'")
    return ",".join(chain)


_VOICE_CACHE: Dict[tuple, List[List[float]]] = {}


def find_voice(path: str, offset: float = 0.0, stem: bool = True) -> List[List[float]]:
    """When someone talks, as [start, end] seconds (+ offset). On a split Voices track anything clearly above silence
    counts; on the plain sound only the voice band, clearly above the usual level (a guess: split first for the best result)."""
    import subprocess
    try:
        st_ = os.stat(path)
    except OSError:
        return []
    key = (path, st_.st_size, int(st_.st_mtime), stem, round(offset, 3))
    if key in _VOICE_CACHE:
        return _VOICE_CACHE[key]
    af = "aresample=8000" if stem else "highpass=f=250,lowpass=f=3400,aresample=8000"
    from .core.ffmpeg import get_tools
    raw = subprocess.run([get_tools().ffmpeg, "-nostdin", "-v", "error", "-i", path, "-map", "0:a:0", "-vn", "-ac", "1", "-af", af,
                          "-f", "s16le", "-"], capture_output=True, check=False).stdout
    step = 400                                            # 50 ms at 8 kHz
    n = len(raw) // 2 // step
    out: List[List[float]] = []
    if n:
        try:
            import numpy as np
            x = np.frombuffer(raw[: n * step * 2], dtype="<i2").astype(np.float64).reshape(n, step) / 32768.0
            db = 10 * np.log10(np.maximum(np.mean(x * x, axis=1), 1e-12))
            levels = sorted(float(v) for v in db)
        except ImportError:                               # the plain way (slower)
            import array
            a = array.array("h"); a.frombytes(raw[: n * step * 2])
            db = []
            for i in range(n):
                s2 = sum(v * v for v in a[i * step:(i + 1) * step]) / step / (32768.0 * 32768.0)
                db.append(10 * math.log10(max(s2, 1e-12)))
            levels = sorted(db)
        loud = levels[int(0.95 * (len(levels) - 1))]
        thr = max(-45.0, loud - 26.0) if stem else max(-42.0, levels[len(levels) // 2] + 8.0)
        on = [float(v) > thr for v in db]
        i = 0
        while i < n:
            if on[i]:
                j = i
                while j < n and on[j]:
                    j += 1
                a0, b0 = i * 0.05 + offset, j * 0.05 + offset
                if out and a0 - out[-1][1] < 0.35:
                    out[-1][1] = b0
                else:
                    out.append([a0, b0])
                i = j
            else:
                i += 1
        out = [[round(a, 3), round(b, 3)] for a, b in out if b - a >= 0.2]
    if len(_VOICE_CACHE) > 64:
        _VOICE_CACHE.clear()
    _VOICE_CACHE[key] = out
    return out


def voice_ranges(project: Dict[str, Any], src_path: str, media: Any = None, stems_home: Optional[str] = None,
                 planner: Any = None) -> List[List[float]]:
    """When someone talks in the video (source time): from the split Voices track (and what Separate again found),
    or a guess from the plain sound when the sound is not split."""
    sid = project["settings"].get("mix_split") or ""
    if sid:
        from .splitter import SplitStore
        info = SplitStore(stems_home).resolve(sid)
        if info and info["id"].split("/")[0] == source_identity(src_path)["fp"]:
            rs = find_voice(info["files"]["voices"], info["start"])
            for k in ("found", "found_voices"):
                if k in info["files"]:
                    rs = sorted(rs + find_voice(info["files"][k], info["start"]))
            return rs
    if media is not None and not media.has_audio:
        return []
    if planner is not None:
        planner.notes.append("Music goes down under voices: the sound is not split, so voices were guessed from the plain sound.")
    return find_voice(src_path, 0.0, stem=False)


def activity_ranges(project: Dict[str, Any], src_path: str, of: str, media: Any = None, stems_home: Optional[str] = None,
                    planner: Any = None) -> List[List[float]]:
    """When the Voices / Music / Effects track is heard (source time). Voices can be guessed without a split; the others need one."""
    if of == "voices":
        return voice_ranges(project, src_path, media, stems_home, planner)
    sid = project["settings"].get("mix_split") or ""
    if sid and of in MIX_LAYERS:
        from .splitter import SplitStore
        info = SplitStore(stems_home).resolve(sid)
        if info and info["id"].split("/")[0] == source_identity(src_path)["fp"]:
            return find_voice(info["files"][of], info["start"])
    if planner is not None:
        planner.notes.append(f"Going down under {of}: the sound is not split, so nothing goes down. Split the sound first.")
    return []


def duck_points(ranges: Sequence[Sequence[float]], level: float) -> List[List[float]]:
    """Going down as a loudness curve [[seconds, dB], ...] in the same clock as the ranges: gradually down before each
    stretch, back up after it."""
    db = max(-60.0, 20.0 * math.log10(max(level, 0.001)))
    pts: List[List[float]] = []
    for a, b in duck_spans([(float(x), float(y)) for x, y in ranges], 1e9):
        if b - a >= DUCK_DOWN + DUCK_UP:
            pts += [[a, 0.0], [a + DUCK_DOWN, db], [b - DUCK_UP, db], [b, 0.0]]
        else:
            pts += [[a, 0.0], [a + (b - a) * DUCK_DOWN / (DUCK_DOWN + DUCK_UP), db * (b - a) / (DUCK_DOWN + DUCK_UP)], [b, 0.0]]
    return pts


def _shape_of(sh: Dict[str, Any], env_path: Optional[str], offset: float, p: Dict[str, Any], cache: Optional[str],
              duck: Optional[List[List[float]]] = None) -> Optional[Dict[str, Any]]:
    from .analysis import evenout
    dpts = [list(x) for x in evenout.window(duck, p["start"] - 0.5, p["end"] + 0.5)] if duck else []
    if not (sh.get("even") or sh.get("fin") or sh.get("fout") or dpts):
        return None
    env: List[List[float]] = []
    if sh.get("even") and env_path:
        full = evenout.envelope(env_path, int(sh["even"]), cache)
        env = [list(x) for x in evenout.window(evenout.shifted(full, offset), p["start"] - 0.5, p["end"] + 0.5)]
    return {"env": env, "duck": dpts, "a": float(p["start"]), "b": float(p["end"]), "fin": float(sh.get("fin") or 0),
            "fout": float(sh.get("fout") or 0), "rev": bool(p.get("reverse"))}


def attach_shapes(live: List[Dict[str, Any]], groups: List[List[Any]], src_path: str, mix: Optional[Dict[str, Any]], cache: Optional[str],
                  ducks: Optional[Dict[str, List[List[float]]]] = None) -> None:
    """Even out, fades and going down of each section's own sound (the plain sound, or each split layer) go onto its segments.
    ``ducks``: for each split layer that goes down, its curve in source time."""
    for p, segs in zip(live, groups):
        shape: Dict[str, Dict[str, Any]] = {}
        if mix:
            for name in mix["files"]:
                sh = _shape_of((p.get("mix") or {}).get(name) or {}, mix["files"][name], float(mix["start"]), p, cache, (ducks or {}).get(name))
                if sh:
                    shape[name] = sh
        else:
            sh = _shape_of(p, src_path, 0.0, p, cache)
            if sh:
                shape["original"] = sh
        if shape:
            for seg in segs:
                seg.shape = shape


def music_shape(t: Dict[str, Any], total: float, cache: Optional[str]) -> str:
    """Filters (finished-video time) for a music track's Auto level / Even out and the gentle fades of its parts."""
    from .analysis import evenout
    chain: List[str] = []
    parts = t.get("parts") or [{"end": None, "volume": 1.0, "mute": False}]
    auto = int(t.get("auto") or 0)
    dur = None
    a = 0.0
    for q in parts:
        b = total if q.get("end") is None else min(total, float(q["end"]))
        if b <= a:
            continue
        s = q.get("even", auto)
        if s:
            if dur is None:
                dur = float(probe_media(t["path"]).duration or 0)
            if dur > 0.5:
                env = evenout.envelope(t["path"], int(s), cache)
                skip = float(t.get("start") or 0.0)                  # the song starts this far into its file
                k = int((a + skip) // dur)
                while k * dur - skip < b and env:
                    lo, hi = max(a, k * dur - skip), min(b, (k + 1) * dur - skip)   # the song plays again from its start when it ends
                    chain += evenout.filters(evenout.shifted(env, k * dur - skip), lo, hi)
                    k += 1
        fin, fout = float(q.get("fin") or 0), float(q.get("fout") or 0)
        if fin:
            chain.append(f"volume='clip((t-{a:.3f})/{fin:.3f},0,1)':eval=frame:enable='between(t,{a:.3f},{a + fin:.3f})'")
        if fout:
            chain.append(f"volume='clip(({b:.3f}-t)/{fout:.3f},0,1)':eval=frame:enable='between(t,{b - fout:.3f},{b:.3f})'")
        a = b
        if a >= total:
            break
    return ",".join(chain)


def map_ranges(ranges: Sequence[Sequence[float]], segs: Sequence[Any], fps: float) -> List[tuple]:
    """Source-time ranges -> finished-video time, through every section that plays them (moved, repeated, faster ...)."""
    out = []
    for seg in segs:
        if getattr(seg, "kind", "clip") != "clip" or getattr(seg, "mute", False):
            continue
        s0 = seg.src_start_f / fps
        s1 = (seg.src_start_f + seg.src_len_f) / fps
        o0, sp = seg.out_start / fps, float(seg.speed or 1.0)
        for a, b in ranges:
            x0, x1 = max(a, s0), min(b, s1)
            if x1 - x0 < 0.02:
                continue
            if getattr(seg, "reverse", False):
                out.append((o0 + (s1 - x1) / sp, o0 + (s1 - x0) / sp))
            else:
                out.append((o0 + (x0 - s0) / sp, o0 + (x1 - s0) / sp))
    return sorted(out)


def clean_frame(raw: Any) -> Dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    d = DEFAULT_FRAME
    m_raw = raw.get("mask") if isinstance(raw.get("mask"), dict) else {}
    dm = d["mask"]
    return {"ratio": raw.get("ratio") if raw.get("ratio") in FRAME_RATIOS else "original",
            "bg": raw.get("bg") if raw.get("bg") in FRAME_BGS else d["bg"],
            "blur": round(_num(raw.get("blur"), d["blur"], 0.0, 100.0), 1),
            "scale": round(_num(raw.get("scale"), 1.0, 0.1, 4.0), 3),
            "x": round(_num(raw.get("x"), 0.0, -2.0, 2.0), 4), "y": round(_num(raw.get("y"), 0.0, -2.0, 2.0), 4),
            "rotate": round(_num(raw.get("rotate"), 0.0, -180.0, 180.0), 2),
            "edge": round(_num(raw.get("edge"), 0.0, 0.0, 100.0), 1),     # soft edges of the video layer itself
            "mask": {"shape": m_raw.get("shape") if m_raw.get("shape") in MASK_SHAPES else "none",
                     "x": round(_num(m_raw.get("x"), dm["x"], 0.0, 1.0), 4), "y": round(_num(m_raw.get("y"), dm["y"], 0.0, 1.0), 4),
                     "w": round(_num(m_raw.get("w"), dm["w"], 0.02, 2.0), 4), "h": round(_num(m_raw.get("h"), dm["h"], 0.02, 2.0), 4),
                     "feather": round(_num(m_raw.get("feather"), dm["feather"], 0.0, 100.0), 1), "invert": bool(m_raw.get("invert")),
                     "rot": round(_num(m_raw.get("rot"), 0.0, -180.0, 180.0), 2)}}


def frame_active(fr: Optional[Dict[str, Any]]) -> bool:
    """True when the frame changes anything (a new shape, a moved or scaled picture, or a mask)."""
    if not fr:
        return False
    return (fr["ratio"] != "original" or abs(fr["scale"] - 1) > 1e-3 or abs(fr["x"]) > 1e-4 or abs(fr["y"]) > 1e-4
            or abs(fr["rotate"]) > 1e-3 or fr["mask"]["shape"] != "none" or fr.get("edge", 0) > 0.5)


def frame_size(fr: Dict[str, Any], width: int, height: int, preview: bool, long_side: Optional[int] = None) -> tuple:
    """Canvas size: the long side is the export size (4K ...), or as long as the video's long side (854 in a quick preview)."""
    r = FRAME_RATIOS[fr["ratio"]]
    a = r[0] / r[1] if r else width / max(1, height)
    long = 854 if preview else (long_side or max(width, height))
    w, h = (long, long / a) if a >= 1 else (long * a, long)
    return max(2, int(round(w / 2)) * 2), max(2, int(round(h / 2)) * 2)


def clean_project(raw: Any, duration: float) -> Dict[str, Any]:
    """Validate a project that came from the page. Bad pieces are dropped; bad values fall back to defaults."""
    if not isinstance(raw, dict):
        raise EditForgeError("That project could not be read.", "Reload the page and try again.")
    pieces_raw = raw.get("pieces") if isinstance(raw.get("pieces"), list) else []
    if len(pieces_raw) > MAX_PIECES:
        raise EditForgeError(f"A project can have at most {MAX_PIECES:,} pieces.", "Slice into longer pieces, or work on a shorter clip.")
    pieces = [p for p in (clean_piece(x, duration) for x in pieces_raw) if p is not None]
    name = " ".join(str(raw.get("name") or "").split())[:80] or "My project"
    steps: List[Dict[str, Any]] = []
    for st in (raw.get("steps") if isinstance(raw.get("steps"), list) else [])[:MAX_STEPS]:
        if not isinstance(st, dict) or not isinstance(st.get("pieces"), list) or len(st["pieces"]) > MAX_PIECES:
            continue
        sp = [p for p in (clean_piece(x, duration) for x in st["pieces"]) if p is not None]
        steps.append({"pieces": sp, "rule": clean_rule(st.get("rule")), "length": round(step_length(sp), 3)})
    out = {"name": name, "source": str(raw.get("source") or "")[:300], "pieces": pieces, "settings": clean_settings(raw.get("settings")),
           "texts": clean_texts(raw.get("texts")), "steps": steps, "rule": clean_rule(raw.get("rule"))}
    out.update(clean_meta(raw))
    return out


STAGES = ("edit", "final")
_PARENT = re.compile(r"^[0-9a-f]{12}$")
META_KEYS = ("stage", "parent", "version", "task", "task_done")     # task: work the app does for it in the background


def clean_meta(raw: Any) -> Dict[str, str]:
    """Where a project belongs in the work: its stage (edit or final), the project it was made from, and which version of it."""
    if not isinstance(raw, dict):
        return {}
    out: Dict[str, str] = {}
    if raw.get("stage") in STAGES:
        out["stage"] = raw["stage"]
    if _PARENT.match(str(raw.get("parent") or "")):
        out["parent"] = str(raw["parent"])
    version = " ".join(str(raw.get("version") or "").split())[:24]
    if version:
        out["version"] = version
    return out


# ------------------------------------------------------------------ steps: stacked patterns on the same parent video
# A step is a list of pieces. Every piece is only a note "from this second to that second of the PARENT video",
# so nothing is rendered between steps: pinning a step lays its pieces end to end, and the next step cuts that
# into new pieces again. Extending a piece in any step therefore grows into the real footage of the parent,
# also footage an earlier step removed. Export cuts the last step's pieces from the parent once.
MAX_STEPS = 30
SNAP = 0.08          # a new cut closer than this to the edge of a pinned piece goes onto that edge (no slivers)


def clean_rule(raw: Any) -> Optional[Dict[str, Any]]:
    """How a step was made: piece length, and the pattern applied (to show it, and to repeat it on another video)."""
    if not isinstance(raw, dict):
        return None
    try:
        interval = round(_num(raw.get("interval"), 0.0, 0.0, 3600.0), 3)
        group = max(1, min(100, int(raw.get("group") or 1)))
        picks = sorted({int(x) for x in raw.get("picks") or [] if 1 <= int(x) <= group})
    except (TypeError, ValueError):
        return None
    action = raw.get("action") if raw.get("action") in ("remove", "keep") else ""
    out = {"interval": interval, "group": group, "picks": picks if action else [], "action": action, "hand": bool(raw.get("hand"))}
    if raw.get("scenes"):
        out["scenes"] = True                     # the sections are scenes (Separate scenes): the page chooses whole scenes
    if raw.get("thin") or (interval == THIN_SECTION and group == THIN_EVERY and action == "remove"):
        out["thin"] = True                       # 'Remove every 4th second' was done (kept when scenes are separated after it)
    return out


def step_flags(d: Dict[str, Any]) -> Dict[str, bool]:
    """Which Edit steps were already done on a version (so they are not done twice by mistake)."""
    rules = [st.get("rule") for st in d.get("steps") or [] if isinstance(st, dict)] + [d.get("rule")]
    rules = [r for r in rules if isinstance(r, dict)]
    thin = any(r.get("thin") or (r.get("interval") == THIN_SECTION and r.get("group") == THIN_EVERY and r.get("action") == "remove") for r in rules)
    cur = d.get("rule") if isinstance(d.get("rule"), dict) else {}
    return {"versions": bool(d.get("version")), "thin": thin, "scenes": bool(cur.get("scenes"))}


def out_len(p: Dict[str, Any]) -> float:
    return (p["end"] - p["start"]) / (p.get("speed") or 1.0)


def step_length(pieces: Sequence[Dict[str, Any]]) -> float:
    """Length of a step as it plays (removed pieces do not count)."""
    return sum(out_len(p) for p in pieces if not p.get("off"))


def recut(pieces: Sequence[Dict[str, Any]], interval: float) -> List[Dict[str, Any]]:
    """Cut the kept pieces, laid end to end, into new pieces of ``interval`` seconds (of playing time).

    Each result is again a range of the parent video. A new piece that spans the join of two old pieces
    becomes two parts with the same ``unit`` number, so patterns count it as ONE piece.
    Everything else of the old piece (speed, backwards, effects, colour ...) is kept.
    """
    if interval < 0.1:
        raise EditForgeError("Pieces must be at least 0.1 seconds long.", "Choose a longer time, for example 2 seconds.")
    kept = [p for p in pieces if not p.get("off")]
    total = sum(out_len(p) for p in kept)
    n = int(math.floor(total / interval + 1e-9))
    cuts = [k * interval for k in range(1, n + 1) if total - k * interval >= SNAP]
    if len(cuts) + 1 > MAX_PIECES:
        raise EditForgeError(f"That would make {len(cuts) + 1:,} pieces (the most is {MAX_PIECES:,}).", "Choose a longer time for each piece.")
    out: List[Dict[str, Any]] = []
    o0 = 0.0
    for p in kept:
        o1 = o0 + out_len(p)
        pts = [o0] + [c for c in cuts if o0 + SNAP < c < o1 - SNAP] + [o1]
        sp = p.get("speed") or 1.0
        for a, b in zip(pts, pts[1:]):
            if p.get("reverse"):
                s0, s1 = p["end"] - (b - o0) * sp, p["end"] - (a - o0) * sp
            else:
                s0, s1 = p["start"] + (a - o0) * sp, p["start"] + (b - o0) * sp
            q = dict(p, start=round(max(p["start"], s0), 4), end=round(min(p["end"], s1), 4), off=False)
            q["unit"] = sum(1 for c in cuts if c <= a + SNAP)
            if q["end"] - q["start"] >= MIN_PIECE_SECONDS:
                out.append(q)
        o0 = o1
    return out


def units(pieces: Sequence[Dict[str, Any]]) -> List[int]:
    """The pattern number of each piece: pieces next to each other with the same unit count as one."""
    out: List[int] = []
    n, prev = -1, None
    for p in pieces:
        u = p.get("unit")
        if u is None or u != prev:
            n += 1
        out.append(n)
        prev = u
    return out


def apply_pattern(pieces: List[Dict[str, Any]], group: int, picks: Sequence[int], action: str) -> List[Dict[str, Any]]:
    """Remove (or keep only) the picked pieces of every group, counted on the kept pieces from left to right."""
    kept = [p for p in pieces if not p.get("off")]
    want = set(picks)
    for p, u in zip(kept, units(kept)):
        hit = (u % group) + 1 in want
        if (action == "remove" and hit) or (action == "keep" and not hit):
            p["off"] = True
    return pieces


def extend_limits(pieces: Sequence[Dict[str, Any]], index: int, duration: float) -> tuple:
    """How far piece ``index`` may grow: (earliest start, latest end) in parent time.

    It may grow into any footage that no other kept piece of the same step uses (also footage an earlier
    step removed), and stops at the neighbour. Pieces that already overlap it (a copy) do not stop it.
    """
    p = pieces[index]
    lo, hi = 0.0, float(duration)
    for k, q in enumerate(pieces):
        if k == index or q.get("off"):
            continue
        if q["start"] >= p["end"] - 1e-6:
            hi = min(hi, q["start"])
        elif q["end"] <= p["start"] + 1e-6:
            lo = max(lo, q["end"])
    return lo, hi


def slice_pieces(duration: float, interval: float) -> List[Dict[str, Any]]:
    """Cut 0..duration into pieces of ``interval`` seconds (a last piece shorter than 2 frames joins the one before)."""
    if interval < 0.1:
        raise EditForgeError("Pieces must be at least 0.1 seconds long.", "Choose a longer time, for example 2 seconds.")
    n = max(1, int(math.ceil(duration / interval - 1e-9)))
    if n > MAX_PIECES:
        raise EditForgeError(f"That would make {n:,} pieces (the most is {MAX_PIECES:,}).", "Choose a longer time for each piece.")
    edges = [round(min(duration, i * interval), 4) for i in range(n)] + [round(duration, 4)]
    if len(edges) > 2 and edges[-1] - edges[-2] < 0.08:
        edges.pop(-2)
    return [p for p in (clean_piece({"start": a, "end": b}, duration) for a, b in zip(edges, edges[1:])) if p]


def slice_at(duration: float, times: List[float]) -> List[Dict[str, Any]]:
    """Cut 0..duration at the given times (used for cutting on music beats)."""
    edges = [0.0]
    for t in sorted(float(x) for x in times):
        if 0.08 <= t - edges[-1] and duration - t >= 0.08:
            edges.append(round(t, 4))
    edges.append(round(duration, 4))
    if len(edges) - 1 > MAX_PIECES:
        raise EditForgeError(f"That would make more than {MAX_PIECES:,} pieces.", "Cut on every 2nd or 4th beat instead.")
    return [p for p in (clean_piece({"start": a, "end": b}, duration) for a, b in zip(edges, edges[1:])) if p]


# ------------------------------------------------------------------ Edit stage: the three buttons
SECTION = 2.0          # button 1: seconds in a section
THIN_EVERY = 4         # button 2: remove every 4th section ...
THIN_SECTION = 1.0     # ... of one second


def _plain(p: Dict[str, Any]) -> Dict[str, Any]:
    q = {k: v for k, v in p.items() if k != "unit"}
    q["off"] = False
    return q


def odd_even(pieces: Sequence[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Button 1: cut the video into 2 s sections, and make two versions: the odd sections (1, 3, 5 ...) and the even ones
    (2, 4, 6 ...). Nothing is rendered: each section is only a note 'from here to there' of the clip, so a section can
    still be extended into the gap the other version uses."""
    sections = recut(pieces, SECTION)
    num = units(sections)
    odd = [_plain(p) for p, k in zip(sections, num) if k % 2 == 0]
    even = [_plain(p) for p, k in zip(sections, num) if k % 2 == 1]
    if not even:
        raise EditForgeError("This clip is too short for two versions.", "Use a clip that is longer than 2 seconds.")
    return odd, even


def thin_pieces(pieces: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Button 2: cut the version (as one new video) into 1 s sections and take out every 4th: 1 2 3 [4] 5 6 7 [8] ...
    The taken-out sections stay in the list as removed, so they can be put back."""
    out = recut(pieces, THIN_SECTION)
    return apply_pattern(out, THIN_EVERY, [THIN_EVERY], "remove")


class _ProjectPlanner(Planner):
    """Reuses the planner's frame maths, reverse chunking, layout and face tracking for a list of pieces."""

    def piece_segments(self, piece: Dict[str, Any], reframe: Optional[ReframeSpec], silent: bool,
                       follow_path: Optional[List[follow_mod.Point]] = None) -> List[Segment]:
        a = max(0, min(self.D_f, self.fr(piece["start"])))
        b = max(0, min(self.D_f, self.fr(piece["end"])))
        if b <= a:
            return []
        seg = Segment("clip", a, b - a, max(1, int(round((b - a) / piece["speed"]))))
        seg.mute = bool(piece["mute"]) or silent
        seg.volume = float(piece["volume"])
        if piece.get("place"):
            seg.place = dict(piece["place"])
        if piece.get("mix"):
            seg.layer_gain = piece_layer_gain(piece)
        if self.has_video:
            seg.effects = [EffectSpec(name, 0.5) for name in piece["fx"]]
            zoom, amount = piece["zoom"]["mode"], float(piece["zoom"]["amount"])
            if follow_path and reframe is None:
                # Follow: a zoomed view that glides after the subject. Flips happen before the camera, so they flip the path too.
                z = float(piece["follow"]["zoom"])
                fx, fy = "hflip" in piece["fx"], ("vflip" in piece["fx"]) != ("flip" in piece["fx"])
                pts = [(t, follow_mod.view_position(1.0 - x if fx else x, z), follow_mod.view_position(1.0 - y if fy else y, z))
                       for t, x, y in follow_mod.window(follow_path, a / self.F - 0.1, b / self.F + 0.1)]
                seg.camera = CameraSpec(z, z, 0.5, 0.5, 0.5, 0.5, "linear", a / self.F, b / self.F, False, pts)
            elif zoom != "none" and amount > 1.0:
                z0, z1 = {"in": (1.0, amount), "out": (amount, 1.0), "hold": (amount, amount)}[zoom]
                seg.camera = CameraSpec(z0, z1, 0.5, 0.5, 0.5, 0.5, "ease_in_out", a / self.F, b / self.F)
            c = piece["color"]
            if (c["brightness"], c["contrast"], c["saturation"]) != (0.0, 1.0, 1.0):
                seg.color = ColorSpec(c["brightness"], c["contrast"], c["saturation"])
            if reframe is not None:
                seg.reframe = ReframeSpec(reframe.aspect, reframe.mode, reframe.smooth)
        if not piece["reverse"]:
            return [seg]
        chunk = self._chunk_frames()          # reversing holds frames in memory, so it is done in small chunks
        n = max(1, int(math.ceil(seg.frames / chunk)))      # equal chunks, so none is too short for a transition
        parts = self._split_many(seg, [seg.frames * i // n for i in range(1, n)])
        for p in parts:
            p.reverse = True
            if p.reframe is not None:
                p.reframe = ReframeSpec(reframe.aspect, reframe.mode, reframe.smooth)
        return list(reversed(parts))

    def join(self, a: Segment, b: Segment, kind: str, seconds: float) -> bool:
        """Put a transition between two neighbouring segments (same rules as the script planner)."""
        want = max(2, self.fr(seconds))
        d = min(want, min(a.frames, b.frames) // 2, a.frames - a.head - 1, b.frames - b.tail - 1)
        if d < 2:
            return False
        j = JoinSpec(kind, d)
        a.join_out, b.join_in = j, j
        return True


def remap_words(words: Sequence[Word], segments: Sequence[Segment], fps: float) -> List[tuple]:
    """Move spoken words from source time to finished-video time, piece by piece, in playing order.

    Unlike the script planner's version this handles pieces that were moved or repeated: a word is shown
    every time its piece plays. Backwards and muted pieces have no readable speech, so they get no words.
    """
    ordered = sorted(words, key=lambda w: w.start)
    out: List[tuple] = []
    for seg in segments:
        if seg.kind != "clip" or seg.reverse or seg.mute:
            continue
        s0, s1 = seg.src_start_f / fps, (seg.src_start_f + seg.src_len_f) / fps
        for w in ordered:
            if w.start >= s1:
                break
            lo, hi = max(w.start, s0), min(w.end, s1)
            if hi > lo and (hi - lo) >= 0.4 * max(w.end - w.start, 1e-6):
                o0 = seg.out_start / fps + (lo - s0) / seg.speed
                o1 = seg.out_start / fps + (hi - s0) / seg.speed
                out.append((w.text, o0, max(o1, o0 + 0.02)))
    out.sort(key=lambda x: x[1])
    fixed: List[tuple] = []
    for text, a, b in out:                       # words must not overlap in time
        if fixed and a < fixed[-1][2]:
            pt, pa, pb = fixed[-1]
            fixed[-1] = (pt, pa, max(pa + 0.02, min(pb, a)))
        fixed.append((text, a, max(b, a + 0.02)))
    return fixed


def _solo_any(st: Dict[str, Any], layers: Optional[Sequence[Dict[str, Any]]] = None) -> bool:
    """Is anything soloed? (then only the soloed things are heard)"""
    return bool(st["solo"]) or any(x.get("solo") for x in (layers if layers is not None else st["layers"]))


def _layer_mix(st: Dict[str, Any], live: List[Dict[str, Any]], src_path: str, planner: Any,
               stems_home: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """The sound-layer mix (see splitter.py) when the person changed a layer's loudness, else None (= the original sound)."""
    gains = {layer: float(st["mix_" + layer]) for layer in STEM_KEYS}
    for layer in STEM_KEYS:
        if layer in st["mute"] or (_solo_any(st) and layer not in st["solo"]):
            gains[layer] = 0.0
    own = any(piece_layer_gain(p) or any(clean_shape(v) for v in (p.get("mix") or {}).values()) for p in live)   # own loudness / even out / fades
    if not st["mix_split"] or (all(abs(g - 1.0) < 0.001 for g in gains.values()) and not own and not st.get("ducks")):
        return None
    from .splitter import SplitStore
    info = SplitStore(stems_home).resolve(st["mix_split"])
    if not info or info["id"].split("/")[0] != source_identity(src_path)["fp"]:
        planner.warn("The split sound for this video was not found (it may have been cleaned up), so the original sound is used. "
                     "Open Sound and press Split.")
        return None
    lo, hi = min(p["start"] for p in live), max(p["end"] for p in live)
    if lo < info["start"] - 0.05 or hi > info["end"] + 0.05:
        raise ScriptError("Part of your video lies outside the part whose sound was split.",
                          "Open Sound and press 'Split again' so the whole part you use is covered.")
    for k in STEM_KEYS:
        if k not in info["files"]:
            gains.pop(k, None)
    return {"id": info["id"], "start": info["start"], "end": info["end"], "files": info["files"], "gain": gains}


def plan_project(project: Dict[str, Any], src_path: str, *, music_path: Optional[str] = None, layers: Optional[Sequence[Dict[str, Any]]] = None,
                 captions_path: Optional[str] = None,
                 preview: bool = False,
                 output_path: Optional[str] = None, cancel: Optional[threading.Event] = None,
                 log: Optional[Callable[[str], None]] = None, stems_home: Optional[str] = None) -> Plan:
    """Turn a project into a render :class:`Plan`.

    ``project`` must already be cleaned with :func:`clean_project`. ``music_path`` is the real path of the
    music file and ``layers`` the real paths of the extra music layers ([{"path", "volume", "mute", "solo"}]); the page only knows file ids. ``preview=True`` gives a small, fast 480p version.
    """
    media: MediaInfo = probe_media(src_path)
    st = project["settings"]
    live = [p for p in project["pieces"] if not p["off"]]
    if not live:
        raise ScriptError("Every piece is removed, so there would be no video left.", "Put at least one piece back.")
    frame = st.get("frame") if media.has_video else None
    if media.has_video and not frame and any(p.get("place") for p in live):
        frame = clean_frame({})                                # a piece placed on its own needs the frame's layers
    preset, aspect, follow, fit = SHAPES["original" if frame else st["shape"]]
    crf, x264 = QUALITIES[st["quality"]]
    notes: List[str] = list(media.warnings)
    out = resolve_output(media, preset=preset, fit=fit, quality=f"crf:{crf}", preview=preview, notes=notes)
    if not preview:
        out.x264_preset = x264
    long_side = EXPORT_SIZES.get(st.get("export_size") or "4k")
    if frame and out.has_video:                                # the Frame panel: its own canvas, layers and mask
        out.width, out.height = frame_size(frame, media.width, media.height, preview, long_side)
        out.fit, out.frame = "frame", dict(frame)
    elif out.has_video and not preview and long_side and max(out.width, out.height) != long_side:
        k = long_side / max(out.width, out.height)            # the chosen export size, same shape
        out.width, out.height = max(2, int(round(out.width * k / 2)) * 2), max(2, int(round(out.height * k / 2)) * 2)
    elif preview and preset != "original" and out.has_video:      # keep the chosen shape in the small preview
        full = resolve_output(media, preset=preset, fit=fit)
        out.height = 480 if full.height <= full.width else 854
        out.width = int(round(out.height * full.width / full.height / 2)) * 2
        out.fit = full.fit
    if not out.has_video:
        from fractions import Fraction
        out.fps = Fraction(100)
    analyzer = Analyzer(media, None, cancel, log)
    planner = _ProjectPlanner(load_script(""), media, analyzer, out, FileResolver(), face_provider=make_face_provider(analyzer))
    reframe = ReframeSpec(aspect, "face" if follow else "center") if aspect and planner.has_video else None
    layers = list(layers or [])
    solo = _solo_any(st, layers)
    # the video's own sound is silent when switched off, muted, or when something else is soloed
    silent = (not st["original_sound"] or "original" in st["mute"] or (solo and "original" not in st["solo"] and not st["mix_split"])
              or (solo and bool(st["mix_split"]) and not (set(st["solo"]) & set(STEM_KEYS))))
    face_path: List[follow_mod.Point] = []
    wants_face = [p for p in live if p["follow"]["mode"] == "face"]
    if wants_face and planner.has_video and reframe is None:
        if planner.face_provider is None:
            raise FeatureUnavailable("Following faces is switched off because the free 'opencv-python-headless' add-on is not installed.",
                                     "Install it with:  pip install 'opencv-python-headless<5'   -- or switch off 'Follow' for those pieces.")
        face_path = follow_mod.face_points(analyzer.faces(min(p["start"] for p in wants_face), max(p["end"] for p in wants_face), 640))
        if not face_path:
            planner.warn("No faces were found, so the pieces set to follow a face are shown without following.")
    if reframe is not None and any(p["follow"]["mode"] != "none" for p in live):
        planner.warn("'Follow' on single pieces only works with the original shape, so it was left out. "
                     "For a tall or square video choose a 'follow faces' shape instead.")

    def path_for(p: Dict[str, Any]) -> Optional[List[follow_mod.Point]]:
        if p["follow"]["mode"] == "face":
            return face_path or None
        if p["follow"]["mode"] == "object":
            return [tuple(pt) for pt in p["follow"]["path"]]
        return None

    pairs = [(p, planner.piece_segments(p, reframe, silent, path_for(p))) for p in live]
    groups = [g for _, g in pairs if g]
    if not groups:
        raise ScriptError("The pieces that are left are empty.", "Put a piece back, or make a piece longer.")
    if st["transition"] != "none" and planner.has_video:
        made = sum(1 for g1, g2 in zip(groups, groups[1:]) if planner.join(g1[-1], g2[0], st["transition"], st["transition_s"]))
        skipped = len(groups) - 1 - made
        planner.notes.append(f"Added {made} transition(s) between pieces.")
        if skipped:
            planner.warn(f"{skipped} transition(s) were skipped because a piece is too short for one.")
    planner.segs = [s for g in groups for s in g]
    planner._layout()
    planner._resolve_reframes()
    if planner.total < 1:
        raise ScriptError("The finished video would be empty.", "Put a piece back, or make a piece longer.")
    audio = AudioSpec()
    tracks = ([{"path": music_path, "volume": float(st["music_volume"]), "mute": False, "solo": False}] if music_path else []) + layers
    act_out: Dict[str, List[tuple]] = {}                 # when each track is heard, in finished-video time
    cache = str(Path(stems_home) / "thumbs") if stems_home else None
    for t in tracks:
        if t.get("mute") or (solo and not t.get("solo")):
            continue
        if not probe_media(t["path"]).has_audio:
            raise ScriptError("A music file has no sound.", "Choose an audio file (mp3, wav, m4a ...).")
        # the music's loudness is whatever you set: the track, its parts, and (when switched on) lower while people talk
        fi = t.get("fade_in")
        fo = t.get("fade_out")
        m = MusicSpec(t["path"], float(t["volume"]), False, 0.0, None, True, 0.5 if fi is None else float(fi), 1.5 if fo is None else float(fo))
        m.skip = float(t.get("start") or 0.0)
        duck = t.get("duck") if isinstance(t.get("duck"), dict) and t["duck"].get("on") else None
        under = (duck or {}).get("under") or "voices"
        if duck and under not in act_out:
            act_out[under] = map_ranges(activity_ranges(project, src_path, under, media, stems_home, planner), planner.segs, float(planner.F))
        total_s = planner.total / float(planner.F)
        m.extra = ",".join(x for x in (music_shape(t, total_s, cache), music_envelope(t.get("parts"), duck, act_out.get(under) or [], total_s)) if x)
        audio.music.append(m)
    if audio.music or (media.has_audio and not silent):
        audio.loudnorm = dict(FINAL_LOUDNESS)             # always last, on the whole mix (video sound + every music layer)
    if media.has_audio and not silent:
        if st["noise"] != "off":
            audio.denoise = {"amount": NOISE_LEVELS[st["noise"]], "highpass": True}
        vocals = st["vocals"]
        if vocals != "keep" and media.channels < 2:
            planner.warn("Removing or keeping only voices needs stereo sound, and this video's sound is mono, so it was left as it is.")
            vocals = "keep"
        audio.mix = _layer_mix(st, live, src_path, planner, stems_home)
        voice = {"vocals": vocals, "boost": st["voice_boost"], "compress": st["compress"], "bass": st["bass"], "treble": st["treble"]}
        if vocals != "keep" or st["voice_boost"] or st["compress"] or abs(st["bass"]) >= 0.5 or abs(st["treble"]) >= 0.5:
            audio.voice = voice
    if media.has_audio and not silent:
        stem_ducks: Dict[str, List[List[float]]] = {}
        if audio.mix:
            for name, dk in (st.get("ducks") or {}).items():
                if name in audio.mix["files"]:
                    stem_ducks[name] = duck_points(activity_ranges(project, src_path, dk["under"], media, stems_home, planner), float(dk["level"]))
        attach_shapes([p for p, g in pairs if g], groups, src_path, audio.mix, cache, stem_ducks)
    audio.fade_in, audio.fade_out = float(st["fade_in"]), float(st["fade_out"])
    audio.fade_video = planner.has_video
    texts: List[TextOverlay] = []
    if planner.has_video and project.get("texts"):
        font = find_font(None)
        for t in project["texts"]:
            a = min(planner.total, planner.fr(t["start"]))
            b = planner.total if t["end"] <= 0 else min(planner.total, planner.fr(t["end"]))
            if b > a:
                texts.append(TextOverlay(t["text"], a, b, t["position"], None, None, TEXT_SIZES[t["size"]], TEXT_COLORS[t["color"]], font,
                                         bool(t["box"]), "#000000@0.5", 14.0, 0.0 if t["box"] else 3.0, "#000000", False, 0.0, 0))
            else:
                planner.warn(f"The text '{t['text'][:30]}' starts after the video ends, so it is not shown.")
    captions = None
    if st["captions"] != "off" and planner.has_video:
        if captions_path:
            words, source = import_transcript(captions_path), "subtitle file"
        elif not media.has_audio:
            raise ScriptError("Automatic captions need speech, but this video has no sound.", "Switch captions off, or add a subtitle file.")
        else:
            words, _ = analyzer.transcript("auto", "base", "auto")
            source = "speech recognition (Whisper)"
        lines = group_lines(remap_words(words, planner.segs, planner.F))
        if not lines:
            planner.warn("No speech was found in the pieces that are kept, so there are no captions.")
        else:
            captions = CaptionSpec("burn", st["caption_style"], CAPTION_SIZES[st["caption_size"]], "#ffffff", "#ffe600", "#000000",
                                   st["caption_position"], 70.0, None, False, lines, "", source, st.get("caption_height"))
            planner.notes.append(f"Captions: {len(lines)} line(s) from {source}.")
    tl = Timeline(planner.segs, out, media.path, planner.D, media.fps, planner.total, texts, [], audio, captions, "encode",
                  planner.warnings, planner.notes)
    out_path = output_path or default_output_path(src_path, out.container)
    return Plan(tl, media, planner.script, out_path, list(planner.warnings), notes + list(planner.notes), list(analyzer.notes),
                source_identity(src_path), analyzer, {"fast_cuts": False, "preview": preview})


def output_stem(project: Dict[str, Any], src_path: str, preview: bool) -> str:
    """A safe file name (without extension) for a project's finished video."""
    keep = "".join(ch if ch.isalnum() or ch in " -_()" else "_" for ch in project["name"]).strip(" .")[:60]
    return (keep or Path(src_path).stem[:60]) + ("_preview" if preview else "")
