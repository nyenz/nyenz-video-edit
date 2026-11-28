"""1.40.2: a song layer is really heard in preview files and exports, with every song setting (also on Windows FFmpeg)."""
import subprocess
import pytest
from test_v16 import web, film, export, decode, level, run

def music(path):
    run(["-f", "lavfi", "-i", "sine=frequency=5000:duration=12", "-af", "volume='0.2+0.8*abs(sin(t*1.3))':eval=frame,afade=t=in:d=1", "-c:a", "libmp3lame", str(path)])
    return str(path)

CASES = {
    "auto": {"auto": 1},
    "auto_parts": {"auto": 1, "parts": [{"end": 2.0, "volume": 0.63, "fin": 0.5}, {"end": 4.0, "volume": 1.0, "even": 3, "fout": 0.3}, {"end": None, "volume": 0.8}]},
    "duck": {"auto": 1, "duck": {"on": True, "by": {"voices": 0.3, "effects": 0.1}}},
    "vline": {"auto": 1, "vline": [[0, 1.0], [2, 0.5], [5, 1.5]]},
    "shape": {"auto": 1, "shape": {"tone": "warm", "dyn": 1, "hp": 1}},
    "all": {"auto": 1, "start": 1.5, "fade_in": 0.5, "fade_out": 1.5, "duck": {"on": True, "by": {"voices": 0.3}}, "vline": [[0, 1.0], [5, 0.7]],
            "parts": [{"end": 2.0, "volume": 0.63}, {"end": None, "volume": 1.0}], "shape": {"tone": "warm"}},
}

@pytest.mark.parametrize("preview", [True, False])
@pytest.mark.parametrize("case", list(CASES))
def test_song_combo(web, film, tmp_path, case, preview):
    c, state = web
    song = c.upload(music(tmp_path / "mp3 (4).mp3"))
    st = {"mix_split": film["split"], "mix_music": 0.02, "mix_effects": 0.44, "shape": "vertical", "follow_who": "auto",
          "layers": [dict({"file": song, "volume": 0.3}, **CASES[case])]}
    job = export(c, film, st, pieces=[{"start": i * .5, "end": i * .5 + .5} for i in range(0, 12, 2)], preview=preview)
    assert job["status"] == "done", job
    y = decode(job["output_path"])
    print("SONG", case, preview, round(level(y, 5000), 4), "voice", round(level(y, 300), 4), job.get("warnings"))
    assert level(y, 5000) > 0.003


def test_plain_project_song_without_split(web, film, tmp_path):
    c, state = web
    song = c.upload(music(tmp_path / "mp3 (4).mp3"))
    for st in ({"layers": [{"file": song, "volume": 0.3}]}, {"original_sound": True, "layers": [{"file": song, "volume": 0.3, "auto": 1}]}):
        job = export(c, film, st, preview=False)
        assert job["status"] == "done", job
        y = decode(job["output_path"])
        print("SONG plain", st["layers"][0], round(level(y, 5000), 4))
        assert level(y, 5000) > 0.003


def real_world_song(kind, d):
    """Songs the way they come from the internet: cover pictures, the wrong extension, odd rates, variable bit rate."""
    src = ["-f", "lavfi", "-i", "sine=frequency=5000:duration=30"]
    img = d / "cover.jpg"
    if not img.exists():
        run(["-f", "lavfi", "-i", "color=c=orange:s=500x500", "-frames:v", "1", str(img)])
    pic = ["-i", str(img), "-map", "0:a", "-map", "1:v", "-c:v", "mjpeg", "-disposition:v", "attached_pic"]
    out = {
        "mp3_cover": (d / "a.mp3", src + pic + ["-c:a", "libmp3lame", "-id3v2_version", "3", "-metadata", "title=Song", "-metadata:s:v", "title=Album cover"]),
        "mp3_vbr_48k": (d / "b.mp3", src + ["-ar", "48000", "-ac", "2", "-c:a", "libmp3lame", "-q:a", "4"]),
        "mp3_mono_22k": (d / "c.mp3", src + ["-ar", "22050", "-ac", "1", "-c:a", "libmp3lame"]),
        "aac_named_mp3": (d / "d.mp3", src + ["-c:a", "aac", "-f", "mp4"]),
        "opus_named_mp3": (d / "e.mp3", src + ["-c:a", "libopus", "-f", "webm"]),
        "m4a_cover": (d / "f.m4a", src + pic + ["-c:a", "aac"]),
        "flac_cover": (d / "g.flac", src + pic + ["-c:a", "flac"]),
        "wav_24bit": (d / "h.wav", src + ["-c:a", "pcm_s24le"]),
        "ogg": (d / "i.ogg", src + ["-c:a", "libvorbis"]),
    }[kind]
    run(out[1] + [str(out[0])])
    return str(out[0])


KINDS = ["mp3_cover", "mp3_vbr_48k", "mp3_mono_22k", "aac_named_mp3", "opus_named_mp3", "m4a_cover", "flac_cover", "wav_24bit", "ogg"]


@pytest.mark.parametrize("kind", KINDS)
def test_songs_from_the_internet_are_heard(web, film, tmp_path, kind):
    c, state = web
    try:
        path = real_world_song(kind, tmp_path)
    except Exception as exc:                                   # an encoder this FFmpeg does not have
        pytest.skip(f"can not make {kind}: {exc}")
    song = c.upload(path)
    st = {"mix_split": film["split"], "mix_music": 0.02, "mix_effects": 0.44, "shape": "vertical",
          "layers": [{"file": song, "volume": 0.3, "auto": 1, "duck": {"on": True, "by": {"voices": 0.35}}, "fade_in": 0.5, "fade_out": 1}]}
    for preview in (True, False):
        job = export(c, film, st, pieces=[{"start": i * .5, "end": i * .5 + .5} for i in range(0, 12, 2)], preview=preview)
        assert job["status"] == "done", job
        y = decode(job["output_path"])
        print("SONGKIND", kind, preview, round(level(y, 5000), 4))
        assert level(y, 5000) > 0.003, (kind, preview)


def test_a_song_is_mixed_from_a_clean_copy(tmp_path):
    from editforge import project as P
    from editforge.core.media import probe_media
    src = real_world_song("mp3_cover", tmp_path)
    out = P.song_copy(src, str(tmp_path / "home"))
    m = probe_media(out)
    assert out.endswith(".flac") and m.has_audio and not m.has_video and abs(m.duration - 30) < 0.1
    assert P.song_copy(src, str(tmp_path / "home")) == out          # made once, kept
    bad = tmp_path / "not a song.mp3"
    bad.write_bytes(b"nope")
    assert P.song_copy(str(bad), str(tmp_path / "home")) == str(bad)   # unreadable: the file itself, as before


def test_clip_names_do_not_say_the_movie_twice():
    from editforge.project import joined_name
    assert joined_name("Film (2019)", "Film (2019) - Clip 01") == "Film (2019) - Clip 01"
    assert joined_name("Film", "Clip 01") == "Film_Clip 01"
