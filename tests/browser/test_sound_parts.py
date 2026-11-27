"""1.35, Final in a real browser: a part's own sound shaping (Tone, Cuts, Dynamics, Clean, Timing) for split tracks,
sections and songs; groups you can add to and take out of; choosing parts by loudness, the opposite or by time; volume
lines with dots you drag; and right-click menus with sub-menus."""

from __future__ import annotations

import subprocess

import pytest

from editforge.core import ffmpeg as ff
from editforge.core.fingerprint import file_fingerprint
from editforge import splitter as SP


@pytest.fixture(scope="module")
def split_movie(live, movie, tmp_path_factory):
    from tools.make_samples import run
    copy = tmp_path_factory.mktemp("sp") / "Parts movie.mp4"
    copy.write_bytes(open(movie, "rb").read())
    fid = live.upload(str(copy))
    src = live.state.resolve_input(fid)
    store = SP.SplitStore(live.state.home)
    folder = store.folder(file_fingerprint(src), 0.0, 182.0)
    folder.mkdir(parents=True, exist_ok=True)
    # voices: loud for the first minute, quiet after, silent at the end; music and effects steady
    run(["-f", "lavfi", "-i", "aevalsrc='if(lt(t,60),0.5,if(lt(t,150),0.02,0))*sin(2*PI*300*t)':d=182:s=16000", "-c:a", "flac", str(folder / "voices.flac")])
    for name, hz in (("music", 1000), ("effects", 3000)):
        run(["-f", "lavfi", "-i", f"sine=frequency={hz}:duration=182", "-ar", "16000", "-c:a", "flac", str(folder / (name + ".flac"))])
    store.write_meta(folder, 0.0, 182.0, 1.0, "fast")
    return fid


@pytest.fixture(scope="module")
def plain_id(live, tmp_path_factory):
    """A video of its own (with no split), so the plain Sound track shows."""
    from tools.make_samples import make_video
    p = make_video(str(tmp_path_factory.mktemp("plain") / "Plain one.mp4"), 120, "320x180", "25", "tone")
    return live.upload(p)


@pytest.fixture(scope="module")
def song_id(live, tmp_path_factory):
    p = tmp_path_factory.mktemp("song") / "Parts song.wav"
    subprocess.run([ff.find_executable("ffmpeg"), "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=60", str(p)], check=True)
    return live.upload(str(p))


def open_final(live, page, fid, name, interval=20):
    pid = live.call("POST", "/api/projects", {"source": fid, "name": name, "stage": "final", "interval": interval})["project"]["id"]
    page.goto(f"{live.base}/final?p={pid}")
    page.wait_for_function("() => typeof S !== 'undefined' && S.proj && S.info && document.querySelector('#laneV .clipb')", timeout=30000)
    return pid


def menu_pick(page, top, item):
    page.hover(f'.menu.ctx:not(.sub) div[role=menuitem]:has-text("{top}")')
    page.click(f'.menu.ctx.sub div[role=menuitem]:has-text("{item}")')


def test_split_parts_get_tone_cuts_and_timing_from_the_panel_and_the_menu(live, page, split_movie):
    pid = open_final(live, page, split_movie, "Shape parts")
    page.wait_for_selector("#laneStems .lane.stem", timeout=30000)
    page.click("#laneStems .stem-head[data-layer=voices]")                       # the whole Voices track
    box = "#right .shape-box"
    page.click(box + " .seg button:has-text('Clear voice')")
    assert page.evaluate("() => kept().every(p => p.mix.voices.tone === 'voice')")
    page.click(box + " .shape-tab[data-k=cut]")
    page.click(box + " .field:has-text('Low cut') button:has-text('150 Hz')")
    page.click(box + " .shape-tab[data-k=time]")
    page.click(box + " .nudge-row button:has-text('+40')")
    assert page.evaluate("() => [kept()[0].mix.voices.hp, kept()[0].mix.voices.nudge]") == [150, 40]
    assert page.locator(box + " .shape-tab .shape-dot").count() == 3                # Tone, Cuts, Timing are changed
    # the player hears it: the tone chain of voices is set while playing
    page.evaluate("() => { seek(1); play(); }")
    page.wait_for_function("() => Layers.state() && Layers.state().voices.gain > 0", timeout=20000)
    page.evaluate("() => pause()")
    # right-click: Dynamics from a sub-menu, on one part only
    page.eval_on_selector("#laneStems .lane.stem[data-layer=effects]", "e => e.scrollIntoView({ block: 'nearest' })")
    lane = page.query_selector("#laneStems .lane.stem[data-layer=effects]").bounding_box()
    tl = page.query_selector("#tlScroll").bounding_box()
    x1 = page.evaluate("() => px((layout()[1].out0 + layout()[1].out1) / 2) - $('tlScroll').scrollLeft")
    page.mouse.click(tl["x"] + x1, lane["y"] + 16, button="right")
    menu_pick(page, "Dynamics", "Strong")
    assert page.evaluate("() => kept().map(p => (p.mix && p.mix.effects && p.mix.effects.dyn) || 0)")[:3] == [0, 2, 0]
    # Reset all
    page.click("#laneStems .stem-head[data-layer=voices]")
    page.click(box + " .link-btn:has-text('Reset all')")
    assert page.evaluate("() => kept().every(p => !p.mix || !p.mix.voices || (!p.mix.voices.tone && !p.mix.voices.hp && !p.mix.voices.nudge))")
    page.click("#laneStems .stem-head[data-layer=voices]")
    page.click(box + " .shape-tab[data-k=tone]")
    page.click(box + " .seg button:has-text('Bright')")
    page.evaluate("() => saveNow()")
    saved = live.call("GET", f"/api/projects/{pid}")["project"]["pieces"]
    assert saved[0]["mix"]["voices"]["tone"] == "bright" and saved[1]["mix"]["effects"]["dyn"] == 2
    assert page.errors == []


def test_groups_can_grow_and_parts_can_leave_them(live, page, split_movie):
    open_final(live, page, split_movie, "Groups grow")
    page.wait_for_selector("#laneStems .lane.stem", timeout=30000)
    page.evaluate("() => { S.sel.clear(); S.asel = new Map(); aselSet(kept()[0], 'music', true); aselSet(kept()[1], 'music', true); refreshAll({ keepVideo: true }); }")
    page.evaluate("() => { window.askText = async () => 'Group A'; }")
    page.evaluate("() => makeGroup()")
    page.wait_for_function("() => soundGroups().length === 1")
    gid = page.evaluate("() => soundGroups()[0].id")
    # another part of the same track, added to Group A from the right-click menu
    page.eval_on_selector("#laneStems .lane.stem[data-layer=music]", "e => e.scrollIntoView({ block: 'nearest' })")
    lane = page.query_selector("#laneStems .lane.stem[data-layer=music]").bounding_box()
    tl = page.query_selector("#tlScroll").bounding_box()
    x3 = page.evaluate("() => px((layout()[3].out0 + layout()[3].out1) / 2) - $('tlScroll').scrollLeft")
    page.mouse.click(tl["x"] + x3, lane["y"] + 16, button="right")
    menu_pick(page, "Group", "Add to 'Group A'")
    assert page.evaluate(f"() => groupParts('{gid}').length") == 3
    # edit the whole group at once: choose it, then one change
    page.evaluate(f"() => chooseGroup('{gid}')")
    page.evaluate("() => stemChange(c => { c.volume = 0.4; })")
    assert page.evaluate(f"() => groupParts('{gid}').every(x => x.p.mix.music.volume === 0.4)")
    # take one out
    page.evaluate("() => { S.asel = new Map(); aselSet(kept()[1], 'music', true); }")
    page.evaluate("() => takeOutOfGroup()")
    assert page.evaluate(f"() => groupParts('{gid}').length") == 2
    assert page.evaluate("() => kept()[1].mix.music.volume") == 0.4                  # its sound stays
    assert page.errors == []


def test_choose_parts_by_loudness_the_opposite_and_by_time(live, page, split_movie):
    open_final(live, page, split_movie, "Choose by loudness")
    page.wait_for_selector("#laneStems .lane.stem", timeout=30000)
    page.wait_for_function("() => S.stemPeaks.voices && S.stemPeaks.voices.length > 1000", timeout=30000)
    page.eval_on_selector("#laneStems .lane.stem[data-layer=voices]", "e => e.scrollIntoView({ block: 'nearest' })")
    lane = page.query_selector("#laneStems .lane.stem[data-layer=voices]").bounding_box()
    tl = page.query_selector("#tlScroll").bounding_box()
    page.mouse.click(tl["x"] + 300, lane["y"] + 16, button="right")
    menu_pick(page, "Choose", "All silent parts")
    silent = page.evaluate("() => aselList().map(x => kept().indexOf(x.p))")
    assert silent and min(silent) >= 7                                            # the end (after 150 s) is silent
    page.mouse.click(tl["x"] + 300, lane["y"] + 16, button="right")
    menu_pick(page, "Choose", "All loud parts")
    loud = page.evaluate("() => aselList().map(x => kept().indexOf(x.p))")
    assert loud and max(loud) <= 2                                                # the first minute is loud
    page.mouse.click(tl["x"] + 300, lane["y"] + 16, button="right")
    menu_pick(page, "Choose", "The opposite")
    assert set(page.evaluate("() => aselList().map(x => kept().indexOf(x.p))")) == set(range(page.evaluate("() => kept().length"))) - set(loud)
    page.evaluate("() => { window.askText = async () => '0:25 - 0:45'; }")
    page.mouse.click(tl["x"] + 300, lane["y"] + 16, button="right")
    menu_pick(page, "Choose", "By time")
    page.wait_for_function("() => aselList().length === 2")
    assert page.evaluate("() => aselList().map(x => kept().indexOf(x.p))") == [1, 2]
    assert page.errors == []


def test_volume_lines_have_dots_you_add_drag_and_remove(live, page, plain_id):
    fid = plain_id
    pid = open_final(live, page, fid, "Volume line")
    la = page.query_selector("#laneA").bounding_box()
    tl = page.query_selector("#tlScroll").bounding_box()
    page.mouse.click(tl["x"] + 400, la["y"] + la["height"] / 2, button="right")
    menu_pick(page, "Volume line", "Show the volume line")
    page.wait_for_selector("#laneA svg.vline .vl-hit", state="attached")
    # double-click the line: a dot
    x = tl["x"] + 400
    page.mouse.dblclick(x, la["y"] + la["height"] / 2)
    page.wait_for_selector("#laneA svg.vline .vl-dot")
    assert len(page.evaluate("() => S.proj.settings.vline.original")) == 1
    # drag the dot down: quieter there
    dot = page.query_selector("#laneA svg.vline .vl-dot").bounding_box()
    page.mouse.move(dot["x"] + dot["width"] / 2, dot["y"] + dot["height"] / 2)
    page.mouse.down()
    page.mouse.move(dot["x"] + dot["width"] / 2, la["y"] + la["height"] - 6, steps=4)
    page.mouse.up()
    g = page.evaluate("() => S.proj.settings.vline.original[0][1]")
    assert g < 0.4
    # the player follows the line
    assert page.evaluate("() => lineAt(S.proj.settings.vline.original, 0)") == g
    # a dip from the menu adds four dots
    page.mouse.click(tl["x"] + 700, la["y"] + 4, button="right")
    menu_pick(page, "Volume line", "Dip here")
    assert len(page.evaluate("() => S.proj.settings.vline.original")) == 5
    page.evaluate("() => saveNow()")
    assert len(live.call("GET", f"/api/projects/{pid}")["project"]["settings"]["vline"]["original"]) == 5
    # right-click a dot: remove it
    d0 = page.query_selector("#laneA svg.vline .vl-dot").bounding_box()
    page.mouse.click(d0["x"] + 4, d0["y"] + 4, button="right")
    page.click(".menu.ctx div[role=menuitem]:has-text('Remove this dot')")
    assert len(page.evaluate("() => S.proj.settings.vline.original")) == 4
    assert page.errors == []


def test_songs_get_tone_per_part_and_for_the_whole_song(live, page, plain_id, song_id):
    fid = plain_id
    pid = open_final(live, page, fid, "Song tone")
    page.evaluate("(id) => { S.proj.settings.layers = [{ file: id, volume: 1, mute: false, solo: false }]; scheduleSave(); loadFiles(); refreshAll({ keepVideo: true }); }", song_id)
    page.wait_for_selector("#laneM .mpart")
    page.click("#laneM .mpart")
    page.wait_for_selector("#right .shape-box")
    boxes = page.locator("#right .shape-box")
    assert boxes.count() == 2                                                    # the chosen parts, and the whole song
    assert boxes.nth(0).locator(".shape-tab[data-k=dyn]").count() == 0             # no Dynamics for a part of a song
    boxes.nth(0).locator(".shape-tab[data-k=tone]").click()
    page.locator("#right .shape-box").nth(0).locator(".seg button:has-text('Warm')").click()
    page.locator("#right .shape-box").nth(1).locator(".shape-tab[data-k=dyn]").click()
    page.locator("#right .shape-box").nth(1).locator(".seg button:has-text('Gentle')").click()
    st = page.evaluate("() => S.proj.settings.layers[0]")
    assert st["parts"][0]["tone"] == "warm" and st["shape"] == {"dyn": 1}
    page.evaluate("() => saveNow()")
    saved = live.call("GET", f"/api/projects/{pid}")["project"]["settings"]["layers"][0]
    assert saved["parts"][0]["tone"] == "warm" and saved["shape"] == {"dyn": 1}
    assert page.errors == []
