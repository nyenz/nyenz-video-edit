"""Writes packaging/models.iss: the list of AI model files for the installer (made from editforge/modelpack.py).

Run it after changing the list:  python tools/make_models_iss.py     (a test fails when the file is out of date)
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from editforge import modelpack  # noqa: E402


def build() -> str:
    files = modelpack.FILES
    out = ["// Made by tools/make_models_iss.py from editforge/modelpack.py. Do not edit by hand.",
           f"function ModelCount(): Integer;\nbegin\n  Result := {len(files)};\nend;", ""]

    def case(name: str, kind: str, values: list) -> str:
        lines = [f"function {name}(I: Integer): {kind};", "begin", "  case I of"]
        for i, v in enumerate(values):
            lines.append(f"    {i}: Result := {v};")
        lines += ["  else", f"    Result := {'0' if kind == 'Int64' else chr(39) * 2};", "  end;", "end;", ""]
        return "\n".join(lines)

    q = lambda x: "'" + str(x).replace("'", "''") + "'"
    out.append(case("ModelUrl", "String", [q(f["url"]) for f in files]))
    out.append(case("ModelTempName", "String", [q(f"model{i}-{f['name']}") for i, f in enumerate(files)]))
    out.append(case("ModelDest", "String", [q(modelpack.relative_path(f)) for f in files]))
    out.append(case("ModelSha", "String", [q(f["sha256"]) for f in files]))
    out.append(case("ModelSize", "Int64", [str(f["size"]) for f in files]))
    return "\n".join(out)


def main() -> None:
    (ROOT / "packaging" / "models.iss").write_text(build(), encoding="utf-8", newline="\n")
    print("wrote packaging/models.iss")


if __name__ == "__main__":
    main()
