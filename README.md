# Workout Tracker

A personal workout tracker that runs as a home-screen web app on an iPhone. It runs a fixed
4-day program in rolling order, logs every set, and recommends the weight for the next session.
Plain HTML, CSS and JavaScript. No framework, no build step, no backend, no accounts.
All data stays on the phone.

## Files

| File | What it does |
|---|---|
| `index.html` | The page shell and iOS meta tags |
| `style.css` | All styling, light and dark mode |
| `app.js` | Screens, actions, rest timer, sound, wake lock, export and import |
| `progression.js` | The progression rules (pure functions, also used by the test) |
| `program.js` | The default program: exercise library and the four days |
| `sw.js` | Service worker so the app opens offline |
| `manifest.json` | Web app manifest (name, icon, standalone display) |
| `icons/` | App icons (180 for iOS, 192 and 512 for the manifest) |
| `test/progression.test.js` | 12-week simulation of the rules, run with `node test/progression.test.js` |

## Deploy to GitHub Pages

The repository includes `.github/workflows/pages.yml`. Every push to `main` publishes the app
to GitHub Pages, and the first run turns Pages on by itself. The app is live at
`https://YOUR-USERNAME.github.io/workout-tracker/` about a minute after a push.

To set it up on a fresh repository: create a public repository on github.com named
`workout-tracker`, then from this folder:

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

After changing any file, bump `VERSION` in `sw.js` (for example `v1` to `v2`), commit and push.
The workflow publishes it, and phones pick up the new files the next time the app is opened.

## Edit the program

The normal way is inside the app: Program tab, tap a day, then "Edit" to reorder or remove
exercises, "Add Exercise" to add one, or tap an exercise to change its name, equipment, sets,
reps, increment, rest time and next weight.

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

## Data and backups

Everything is stored in the browser's localStorage under one versioned JSON document
(`version: 1`). `migrate()` in `app.js` is where future schema changes convert old data.
Export regularly from Program, Settings. If Safari data is cleared, the export is the only copy.
