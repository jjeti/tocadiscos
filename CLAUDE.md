# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Tocadiscos is a local audio player styled as an animated turntable. It is a static page with no build step, no dependencies, no package manager and no tests: just `index.html`, `app.js` and `styles.css`. UI text, comments and console messages are in Spanish, so keep new ones in Spanish too.

## Running

Serve the folder and open it in a browser. A local server is better than `file://`, because IndexedDB and `navigator.storage.persist()` behave more reliably on it:

```bash
python3 -m http.server 8000
```

## Architecture (`app.js`)

**Fixed deck coordinates.** The turntable (`#deck`) is laid out in absolute pixels on a fixed 640×460 canvas. A `ResizeObserver` scales it with the CSS variable `--scale`. Geometry constants in JS must match positions in `styles.css`:
- `PIVOT` (540, 90) is the `.tonearm` `left`/`top`.
- `REST`, `START` and `END` are arm angles in degrees: on the rest, at the outer groove and at the end of the grooves.

If you move the arm or platter in CSS, update these constants. Pointer coordinates are converted back to deck space in `deckPoint()` by dividing by `scale`.

**State machine drives playback.** `state` is one of `rest | cueing | dropping | playing | lifting | returning | dragging`. A single `requestAnimationFrame` loop, `frame()`, eases the arm toward a target angle in each state and moves between states based on time and position. Audio does not start directly from `play()`:
- `play()` sets `cueing`.
- When the arm reaches the groove, the state becomes `dropping`.
- After a delay, `startAudio()` calls `audio.play()`.

Stopping goes `lifting` → `returning` → `rest`. Changing track while active re-enters `cueing`. `ACTIVE` lists the states that count as "playing". Always go through `setState()`, because it also updates CSS classes (`.lifted`, `.dragging`) and the buttons. The arm angle while playing comes from track progress (`angleFor(progress())`). Dragging the needle maps the angle back to a seek position.

**Platter vs audio.** `motorOn` controls platter spin, which has inertia (`platterSpeed` eases toward `SPIN[rpm]`). The 33/45 rpm switch also changes `playbackRate` (`PITCH`) with pitch preservation turned off.

**Audio graph.** `initAudio()` lazily creates an `AudioContext` on the first user gesture. The graph is: `<audio>` → `MediaElementSource` → `Analyser` → `Gain` → destination. Volume is set on the gain node, not on `audio.volume`. The canvas visualizer (`drawViz()`) reads the analyser on every frame.

**Persistence.**
- Audio `File` objects are stored in IndexedDB (database `tocadiscos`, store `tracks`, keyed by `id`).
- Order, current track, playback position, rpm and volume go to `localStorage` under `tocadiscos:settings`.
- On startup, `restore()` rebuilds `tracks` with fresh object URLs.
- `saveSettings()` does nothing until `restored` is true, so the initial state cannot overwrite saved data.

**Adding files.** There are three entry points: the file input, the folder input (`webkitdirectory`) and drag-and-drop. Drag-and-drop walks directories recursively with `webkitGetAsEntry`. All three end in `addFiles()`, which filters audio files, sorts them by natural path order and parses names in the form `Artist - Title`.
