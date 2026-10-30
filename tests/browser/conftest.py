"""Real-browser tests: the real server, real FFmpeg and a headless Chromium driving the pages like a person.

They need Playwright with its Chromium. Where that is missing (for example the normal test run on GitHub) they are skipped.
Run them with:  python -m pytest tests/browser -q
"""

from __future__ import annotations

import json
import threading
import urllib.parse
import urllib.request
from pathlib import Path

import pytest

try:                                                    # without Playwright (for example on GitHub) these tests are not even collected
    import playwright.sync_api  # noqa: F401
except ImportError:
    collect_ignore_glob = ["test_*.py"]

from editforge.web.server import make_server  # noqa: E402


class Live:
    """A running server plus small helpers to talk to it."""

    def __init__(self, port: int, token: str, state):
        self.port, self.token, self.state = port, token, state
        self.base = f"http://127.0.0.1:{port}"

    def call(self, method: str, path: str, body=None):
        data, headers = None, {"X-EditForge-Token": self.token}
        if isinstance(body, (bytes, bytearray)):
            data = bytes(body)
        elif body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read() or b"{}")

    def upload(self, path: str) -> str:
        return self.call("POST", "/api/upload?name=" + urllib.parse.quote(Path(path).name), Path(path).read_bytes())["id"]


@pytest.fixture(scope="session")
def live(tmp_path_factory, private_home):
    home = tmp_path_factory.mktemp("browser_home")
    srv, state = make_server("127.0.0.1", 0, home=home)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield Live(state.port, state.token, state)
    state.manager.shutdown()
    state.previews.shutdown()
    srv.shutdown()
    srv.server_close()


@pytest.fixture(scope="session")
def movie(tmp_path_factory):
    """A 3-minute movie with a hard scene change every 20 seconds, so marks and scenes can be checked exactly.

    It is VP9/Opus in WebM because the test browser (Chromium from Playwright) cannot play H.264; the real app's browser can.
    """
    from tools.make_samples import run
    d = tmp_path_factory.mktemp("browser_media")
    out = d / "movie.webm"
    colors = ["red", "green", "blue", "yellow", "magenta", "cyan", "orange", "purple", "white"]
    parts = []
    for i, c in enumerate(colors):
        run(["-f", "lavfi", "-i", f"color=c={c}:s=320x180:r=25:d=20", "-f", "lavfi", "-i", f"sine=frequency={300 + 60 * i}:duration=20",
             "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-g", "25", "-pix_fmt", "yuv420p", "-c:a", "libopus",
             "-shortest", str(d / f"p{i}.webm")])
        parts.append(d / f"p{i}.webm")
    lst = d / "list.txt"
    lst.write_text("".join(f"file '{p}'\n" for p in parts))
    run(["-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(out)])
    return str(out)


@pytest.fixture(scope="session")
def browser():
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        try:
            b = p.chromium.launch()
        except Exception as exc:                          # the browser itself is not installed
            pytest.skip("Chromium is not available for Playwright: " + str(exc)[:80])
        yield b
        b.close()


@pytest.fixture()
def page(browser):
    ctx = browser.new_context(viewport={"width": 1366, "height": 800})
    pg = ctx.new_page()
    pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.on("console", lambda m: pg.errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
    yield pg
    ctx.close()


@pytest.fixture(scope="session")
def long_movie(tmp_path_factory):
    """A 2-hour movie (tiny picture, no sound) to prove the timeline stays fast and exact on a long film."""
    from tools.make_samples import run
    d = tmp_path_factory.mktemp("browser_long")
    out = d / "long.webm"
    run(["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=2:duration=7200", "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8",
         "-g", "4", "-b:v", "30k", "-pix_fmt", "yuv420p", str(out)])
    return str(out)
