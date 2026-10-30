# Changelog

## 1.11.0
* **Final stage: sound.** The Final page has real sound tools now.
  * **Remove noise**, **Split the sound** (Voices, Music, Effects) and **Fix loudness** in the Sound tab.
  * **Your own music layers** (Audio tab): add as many as you like (up to 8). Each has its own volume, mute and solo.
    Music never lowers itself under the voice; you set the levels.
  * **YouTube loudness, always.** The finished mix (your video's sound plus every music layer) is set last to **-14 LUFS**
    with a true peak under **-1 dB**, so it is never too loud or too quiet. The viewer shows a live meter, and after the export the
    **measured** number is shown on the finished video (Home, Exports) with a clear OK / not OK.
  * **Honest sound split.** After splitting, the page says how clean the split really is (how much of one layer still leaks into the others) instead of promising perfect.
* **Final stage: picture (like CapCut).**
  * **Move, resize and turn the picture with the mouse** in the viewer: drag it to move, drag a square corner to resize,
    drag the round knob to turn. It snaps to the middle and the edges with dashed guide lines, and turns snap at 0, 45 and 90 degrees.
  * **Grid and edge distances:** a switch shows a grid and how far the picture is from each edge, in pixels of the finished video.
  * **Masks can turn,** and you can drag, resize and turn the mask on the viewer too (choose **Mask** under *Drag on the viewer*).
  * **Seamless soft edges.** The sharp picture on top of the blurred picture now fades out where it stops, so no thin line is left.
    The viewer and the export draw the same thing.

## 1.10.0
* **Edit stage (stage 2) with three buttons.** Open a clip in **Edit** and use the **Sections** tab. Nothing is made (rendered) in this stage.
  1. **Make Odd and Even versions:** cuts the clip into 2 second sections and makes two versions, named from the clip
     (*Clip 01 - Odd* has sections 1, 3, 5 ...; *Clip 01 - Even* has 2, 4, 6 ...). They show under the button: click one to edit it.
     Every section can still be moved, removed or stretched into the gap next to it (never over the next section of the same version).
  2. **1 s sections, remove every 4th:** on the version you have open: 1 second sections with the 4th, 8th, 12th ... taken out
     (1 2 3 *4* 5 6 7 *8* ...), the rest joined. The taken-out sections can be put back. The last short section is kept.
  3. **Separate scenes:** works on the video as it is now (after button 2 or after your own changes). It cuts at the end of each scene and numbers the scenes.
     Joins count too: when removing sections puts two different scenes next to each other, that join is a scene change.
* **A much better scene finder.** It looks at the pictures on both sides of every possible cut instead of only at FFmpeg's score.
  A single flash, a hand across the lens, a dip to black inside one scene, a line of text being typed or a fast zoom are not cuts any more.
  It also finds dissolves and fades through black, and puts each hard cut on the exact frame. Tested on a real 82-second film clip
  (all five known cuts in a fast stretch found to the frame) and on made-up cases for each look-alike. The result is saved once per video.
* **Stage 3 is now its own page: Final.** **Send this version to Final** (top right of the Edit stage) makes a Final project from the version.
  Final has the Audio, Sound, Format, Frame and Text tools; the Edit stage no longer shows them. Home has Clips, Edit and Final, and Final
  lists the Final projects and the videos they made. Older projects open in Edit as before.
* The Edit stage's side panel shows only what belongs there (no sound, colour, effects, zoom or follow); the old Cut and Pattern tools are under **More**.

## 1.9.0
* **Clips page made simple (stage 1).** It does one job: take clips out of a long movie. The Video and Sound tabs are gone from this
  page (they come back in the next stages). Existing clip projects keep opening, and clips you already set up keep their settings.
* **Clip tools** (right side, **Tools** tab): move the start or the end of a part earlier or later by 0.1, 1 or 5 seconds,
  **Split at the playhead** (one clip becomes two), **Cut out the marked part** (the middle is taken out), **Join another clip**,
  **Duplicate**. Pick the part you want to change in the **Parts** tab or by clicking it on the timeline.
* **Names** come by themselves from the movie: *Movie name - Clip 01*, *Clip 02* ... Double-click a name to change it.
* **Three ways to play:** the clip, the chosen part **with 3 seconds around it**, or **all clips** one after the other.
* **Undo and redo** for every change (buttons at the top left, Ctrl+Z, Ctrl+Y). A list of all keys: press **?**.
* **File size** of the made clips: Best, Good or Small. When the clips are made, the page shows how much room they take.
* **Timeline made safer:** the pictures no longer flicker while you scroll; marks snap to a scene only when you are close
  (about 8 pixels), so exact marks are possible when zoomed in; dragging near the edge scrolls the timeline; the mouse wheel
  no longer stops vertical scrolling; the playhead can't be lost; a clip that ends where the movie ends plays and stops correctly;
  after clicking a button the keys (Space, I, O ...) keep working. Tested in a real browser on a 3-minute and a 2-hour movie.

## 1.8.1
* **Proper Nyenz Edit branding on Windows.** The program is now **NyenzEdit.exe** and the installer **NyenzEdit-Setup.exe**, with the
  Nyenz Edit icon in every size Windows uses (16 to 256 px): the installer file, the program, the desktop and Start-menu icons, the
  taskbar, and Settings > Apps (with the uninstaller). Windows shows "Nyenz Edit" by Nyenz, with the version, in Properties > Details
  and Task Manager. The installer has Nyenz Edit pictures on its pages.
* New installs go to `%LOCALAPPDATA%\Programs\Nyenz Edit`; an existing install is updated where it is, and your projects stay.
  A taskbar button pinned before still works.
* The project moved to **github.com/nyenz/nyenz-video-edit**. Older versions still update themselves (the release also carries the
  installer under its old name).

## 1.8.0
* **Frame panel in the Editor** (new button on the left): everything about the picture's place, like CapCut.
  * **Shape of the video:** Original, 16:9, 4:3, 2.35:1, 2:1, 1.85:1, 9:16, 3:4, 1:1, 4:5 and 5.8-inch (tall phone).
  * **Two layers.** Background layer: the same video filling the frame, **blurred** (strength 0-100%), or black or white.
    Video layer on top: **size** (10-400%), **left/right**, **up/down**, **turn** (-180 to 180°), and Fit / Fill / Center / Straight.
  * **Mask** on the video layer: Strip, Side strip, Rectangle, Circle or Split, with size, position, **soft edges** (edge blending
    0-100%) and inside out. The blurred layer shows around it.
  * The viewer shows it live; the export draws it in full quality (a 1080x1920 frame from 1080p).
* **Cut at scene changes** (Editor > Cut): one piece per scene, so a pattern can work on scenes. Works on later steps too.

## 1.7.0
* **Three phases on Home: Clips, Edit, Final.** Each tab has its own projects (and its own trash).
* **Clip projects (phase 1).** Choose a movie and take as many clips out of it as you like. A clip can have **several parts** from
  different places (a scene, then a moment from later), played in the order you choose. Each clip has its own **Video** settings
  (brightness, contrast, colour, speed, shape) and **Sound** settings (volume, sound off, fade in/out, noise, clearer voices, even loudness,
  bass, treble). Saved in the app a moment after every change.
* **Find scenes**: the scene changes are found once and shown under the timeline. Click a scene to mark it, double-click to add it.
  Marks snap to scene changes (switch it off with Snap to scenes).
* **Save & make clips** makes every clip into its own small video. A changed clip shows "Changed: make again".
* **Free up the movie**: when all clips are made, the movie is no longer needed. A sent-in copy is deleted; a movie used where it is on
  your computer is deleted only after you say yes. The clips stay.
* **Edit (phase 2)**: "From a made clip" starts an edit project from a clip. In Steps, **New video from step 1** starts another project
  from your first pattern cut (this project stays as it is).
* **Final (phase 3)**: the videos you export from Edit, with Watch, Save a copy, Open its project and Remove.

## 1.6.0
* **Split the sound into 3 layers: voices, music, effects** (Editor > Sound > *Split the sound*). A free AI model (BandIt Plus, trained on
  film-style sound) pulls people talking, music, and effects (gunshots, fights, cars) apart. Runs on your computer; the 76 MB model is
  downloaded once from GitHub and checked before use. The layers are kept per video, so each video is split only once.
* **3-layer mixer**: volume 0-200% for each layer, mute, and presets (Everything, Voices only, No voices, No music, Music only, Effects only).
  You hear it live while playing, and the export uses the same mix. If all three are at 100% the original sound is used untouched.
* Splits only the part of the video your pieces use (3 s extra on each side), or the whole video. *Fast* (default) or *Best* (about 2.6x slower).
* Needs the `onnxruntime` add-on (included in the installer).

## 1.5.1
* **Own taskbar icon.** The app window was grouped under Microsoft Edge on the taskbar, and pinning it pinned Edge. Now the window has
  its own taskbar button with the Nyenz Edit icon, separate from your normal Edge windows, and pinning it pins Nyenz Edit.
  (If you pinned it before, unpin that old Edge button once and pin the new one.)

## 1.5.0
* **Also called Nyenz Edit.** The window, Home screen and installer icons say Nyenz Edit (the program file is still EditForge.exe,
  so updates replace the old version).
* **Home screen** (CapCut-simple): one big Create project, the three tools, and a projects grid with picture, name and `size | length`,
  newest opened first. Search, grid or list, Trash (undo, empty), and a menu per project: Open, Rename, Duplicate, Move to trash.
  A moved or deleted video shows "Video not found" with **Find it again**. The Clips page moved to `/clips`.
* **No more copies of big videos.** Choose file opens the normal Windows file window and uses the video where it is (linked). Only
  those exact files may be read. Dropped files are still copied, and that copy is deleted with the last project that uses it.
  **Storage** panel with Free up buttons; light copies and pictures unused for a month are cleaned up at start.
* **Steps** in the Editor: pin a result (with hand edits) and add another cut and pattern on top, as many times as you like, with no
  render in between. Pieces always stay ranges of the original video, so extending a cut reaches the original footage (also what an
  earlier step removed) and stops at the next piece. Export cuts the last step from the original once. Steps are saved with the
  project, and can be saved and repeated on another video.
* **Sound clean-up** (Editor, new Sound panel): remove noise (light, medium, strong), remove voices or keep only voices (stereo), clearer voices,
  balance quiet and loud parts, bass and treble.
* **Automatic updates**: a quiet "Update available" button; downloads, checks size and SHA-256, waits for exports, installs silently
  and reopens. Checks at most once a day, "Skip this version", silent when offline. Releases now carry `EditForge-Setup.exe.sha256`.
* **Faster:** pages are gzipped and kept by the window until they change (first screen 87 KB to 27 KB); the add-on check no longer
  loads OpenCV and Whisper (0.19 s to 0.02 s); video facts and fingerprints are remembered (opening a video again: 0.16 s to 0.002 s,
  autosave 0.08 s to 0.01 s); films with Dolby sound play after a quick copy (5 min 1080p film: 44 s to 8 s); a light copy starts as
  soon as a video is added; the Exports list asks less often when nothing is being made.
* Custom dialogs replace the browser's own question boxes. Leaving the Editor right after a change no longer loses it.

## 1.4.0
* **New look.** A dark, calm editing-suite design with real icons, custom menus, switches and sliders everywhere (no plain browser
  controls), and an app icon for the window, the taskbar, the desktop and the browser tab.
* **One-file Windows installer** (`EditForge-Setup.exe`): Python, FFmpeg, face tracking and captions inside. EditForge opens in its own
  window and stops when you close it. Built and tested on Windows by GitHub Actions for every change; tags publish a release.
* **Editor rebuilt like CapCut:** tools on the left, the selected pieces on the right, a real timeline at the bottom.
  Patterns change the timeline and the viewer at once. Drag to move pieces, drag edges to trim or extend, select many (Ctrl, Shift or a box),
  split at the playhead, undo. The viewer plays the edit live, without making a video first. Secondary things (effects, colour, zoom, follow)
  are folded away; music, shape and text are in a separate "Finish" group.
* **Length everywhere:** the finished length is always on screen and updates while you drag; the marked part, each clip, ticked clips
  and the combined result all show their length before anything is made.
* **Clips page:** mark parts by dragging on a timeline strip, tick clips and join just those, see the joined length on the button.
* **Sound from the start:** films with Dolby/DTS sound or formats a browser cannot play get a light copy with normal sound automatically.
* **Combine** shows the finished length and size before combining. A single **Exports** panel on every page.

## 1.3.0
* **Follow** (Editor, step 3): zoom in and keep a face in the middle, or draw a box around any thing and the view follows it.
  Works in the original shape, piece by piece. Faces are now also found when they are small in a wide shot.
* **Words on the picture** (Editor, step 4): add words with a start and end time, place, size, colour and an optional dark box.
* **Captions** (Editor, step 4): automatic from the speech (needs the faster-whisper add-on) or from a subtitle file (.srt or .vtt).
  Captions move with their pieces, also when pieces are moved or repeated.
* **Clip workshop:** joined clips now come out in the order of the list, with Up and Down buttons.
* **Quick play** in the Editor now also shows flip, colour looks, zoom and sound (not backwards and not following).
* **Beat detector:** no longer locks onto quiet off-beat hi-hats, tries half, double and two-thirds tempo for real and keeps the one
  that fits, drops beats counted into silence, and no longer reports a false bar length for music without accents.
  On 48 test tracks from 66 to 195 BPM it now gets 46 right (before: 31).
* Notes from a finished job (for example "no faces were found") are shown under it in the page.
* All tests pass: the five old failures are gone. Two were the beat detector (fixed), one was a test mistake, and two were tests
  that assumed a 1-CPU computer.
* 32 new tests (`tests/test_follow_text.py`).

## 1.2.0
New **Editor** page: a video cut into pieces that you pick and change.
* Cut into pieces of any length (for example 2 seconds), or on every Nth beat of your music.
* Pick pieces by clicking, Shift-clicking a range, "the others", or a pattern ("in every group of 3, pick number 1").
* Change the picked pieces: remove / put back, flip, mirror, upside down, black and white, invert, sepia, blur, sharpen, dark corners,
  speed, backwards, zoom in/out, colour, mute, loudness, start/end earlier or later, move earlier/later, make a copy, clear edits.
* Patterns and hand edits work together, at any time. Undo and redo. Projects are saved on disk as you work.
* Saved patterns: keep a pattern together with its edits and use it again on any project.
* Whole video: shape (original, tall 9:16, square; middle, follow faces, or blurred edges), transitions between pieces, music with
  loudness and "quieter when someone talks", keep or drop the original sound, even loudness, fades, quality.
* Quick preview (small and fast) and full-quality render. "Best" quality now uses a slower, more careful encoder setting.
New **Combine** page: two videos one after the other (with or without a transition), side by side, top and bottom,
small one in a corner, or one over the other.
* Pieces can be re-ordered, repeated and stretched over each other, which the script language cannot do.
* Fixed: "follow faces" stood still for any piece in the middle of a long, steady camera move.
* Jobs started from the page now use up to a quarter of the free memory (300 MB to 4 GB) instead of a fixed 300 MB, so they finish sooner.
* 53 new tests (`tests/test_project.py`, `tests/test_web_editor.py`).

## 1.1.0
New first page: the **Clip workshop**. Play your video, press "Set START here" and "Set END here", collect clips, and make them
(one video per clip, or all joined into one). No typing of commands. The old script page moved to "Advanced".
* Video player with seeking, frame and second steps, keyboard shortcuts, and a bar that shows your clips.
* If the browser cannot play a file, a light 480p copy is made just for watching. Finished clips are always cut from the original.
* Finished videos can be watched in the page and opened again as a new source ("Edit this video").
* Clips are cut frame-exact from the original at "Best" quality by default.
* Fixed: the face add-on crashed with OpenCV 5. EditForge now asks for OpenCV 4 (`pip install "opencv-python-headless<5"`) and
  reports the feature as switched off when version 5 is installed.
* 19 new tests that run the real web server (`tests/test_web_workshop.py`).

## 1.0.0
First release. Engine: bounded-memory piece renderer (MPEG-TS pieces joined by stream copy), exact frame/sample accounting, keyed resume,
atomic writes, line/YAML/JSON scripts with identical features, planner/dry-run, analysis cache, local web page, SQLite job store,
beat/downbeat detection, face tracking (optional OpenCV), captions from a transcript or local Whisper (optional), loudness (two-pass), music ducking.
See SELF_REVIEW.md for what is and is not verified.
