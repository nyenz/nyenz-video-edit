"""Write packaging/version_info.txt: the name, maker and version Windows shows for NyenzEdit.exe
(Properties > Details, Task Manager, the Apps list). PyInstaller reads it when it builds the program."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from editforge.version import __version__  # noqa: E402

nums = [int(x) for x in __version__.split(".")[:3]] + [0]
tup = tuple((nums + [0, 0, 0, 0])[:4])
TEXT = f'''VSVersionInfo(
  ffi=FixedFileInfo(filevers={tup}, prodvers={tup}, mask=0x3f, flags=0x0, OS=0x40004, fileType=0x1, subtype=0x0, date=(0, 0)),
  kids=[
    StringFileInfo([StringTable("040904B0", [
      StringStruct("CompanyName", "Nyenz"),
      StringStruct("FileDescription", "Nyenz Edit"),
      StringStruct("FileVersion", "{__version__}"),
      StringStruct("InternalName", "NyenzEdit"),
      StringStruct("LegalCopyright", "MIT License"),
      StringStruct("OriginalFilename", "NyenzEdit.exe"),
      StringStruct("ProductName", "Nyenz Edit"),
      StringStruct("ProductVersion", "{__version__}")])]),
    VarFileInfo([VarStruct("Translation", [1033, 1200])])
  ]
)
'''
out = Path(__file__).resolve().parent.parent / "packaging" / "version_info.txt"
out.write_text(TEXT, encoding="utf-8")
print("wrote", out)
