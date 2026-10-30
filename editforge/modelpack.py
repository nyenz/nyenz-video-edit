"""The AI model files that the installer downloads during setup, so nothing is downloaded later.

One list, used by the app (to find a model that setup already put in place) and by ``tools/make_models_iss.py`` (which writes
the part of the installer that downloads them). Every file has a size and a SHA-256 fingerprint; the installer checks both.

* **Sound splitting** (Voices, Music, Effects): one 76 MB file.
* **Captions** (Whisper base): four files, about 148 MB.
* The **scene finder** needs no model file (it looks at the pictures itself).
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Dict, List, Optional


RELEASES = "https://github.com/nyenz/nyenz-video-edit/releases/download/"
WHISPER_DIR = "whisper-base"                    # inside the models folder

# (folder inside the models folder, file name, download address, size in bytes, SHA-256)
FILES: List[Dict[str, object]] = [
    {"model": "sound", "dir": "", "name": "sound-split-1.onnx", "url": RELEASES + "sound-model-1/sound-split-1.onnx",     # same as editforge/splitter.py (a test checks)
     "size": 76080146, "sha256": "b43c4978c07667b2c6e6aed8c3c1ad5b263a96f8fbc8faead2cec45971646d4d"},
    {"model": "captions", "dir": WHISPER_DIR, "name": "config.json", "url": RELEASES + "caption-model-1/whisper-base-config.json",
     "size": 2309, "sha256": "56a6d8110d311f19c8f0471e562832c7527f146b567275bfca59fcf7c184da9a"},
    {"model": "captions", "dir": WHISPER_DIR, "name": "model.bin", "url": RELEASES + "caption-model-1/whisper-base-model.bin",
     "size": 145217532, "sha256": "d01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9"},
    {"model": "captions", "dir": WHISPER_DIR, "name": "tokenizer.json", "url": RELEASES + "caption-model-1/whisper-base-tokenizer.json",
     "size": 2203239, "sha256": "fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab"},
    {"model": "captions", "dir": WHISPER_DIR, "name": "vocabulary.txt", "url": RELEASES + "caption-model-1/whisper-base-vocabulary.txt",
     "size": 459861, "sha256": "34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913"},
]


def relative_path(f: Dict[str, object]) -> str:
    """Where the file goes, under the app's folder (``~/.editforge``), with backslashes for the installer."""
    parts = ["models"] + ([str(f["dir"])] if f["dir"] else []) + [str(f["name"])]
    return "\\".join(parts)


def _intact(path: Path, size: int, sha256: Optional[str] = None) -> bool:
    try:
        if not path.is_file() or path.stat().st_size != size:
            return False
        if sha256 is None:
            return True
        h = hashlib.sha256()
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest() == sha256
    except OSError:
        return False


def local_whisper(home: Optional[Path] = None) -> Optional[str]:
    """The folder with the captions model that setup downloaded, when every file is there with the right size; else None."""
    from . import splitter
    base = splitter.models_dir(home) / WHISPER_DIR
    files = [f for f in FILES if f["model"] == "captions"]
    if all(_intact(base / str(f["name"]), int(f["size"])) for f in files):          # the size is enough here; setup checked the fingerprint
        return str(base)
    return None
