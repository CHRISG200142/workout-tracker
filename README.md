# Workout Tracker

A personal workout tracker that runs as a home-screen web app on an iPhone. It runs a fixed
3-day program in rolling order, logs every set, and recommends the weight for the next session.
Plain HTML, CSS and JavaScript. No framework, no build step, no backend, no accounts.
All data stays on the phone.

## Files

| File | What it does |
|---|---|
| `index.html` | The page shell and iOS meta tags |
| `style.css` | All styling, light and dark mode |
| `app.js` | Screens, actions, rest timer, sound, wake lock, export and import |
| `progression.js` | The progression rules (pure functions, also used by the test) |
| `program.js` | The default program: exercise library and the three days |
| `sw.js` | Service worker so the app opens offline |
| `manifest.json` | Web app manifest (name, icon, standalone display) |
| `icons/` | App icon: `icon.svg` is the source, the PNGs are rendered from it |
| `test/progression.test.js` | 12-week simulation of the rules, run with `node test/progression.test.js` |

## How the workout screen works

- The band at the top always shows one of four things in the same space: the next set, the rest
  countdown, "Rest over" (inverted, with how long ago), or "All sets logged".
- The big button at the bottom logs the next set exactly as shown. When everything is logged or
  skipped it becomes "Finish Workout".
- Each set also has its own ring. Tap it to log that set, tap it again to undo.
- Tap a weight or a rep count to change it. The keys say how far they move.
- "Finish Early" sits under the last exercise and asks before it saves.
- Nothing on the screen moves when a set is logged or a rest starts or ends.

Rest timer details: rest lengths are unchanged. No rest starts after the last set of the workout.
Undoing the set that started a rest brings back the rest that was running before it. "Rest over"
stays in the band until the next set (at most 10 minutes), and "+30 sec" then starts a fresh
30 seconds.

## Deploy to GitHub Pages

The repository includes `.github/workflows/pages.yml`. Every push to `main` publishes the app
to GitHub Pages. The app is live at `https://YOUR-USERNAME.github.io/workout-tracker/` about a
minute after a push.

To set it up on a fresh repository: create a public repository on github.com named
`workout-tracker`, open its Settings, Pages, and set "Source" to "GitHub Actions". Then from
this folder:

```sh
git init -b main && git add -A && git commit -m "Workout tracker"
git remote add origin https://github.com/YOUR-USERNAME/workout-tracker.git
git push -u origin main
```

## Add to the iPhone home screen

1. Open the URL in Safari.
2. Tap the Share button, then "Add to Home Screen", then "Add".
3. Open it from the home screen. It runs full screen with its own icon and works offline.

## Ship an update

After changing any file, bump `VERSION` in `sw.js` (for example `v4` to `v5`), commit and push.
The workflow publishes it. A phone picks up the new files the next time the app is opened: it
reloads itself at once if nothing has been touched yet, otherwise the next time the app goes to
the background.

The home-screen icon is the exception. iOS copies the icon when the app is added and never
refreshes it. To get a new icon: export your data (Program, Export data), remove the app from
the home screen, add it again from Safari, open it once, then tap "Restore from an exported file" on the
first screen. Removing the app can delete its saved data, so do not skip the export.

## Edit the program

The normal way is inside the app: Program tab, tap a day, then "Edit" to reorder or remove
exercises, "Add Exercise" to add one, or tap an exercise to change its name, equipment, sets,
reps, the weight added each time, rest time and next weight.

The defaults in `program.js` are used only on the first run and after "Reset all data".
Changing that file does not change data already saved on a phone.

## Edit the progression rules

All rules are in `progression.js`:

- `DELOAD_AFTER_MISSES` (3) and `DELOAD_PERCENT` (10) at the top.
- `deload()` rounds the lowered weight to the nearest increment, and drops one increment when
  rounding would land on the same weight.
- `judgeExercise()` decides the weight a session counts at (the heaviest weight used) and
  whether it was a success (every set at that weight reached the target reps).
- `applySession()` turns a success or miss into the next recommendation.

Run `node test/progression.test.js` after editing. It prints the 12-week recommendation
sequences for Barbell Squat, Overhead Pull-up and Lateral Raise and checks them.

## Edit the look

Every color is a variable at the top of `style.css`, once for light and once for dark. The type
scale has six sizes and two weights; panels use a 12 px corner radius and keys 8 px. The one serif
title per screen uses the iPhone's built-in New York face.

## Data and backups

Everything is stored in the browser's localStorage under one versioned JSON document
(`version: 3`). `migrate()` in `app.js` is where schema changes convert old data. Version 2
(November 2026) replaced the original four days with the current three-day program while
keeping every exercise, weight and workout, and version 3 restarted the rotation at Day 1 and
dropped an unfinished workout left over from the old program.

Export regularly from Program, Export data. If Safari data is cleared, the export is the only
copy. If the saved data ever cannot be read, the app keeps the unreadable copy under a separate
key (`workout-tracker-data-unreadable-...`) instead of overwriting it.

An unfinished workout with nothing logged can be cleared by opening it and tapping
"Finish Early", then "Discard Workout".
