"""The shot-change network's plumbing: windows line up with the frames, runs of high chances become changes, and the two
finders are combined. A stand-in network is used, so these run without the model file; test_transnet_model.py runs the
real one when it is there."""

import pytest

np = pytest.importorskip("numpy")

from editforge.analysis import shots, transnet


class _Out:
    def __init__(self, name):
        self.name = name


class _Echo:
    """Stand-in network: the 'chance' of every frame is its first pixel's red value / 255."""

    def get_inputs(self):
        return [_Out("frames")]

    def get_outputs(self):
        return [_Out("single"), _Out("many")]

    def run(self, _names, feed):
        x = feed["frames"]
        assert x.shape == (1, 100, 27, 48, 3) and x.dtype == np.float32
        v = x[0, :, 0, 0, 0] / 255.0
        return [v.reshape(1, 100, 1), v.reshape(1, 100, 1)]


@pytest.fixture()
def echo(monkeypatch):
    monkeypatch.setattr(transnet, "_session", lambda path: _Echo())


@pytest.mark.parametrize("count,block", [(1, 1), (37, 7), (100, 100), (173, 64), (250, 11)])
def test_every_frame_gets_its_own_value_in_order(echo, count, block):
    vals = (np.arange(count) * 7 % 251).astype(np.uint8)
    frames = np.zeros((count, 27, 48, 3), np.uint8)
    frames[:, 0, 0, 0] = vals
    st = transnet.Streamer("x.onnx")
    for i in range(0, count, block):
        st.push(frames[i:i + block])
    got = st.finish()
    assert got.shape == (count,)
    assert np.allclose(got, vals / 255.0, atol=1e-6)


def test_no_frames(echo):
    assert transnet.Streamer("x.onnx").finish().shape == (0,)


def test_runs_of_high_chances_become_changes():
    p = np.zeros(200, np.float32)
    p[50] = 0.9                       # a hard cut
    p[120:130] = 0.7                  # a dissolve
    p[129] = 0.8
    p[170] = 0.3                      # too weak
    ch = transnet.changes(p, 25.0)
    assert [c[1] for c in ch] == ["cut", "dissolve"]
    assert abs(ch[0][0] - 50.5 / 25) < 1e-9
    assert abs(ch[1][0] - 125 / 25) < 1e-9
    assert [c[1] for c in transnet.changes(p, 25.0, 0.2)] == ["cut", "dissolve", "cut"]


def test_combining_keeps_what_the_network_does_not_rule_out():
    p = np.zeros(500, np.float32)
    p[100] = 0.95                     # the network's own cut (4.02 s)
    p[300] = 0.2                      # a small chance where the older finder saw a cut
    classic = [shots.Cut(4.05, "cut", 0.8), shots.Cut(12.0, "cut", 0.5), shots.Cut(16.0, "cut", 0.6)]
    out = transnet.combine(classic, p, 25.0)
    # 4.05 is the same change as the network's; 12.0 is kept (chance 0.2 there); 16.0 is ruled out (a flash, say)
    assert [round(c.t, 2) for c in out] == [4.02, 12.0]


def test_scene_finder_wants_new_results_once_the_network_is_there(tmp_path, monkeypatch):
    from editforge import clipsets
    sf = clipsets.SceneFinder(tmp_path / "scenes", lambda s: "fp", home=tmp_path)
    (tmp_path / "scenes" / "fp.json").write_text('{"v": 2, "scenes": [1.0], "kinds": ["cut"]}')
    monkeypatch.setattr(clipsets, "_net_model", lambda home: None)
    assert sf.status("a.mp4")["state"] == "ready"
    monkeypatch.setattr(clipsets, "_net_model", lambda home: tmp_path / "m.onnx")
    assert sf.status("a.mp4")["state"] == "none"


def test_a_quick_cut_away_and_back_is_two_cuts_but_a_hand_is_none(monkeypatch):
    feats = type("F", (), {"__len__": lambda self: 100, "at": lambda self, t: int(t * 12)})()
    p = np.zeros(400, np.float32)
    p[[50, 75, 200, 210]] = 0.95                     # 2.0 -> 3.0 s (a one-second cut-away), 8.0 -> 8.4 s (a hand)
    monkeypatch.setattr(shots, "picture_differs", lambda f, a, b: (False, 0.0))   # the same picture around both
    monkeypatch.setattr(transnet, "_plain", lambda f, t: False)
    out = transnet.combine([], p, 25.0, feats=feats)
    assert [round(c.t, 2) for c in out] == [2.02, 3.02]
