"""1.40.2: the time left counts down steadily, also when finished pieces are reused, and the bar is not stuck at 80 %
while the quick joining step runs."""
from __future__ import annotations

from editforge.render import engine


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def renderer(monkeypatch, clock):
    r = engine.Renderer.__new__(engine.Renderer)
    import threading
    r._lock = threading.Lock()
    r._eta_ref = None
    r._eta_last = None
    monkeypatch.setattr(engine.time, "time", clock)
    return r


def test_time_left_ignores_reused_pieces_and_counts_down(monkeypatch):
    clock = Clock()
    r = renderer(monkeypatch, clock)
    assert r._eta_from(clock.t, 0.43) is None                 # 43 % reused at once: no wild guess from that
    out = []
    for k in range(1, 61):                                     # then a steady 0.5 % a second: 114 s left at the start
        clock.t += 1.0
        out.append(r._eta_from(clock.t, 0.43 + 0.005 * k))
    real = [(1 - (0.43 + 0.005 * k)) / 0.005 for k in range(1, 61)]
    shown = [(e, x) for e, x in zip(out, real) if e is not None]
    assert shown and abs(shown[0][0] - shown[0][1]) < 3
    assert all(abs(e - x) < 3 for e, x in shown)              # close to the truth the whole time
    assert all(b <= a + 0.01 for (a, _), (b, _) in zip(shown, shown[1:]))     # and only counts down


def test_one_slow_moment_does_not_make_the_time_jump(monkeypatch):
    clock = Clock()
    r = renderer(monkeypatch, clock)
    r._eta_from(clock.t, 0.0)
    o = 0.0
    vals = []
    for k in range(1, 40):
        clock.t += 1.0
        o += 0.01 if k != 20 else 0.0005                      # one second where nearly nothing moved
        v = r._eta_from(clock.t, o)
        if v is not None:
            vals.append(v)
    jumps = [b - a for a, b in zip(vals, vals[1:])]
    assert max(jumps) < 3, jumps
