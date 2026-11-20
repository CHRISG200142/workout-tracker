/* app.js
 * The whole app: storage, screens, actions, rest timer, sound, wake lock, export and import.
 * Plain JavaScript, no build step. The progression rules live in progression.js and the
 * default program in program.js. Nothing in this file changes those rules or the saved data format.
 */
(function () {
'use strict';

const P = window.Progression;
const DEFAULTS = window.ProgramDefaults;
const APP_VERSION = '2.0.0';
const DATA_KEY = 'workout-tracker-data';
const UI_KEY = 'workout-tracker-ui';

// Equipment types. "step" is how far the weight +/- buttons move for that equipment.
const TYPES = {
  barbell:    { label: 'Barbell', step: 5 },
  dumbbell:   { label: 'Dumbbell', step: 2.5 },
  machine:    { label: 'Machine', step: 5 },
  bodyweight: { label: 'Weighted bodyweight', step: 2.5 }
};

// Timings (milliseconds) for the guards that keep a stray or doubled tap from doing damage.
const TAP_LOCK_NAV = 350;        // after a screen change
const TAP_LOCK_SHIFT = 300;      // after content moved (stepper, skip, undo)
const LOG_DEBOUNCE = 500;        // between two taps that log or un-log sets
const LOGGED_LABEL = 1200;       // how long the big button says "Set 2 logged"
const CONFIRM_ARM = 400;         // a confirmation ignores taps for this long after it appears
const CONFIRM_TIMEOUT = 8000;    // an unanswered confirmation goes away
const REST_OVER_KEEP = 10 * 60000; // "Rest over" stays until the next set, at most this long
const RESTORE_WINDOW = 10 * 60000; // reopen the last screen only if the app was used this recently
const STALE_AFTER = 30 * 60000;    // coming back after this long opens Home again
const WAKE_IDLE = 10 * 60000;      // the screen may sleep after this long without a touch or a rest

// ------------------------------------------------------------------ Data and storage
function freshData() {
  const exercises = {}, progress = {};
  DEFAULTS.exercises.forEach(e => {
    exercises[e.id] = Object.assign({}, e);
    progress[e.id] = { weight: 0, misses: 0 };
  });
  return {
    version: 3,
    setupDone: false,
    settings: { sound: true },
    exercises,                                    // id -> { id, name, type, sets, reps, increment, rest }
    days: DEFAULTS.days.map(d => ({ name: d.name, exercises: d.exercises.slice() })),
    progress,                                     // id -> { weight: next recommendation, misses }
    sessions: [],                                 // completed workouts, oldest first
    nextDay: 0,                                   // index of the next day in the rolling order
    active: null                                  // the workout in progress, if any
  };
}

// Brings older saved data up to the current schema. Add a step here whenever the schema changes.
function migrate(d) {
  if (!d || typeof d !== 'object') throw new Error('Not a data file.');
  if (!d.exercises || !Array.isArray(d.days) || !Array.isArray(d.sessions) || !d.progress) {
    throw new Error('Not a workout tracker file.');
  }
  if (!d.version) d.version = 1;
  if (d.version === 1) {
    // November 2026: the program changed from four days to three. Every exercise, weight and
    // workout is kept, the new exercises are added, and the day lists become the new program.
    DEFAULTS.exercises.forEach(e => {
      if (!d.exercises[e.id]) d.exercises[e.id] = Object.assign({}, e);
      if (!d.progress[e.id]) d.progress[e.id] = { weight: 0, misses: 0 };
    });
    d.days = DEFAULTS.days.map(day => ({ name: day.name, exercises: day.exercises.slice() }));
    d.version = 2;
  }
  if (d.version === 2) {
    // The new program starts at Day 1, and a workout left in progress with nothing logged
    // (started under the old program) is dropped so Home stops offering to resume it.
    d.nextDay = 0;
    if (d.active && !hasLoggedSets(d.active)) d.active = null;
    d.version = 3;
  }
  if (!d.settings) d.settings = { sound: true };
  if (d.active === undefined) d.active = null;
  return d;
}
function hasLoggedSets(workout) {
  return workout.exercises.some(e => e.sets.some(s => s.status !== 'pending'));
}

// If the saved data cannot be read, it is copied to its own key before anything is written, so a
// damaged save is never silently replaced by an empty one. Set Up then says so and offers it.
const DAMAGED_KEY = `${DATA_KEY}-unreadable`;
let loadFailed = false;
function load() {
  let raw = null;
  try {
    raw = localStorage.getItem(DATA_KEY);
    if (raw) return migrate(JSON.parse(raw));
  } catch (e) {
    console.error('Could not read saved data', e);
    loadFailed = true;
    try { if (raw && localStorage.getItem(DAMAGED_KEY) !== raw) localStorage.setItem(DAMAGED_KEY, raw); } catch (err) { /* ignore */ }
  }
  return freshData();
}
function save() {
  try { localStorage.setItem(DATA_KEY, JSON.stringify(data)); }
  catch (e) { console.error('Could not save', e); }
}
function loadUI() {
  let u = {};
  try { u = JSON.parse(localStorage.getItem(UI_KEY)) || {}; } catch (e) { u = {}; }
  delete u.selectedDay; delete u.pickDay; delete u.dayEdit;   // fields of the old app, now held in memory
  return u;
}
function damagedCopy() {
  try { return localStorage.getItem(DAMAGED_KEY); } catch (e) { return null; }
}
function saveUI() {
  ui.lastUsed = Date.now();
  try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch (e) { /* ignore */ }
}

let data = load();
let ui = loadUI();   // saved between launches: { screen, params, stack, historyTab, focusEx, lastUsed }

// Held in memory only: never saved, gone when the app is closed.
const mem = {
  edit: null,          // the open stepper: { ex, set, field }
  noteOpen: null,      // index of the exercise whose note field is open
  confirm: null,       // inline confirmation in the bottom bar: { kind, at, ... }
  notice: null,        // one line of feedback about import or export: { text, bad }
  selectedDay: null,   // a day picked on Home instead of the next one
  pickDay: false,      // the day picker on Home is open
  dayEdit: false,      // Edit mode on a Day screen
  removeArmed: null,   // index of the row whose Remove button is showing in Edit mode
  movedRow: null,      // index of the row that was just moved (tinted briefly)
  nav: null,           // kind of screen change being drawn: push, pop, tab, rise
  lockUntil: 0,        // taps are ignored until this time
  lastLogAt: 0,        // when a set was last logged or un-logged
  loggedLabel: null,   // { text, until } shown on the big button right after logging
  flash: null,         // "exercise-set" of the row to animate on the next draw
  tabScroll: {},       // scroll position of each tab's first screen
  workoutScroll: null, // scroll position of the workout screen while Home is showing
  touchedAt: 0,        // when the screen was last touched
  listTouchedAt: 0,    // when the list itself was last touched (cancels automatic scrolling)
  shownAt: Date.now(), // when the current screen was drawn for the first time
  touchedSinceLoad: false, // whether anything has been touched since the app opened
  reloadWhenHidden: false, // a new version is waiting for a quiet moment
  hiddenAt: 0          // when the app last went to the background
};
let renderCount = 0;

// ------------------------------------------------------------------ Helpers
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtW = w => String(P.clean(Number(w) || 0));
const fmtRest = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const fmtTime = ts => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const NB = '\u00a0';   // a space that never breaks a line
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

// "Thu, Nov 19", with the year when it is not this year.
function fmtDate(ts, short) {
  const d = new Date(ts);
  const opts = short ? { month: 'short', day: 'numeric' } : { weekday: 'short', month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}
// "Today", "Yesterday", otherwise the date.
function dayLabel(ts) {
  const now = new Date();
  if (sameDay(ts, now)) return 'Today';
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(ts, y)) return 'Yesterday';
  return fmtDate(ts);
}
function fmtDuration(a, b) {
  const m = Math.max(1, Math.round((b - a) / 60000));
  if (m < 60) return `${m} min`;
  return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 60)} h`;
}
function parseNum(v) {
  const n = parseFloat(String(v).replace(',', '.'));
  return isFinite(n) && n > 0 ? P.clean(n) : 0;
}
function typeOf(t) { return TYPES[t] || TYPES.dumbbell; }
function getProgress(id) {
  if (!data.progress[id]) data.progress[id] = { weight: 0, misses: 0 };
  return data.progress[id];
}
// A weight in words: "205 lb", "+25 lb" for added weight, "Bodyweight" for none.
function weightLabel(type, w) {
  w = Number(w) || 0;
  if (type === 'bodyweight') return w === 0 ? 'Bodyweight' : `+${fmtW(w)}${NB}lb`;
  return `${fmtW(w)}${NB}lb`;
}
// The target, always written "3 × 5".
const target = (sets, reps) => `${sets}${NB}×${NB}${reps}`;
// The same weight as a figure: the number large, the unit small.
function fig(type, w, extra) {
  w = Number(w) || 0;
  const tail = extra ? `<span class="fig-x">${extra}</span>` : '';
  if (type === 'bodyweight' && w === 0) return `<span class="fig"><span class="fig-word">Bodyweight</span>${tail}</span>`;
  return `<span class="fig"><span class="fig-n">${type === 'bodyweight' ? '+' : ''}${fmtW(w)}</span><span class="fig-u">lb</span>${tail}</span>`;
}
// Rolling order: the day after the last completed workout, kept in data.nextDay. After the last
// day the next workout is Day 1. If the stored value is unusable, derive it from the last workout.
function nextDayIndex() {
  if (!data.days.length) return 0;
  if (Number.isInteger(data.nextDay) && data.nextDay >= 0 && data.nextDay < data.days.length) return data.nextDay;
  const last = data.sessions[data.sessions.length - 1];
  if (!last) return 0;
  const next = last.dayIndex + 1;
  return next >= data.days.length ? 0 : next;
}
function lastResult(exId) {
  for (let i = data.sessions.length - 1; i >= 0; i--) {
    const e = data.sessions[i].exercises.find(x => x.exerciseId === exId && x.result !== 'skipped');
    if (e) return e;
  }
  return null;
}
// What was done, always written the same way: "205 lb × 5, 4, 5". Reps under the target are
// marked as misses and an unlogged set is a dash. "3 × 5" is reserved for the target.
function performed(e) {
  const logged = e.sets.filter(s => s.status !== 'pending');
  if (e.result === 'skipped' || !logged.length) return 'Not done';
  const rep = s => s.status === 'pending' ? '–' : (s.reps < e.targetReps ? `<span class="miss">${s.reps}</span>` : String(s.reps));
  const w = logged[0].weight;
  if (logged.every(s => s.weight === w)) return `${esc(weightLabel(e.type, w))}${NB}×${NB}${e.sets.map(rep).join(', ')}`;
  return e.sets.map(s => s.status === 'pending' ? '–' : `${esc(weightLabel(e.type, s.weight))}${NB}×${NB}${rep(s)}`).join(', ');
}
// The outcome in one vocabulary everywhere, from the stored next weight and the weight used.
function resultInfo(e) {
  if (e.result === 'skipped') return { text: 'Skipped', cls: 'skip' };
  const d = P.clean((Number(e.nextWeight) || 0) - (Number(e.weightUsed) || 0));
  if (d > 0) return { text: `Up ${fmtW(d)} lb`, cls: 'up' };
  if (d < 0) return { text: `Down ${fmtW(-d)} lb`, cls: 'down' };
  return { text: 'Same weight', cls: 'same' };
}
function sessionsFor(exId) {
  const out = [];
  data.sessions.forEach(s => s.exercises.forEach(e => {
    if (e.exerciseId === exId && e.result !== 'skipped') out.push({ session: s, e });
  }));
  return out;
}
function bestFor(entries) {
  let best = null;
  entries.forEach(({ session, e }) => e.sets.forEach(s => {
    if (s.status === 'pending' || s.reps < e.targetReps) return;
    if (!best || s.weight > best.weight || (s.weight === best.weight && s.reps > best.reps)) {
      best = { weight: s.weight, reps: s.reps, at: session.finishedAt };
    }
  }));
  return best;
}
function programExerciseIds() {
  const ids = [];
  data.days.forEach(d => d.exercises.forEach(id => { if (data.exercises[id] && !ids.includes(id)) ids.push(id); }));
  return ids;
}
function allExerciseIds() {
  const ids = programExerciseIds();
  Object.keys(data.exercises)
    .filter(id => !ids.includes(id))
    .sort((a, b) => data.exercises[a].name.localeCompare(data.exercises[b].name))
    .forEach(id => ids.push(id));
  return ids;
}
function daysWith(exId) {
  return data.days.filter(d => d.exercises.includes(exId)).map(d => d.name);
}
function joinAnd(list) {
  if (list.length < 2) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

// ---- the workout in progress
function workoutCounts(a) {
  let total = 0, logged = 0;
  a.exercises.forEach(e => {
    if (e.skipped) return;
    total += e.sets.length;
    logged += e.sets.filter(s => s.status !== 'pending').length;
  });
  return { total, logged, pending: total - logged };
}
// The next set to perform: the first unlogged set of the exercise last worked on, if it still has
// one, otherwise of the first unfinished exercise. Null when everything is logged or skipped.
function nextSet() {
  const a = data.active;
  if (!a) return null;
  const pendingIn = i => {
    const e = a.exercises[i];
    return !e || e.skipped ? -1 : e.sets.findIndex(s => s.status === 'pending');
  };
  let i = Number.isInteger(ui.focusEx) ? ui.focusEx : -1;
  if (pendingIn(i) < 0) i = a.exercises.findIndex((e, k) => pendingIn(k) >= 0);
  return i < 0 ? null : { ex: i, set: pendingIn(i) };
}
function setLine(e, s) {
  return `${weightLabel(e.type, s.weight)}${NB}×${NB}${s.reps}`;
}

// ------------------------------------------------------------------ Icons
const svg = (d, extra, cap) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="${cap || 'round'}" stroke-linejoin="${cap ? 'miter' : 'round'}" aria-hidden="true"${extra ? ' ' + extra : ''}>${d}</svg>`;
const I = {
  check: svg('<path d="M5 12.5l4.5 4.5L19 7"/>'),
  cross: svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
  chevron: svg('<path d="M9 6l6 6-6 6"/>', 'class="chev"'),
  back: svg('<path d="M15 5l-7 7 7 7"/>', 'class="back-chev"'),
  plus: svg('<path d="M12 6v12M6 12h12"/>', '', 'square'),
  minus: svg('<path d="M6 12h12"/>', '', 'square'),
  up: svg('<path d="M12 19V5M5 12l7-7 7 7"/>'),
  down: svg('<path d="M12 5v14M5 12l7 7 7-7"/>'),
  home: svg('<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'),
  history: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  program: svg('<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>')
};

// ------------------------------------------------------------------ Navigation
// The tab each screen belongs to, and where "back" lands when there is no history.
const TAB_OF = { home: 'home', summary: 'home', history: 'history', workoutDetail: 'history', exerciseDetail: 'history', program: 'program', day: 'program', addExercise: 'program', exercise: 'program' };
const ROOT_OF = { workoutDetail: 'history', exerciseDetail: 'history', day: 'program', addExercise: 'program', exercise: 'program', workout: 'home', summary: 'home' };
const TAB_ROOTS = ['home', 'history', 'program'];

const screenEl = () => document.getElementById('screen');
function lockTaps(ms) { mem.lockUntil = Math.max(mem.lockUntil, Date.now() + ms); }

// A new exercise that was never given a name is removed again; it cannot have any history.
function dropBlankExercise(screen, params) {
  if (screen !== 'exercise' || !params) return;
  const ex = data.exercises[params.id];
  if (!ex || ex.name.trim()) return;
  const untouched = ex.type === 'dumbbell' && ex.sets === 3 && ex.reps === 8 && ex.increment === 2.5 && ex.rest === 90 && getProgress(ex.id).weight === 0;
  if (params.isNew && untouched) {
    data.days.forEach(d => { d.exercises = d.exercises.filter(id => id !== ex.id); });
    delete data.exercises[ex.id];
    delete data.progress[ex.id];
  } else {
    ex.name = 'New exercise';
  }
  save();
}
function leaveScreen() {
  const sc = screenEl();
  if (sc) {
    if (ui.screen === 'workout') mem.workoutScroll = sc.scrollTop;
    else if (TAB_ROOTS.includes(ui.screen)) mem.tabScroll[ui.screen] = sc.scrollTop;
  }
  dropBlankExercise(ui.screen, ui.params);
  mem.edit = null;
  mem.noteOpen = null;
  mem.confirm = null;
  mem.notice = null;
  mem.dayEdit = false;
  mem.removeArmed = null;
  mem.movedRow = null;
  if (ui.screen === 'home') { mem.pickDay = false; mem.selectedDay = null; }
}
function go(screen, params, push) {
  const from = { screen: ui.screen, params: ui.params || {}, scroll: screenEl() ? screenEl().scrollTop : 0 };
  leaveScreen();
  ui.stack = push ? (ui.stack || []).concat([from]).slice(-12) : [];
  mem.nav = push ? 'push' : (screen === 'workout' || screen === 'summary' ? 'rise' : 'tab');
  ui.screen = screen;
  ui.params = params || {};
  lockTaps(TAP_LOCK_NAV);
  mem.shownAt = Date.now();
  saveUI();
  let scroll = 0;
  if (!push && TAB_ROOTS.includes(screen)) scroll = mem.tabScroll[screen] || 0;
  render({ scroll });
  if (screen === 'workout') placeWorkoutScroll();
}
function back() {
  leaveScreen();
  const prev = (ui.stack || []).pop();
  mem.nav = 'pop';
  if (prev) { ui.screen = prev.screen; ui.params = prev.params || {}; }
  else { ui.screen = ROOT_OF[ui.screen] || 'home'; ui.params = {}; }
  lockTaps(TAP_LOCK_NAV);
  saveUI();
  render({ scroll: prev && prev.scroll ? prev.scroll : 0 });
}
function titleFor(screen, params) {
  switch (screen) {
    case 'home': return 'Home';
    case 'history': return 'History';
    case 'program': return 'Program';
    case 'day': return data.days[params.day] ? data.days[params.day].name : 'Day';
    case 'exerciseDetail': return 'Exercise';
    case 'workoutDetail': return 'Workout';
    default: return 'Back';
  }
}
function backBtn() {
  const stack = ui.stack || [];
  const prev = stack[stack.length - 1];
  const label = prev ? titleFor(prev.screen, prev.params || {}) : titleFor(ROOT_OF[ui.screen] || 'home', {});
  return `<button class="bar-btn bar-back" data-action="back">${I.back}<span>${esc(label.length > 14 ? 'Back' : label)}</span></button>`;
}
function tabbarHTML() {
  // The lit tab is the one the journey started from, so History > exercise > Edit keeps History lit.
  const root = (ui.stack || [])[0];
  const on = TAB_OF[root ? root.screen : ui.screen] || TAB_OF[ui.screen] || 'home';
  return `<nav class="tabbar" aria-label="Sections">${[['home', 'Home', I.home], ['history', 'History', I.history], ['program', 'Program', I.program]]
    .map(([k, label, icon]) => `<button class="tab${on === k ? ' on' : ''}" data-action="tab" data-screen="${k}"${on === k ? ' aria-current="page"' : ''}>${icon}<span>${label}</span></button>`).join('')}</nav>`;
}

// ------------------------------------------------------------------ Shared pieces of screens
const head = (eyebrow, title, sub) => `<header class="head">${eyebrow ? `<div class="eyebrow">${esc(eyebrow)}</div>` : ''}<div class="head-title${String(title).length > 16 ? ' is-long' : ''}" role="heading" aria-level="1">${esc(title)}</div>${sub ? `<div class="head-sub">${sub}</div>` : ''}</header>`;
const primary = (label, action, extra) => `<div class="actionbar"><button class="btn btn-primary" data-action="${action}"${extra || ''}>${esc(label)}</button></div>`;
const noticeHTML = () => mem.notice ? `<p class="notice${mem.notice.bad ? ' is-bad' : ''}" role="status">${esc(mem.notice.text)}</p>` : '';

// One row of a finished workout: what was done on the left, the outcome on the right.
function reportRow(e, withNext) {
  const r = resultInfo(e);
  return `<div class="row report"><div class="row-main"><span class="row-title">${esc(e.name)}</span>${r.cls === 'skip' ? '' : `<span class="row-sub did">${performed(e)}</span>`}${e.note ? `<span class="row-sub note-line">${esc(e.note)}</span>` : ''}</div>
    <div class="row-end stack">${withNext ? fig(e.type, e.nextWeight) : ''}<span class="result is-${r.cls}">${r.text}</span></div></div>`;
}

// The inline confirmation that replaces the bottom button. One pattern for every risky action.
function confirmBar() {
  const c = mem.confirm;
  const spec = {
    finish: { text: c.count ? `${plural(c.count, 'set')} not logged` : 'Every exercise skipped', no: 'Keep Going', yes: 'Finish Anyway' },
    discard: { text: 'Nothing logged', no: 'Keep Going', yes: 'Discard Workout' },
    reset: { text: 'Erase every workout, weight and setting?', no: 'Cancel', yes: 'Erase Everything' },
    replace: { text: data.sessions.length
      ? `Replace ${plural(data.sessions.length, 'workout')}${data.active ? ' and the one in progress' : ''} with ${plural(c.incoming || 0, 'workout')} from the file?`
      : 'Replace the workout in progress with the file?', no: 'Cancel', yes: 'Replace' }
  }[c.kind];
  return `<div class="actionbar is-confirm" id="actionbar" role="alertdialog" aria-label="${esc(spec.text)}"><div class="action-cap">${esc(spec.text)}</div>
    <div class="confirm-row"><button class="btn btn-neutral" data-action="confirm-no">${spec.no}</button><button class="btn btn-danger" data-action="confirm-yes">${spec.yes}</button></div></div>`;
}
function askConfirm(c) {
  c.at = Date.now();
  mem.confirm = c;
  render({ keepScroll: true });
  setTimeout(() => {
    if (mem.confirm === c) { mem.confirm = null; render({ keepScroll: true }); }
  }, CONFIRM_TIMEOUT);
}

// ------------------------------------------------------------------ Screens
// Each screen returns { title, left, right, body, bottom, tabs, band, bar }.
// Root screens set bar: false and open with a big heading instead of a title bar.
const VIEWS = {

  setup() {
    return {
      bar: false, tabs: false,
      body: `${head('Set up', 'Starting weights', 'Enter the weight you use now for each exercise. You can change them later in Program.')}
        ${loadFailed ? `<p class="notice is-bad">Your saved workouts could not be read. A copy was kept on this phone. Restore your last export, or save the damaged copy to send for repair.</p>
          <div class="card"><button class="row row-link" data-action="import"><div class="row-main"><span class="row-title is-accent">Restore from an exported file</span></div></button>${damagedCopy() ? '<button class="row row-link" data-action="export-damaged"><div class="row-main"><span class="row-title is-accent">Save the damaged copy</span></div></button>' : ''}</div>` : ''}
        <div class="card">${allExerciseIds().map(id => {
          const ex = data.exercises[id];
          return `<label class="row"><div class="row-main"><span class="row-title">${esc(ex.name)}</span><span class="row-sub">${target(ex.sets, ex.reps)}${ex.type === 'bodyweight' ? ' · added weight, 0 for bodyweight only' : ''}</span></div>
            <div class="row-end"><input class="num" type="text" inputmode="decimal" autocomplete="off" enterkeyhint="done" data-input="setup" data-id="${id}" value="${fmtW(getProgress(id).weight)}" aria-label="${esc(ex.name)}, weight in pounds"><span class="unit">lb</span></div></label>`;
        }).join('')}</div>
        ${loadFailed ? '' : '<button class="text-btn is-center" data-action="import">Restore from an exported file</button>'}
        ${noticeHTML()}`,
      bottom: mem.confirm ? confirmBar() : primary('Finish Set Up', 'finish-setup')
    };
  },

  home() {
    const a = data.active;
    if (a) {
      const c = workoutCounts(a);
      const started = sameDay(a.startedAt, Date.now()) ? fmtTime(a.startedAt) : fmtDate(a.startedAt);
      return {
        bar: false, tabs: true,
        body: `${head('In progress', a.dayName, `Started ${esc(started)} · ${c.logged} of ${c.total} sets done`)}
          <div class="card">${a.exercises.map(e => {
            const n = e.sets.filter(s => s.status !== 'pending').length;
            const end = e.skipped ? '<span class="row-note">Skipped</span>'
              : n === e.sets.length ? `<span class="row-check" role="img" aria-label="Done">${I.check}</span>`
              : `<span class="row-note${n ? ' is-strong' : ''}">${n} of ${e.sets.length}</span>`;
            return `<div class="row"><div class="row-main"><span class="row-title">${esc(e.name)}</span></div><div class="row-end">${end}</div></div>`;
          }).join('')}</div>`,
        bottom: primary('Resume Workout', 'resume')
      };
    }
    const next = nextDayIndex();
    const dayIndex = mem.selectedDay != null && data.days[mem.selectedDay] ? mem.selectedDay : next;
    const day = data.days[dayIndex];
    if (!day) return { bar: false, tabs: true, body: '<p class="empty">No days in the program.</p>' };
    const ids = day.exercises.filter(id => data.exercises[id]);
    const last = data.sessions[data.sessions.length - 1];
    const lastLine = last ? `Last workout: ${esc(last.dayName)}, ${esc(dayLabel(last.finishedAt).replace(/^(Today|Yesterday)$/, m => m.toLowerCase()))}` : '';
    return {
      bar: false, tabs: true,
      body: `${head(dayIndex === next ? 'Next' : `Instead of ${data.days[next].name}`, day.name, lastLine)}
        <div class="card">${ids.map(id => {
          const ex = data.exercises[id];
          return `<div class="row"><div class="row-main"><span class="row-title">${esc(ex.name)}</span><span class="row-sub">${target(ex.sets, ex.reps)}</span></div><div class="row-end">${fig(ex.type, getProgress(id).weight)}</div></div>`;
        }).join('') || '<div class="row"><div class="row-main"><span class="row-sub">No exercises on this day yet. Add some under Program.</span></div></div>'}</div>
        ${mem.pickDay
          ? `<div class="segmented" role="group" aria-label="Day">${data.days.map((d, i) => `<button class="seg${i === dayIndex ? ' on' : ''}" data-action="select-day" data-day="${i}" aria-pressed="${i === dayIndex}">${esc(d.name)}${i === next ? ' · next' : ''}</button>`).join('')}</div>`
          : `<button class="text-btn is-center has-chev" data-action="pick-day">Pick a different day${I.chevron}</button>`}`,
      bottom: primary(`Start ${day.name}`, 'start', ` data-day="${dayIndex}"${ids.length ? '' : ' disabled'}`)
    };
  },

  workout() {
    const a = data.active;
    if (!a) { ui.screen = 'home'; return VIEWS.home(); }
    const ns = nextSet();
    const c = workoutCounts(a);
    return {
      title: a.dayName, tabs: false, band: true,
      left: `<button class="bar-btn bar-back" data-action="tab" data-screen="home">${I.back}<span>Home</span></button>`,
      right: `<span class="bar-note" id="elapsed" aria-label="Time since start">${fmtDuration(a.startedAt, Date.now())}</span>`,
      body: a.exercises.map((e, i) => exerciseCard(e, i, ns)).join('') +
        (c.pending ? `<button class="text-btn is-center finish-early" data-action="finish-early">Finish Early</button>` : ''),
      bottom: mem.confirm ? confirmBar() : workoutBar()
    };
  },

  summary() {
    const s = data.sessions.find(x => x.id === ui.params.id);
    if (!s) { ui.screen = 'home'; return VIEWS.home(); }
    return {
      bar: false, tabs: false,
      body: `${head('Saved', s.dayName, `${esc(fmtDate(s.finishedAt))} · ${fmtDuration(s.startedAt, s.finishedAt)}`)}
        <div class="list-cap"><span>Exercise</span><span>Next weight</span></div>
        <div class="card">${s.exercises.map(e => reportRow(e, true)).join('')}</div>`,
      bottom: primary('Done', 'tab', ' data-screen="home"')
    };
  },

  history() {
    const tab = ui.historyTab === 'exercises' ? 'exercises' : 'workouts';
    let list;
    if (tab === 'workouts') {
      const groups = [];
      data.sessions.slice().reverse().forEach(s => {
        const d = new Date(s.finishedAt);
        const key = d.getFullYear() * 12 + d.getMonth();
        if (!groups.length || groups[groups.length - 1].key !== key) {
          groups.push({ key, label: d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }), items: [] });
        }
        groups[groups.length - 1].items.push(s);
      });
      list = groups.length ? groups.map(g => `<h2 class="section">${esc(g.label)}</h2><div class="card">${g.items.map(s =>
        `<button class="row row-link" data-action="go" data-screen="workoutDetail" data-id="${s.id}"><div class="row-main"><span class="row-title">${esc(dayLabel(s.finishedAt))}</span><span class="row-sub">${fmtDuration(s.startedAt, s.finishedAt)}</span></div><div class="row-end"><span class="row-value">${esc(s.dayName)}</span>${I.chevron}</div></button>`).join('')}</div>`).join('')
        : '<p class="empty">No workouts yet.</p>';
    } else {
      list = `<div class="list-cap"><span>Exercise</span><span>Next weight</span></div><div class="card">${allExerciseIds().map(id => {
        const ex = data.exercises[id];
        const entries = sessionsFor(id);
        const lastOne = entries[entries.length - 1];
        const sub = lastOne ? `${esc(fmtDate(lastOne.session.finishedAt, true))} · ${performed(lastOne.e)}` : 'Not done yet';
        return `<button class="row row-link" data-action="go" data-screen="exerciseDetail" data-id="${id}"><div class="row-main"><span class="row-title">${esc(ex.name)}</span><span class="row-sub did">${sub}</span></div><div class="row-end">${fig(ex.type, getProgress(id).weight)}${I.chevron}</div></button>`;
      }).join('')}</div>`;
    }
    return {
      bar: false, tabs: true,
      body: `${head('', 'History')}
        <div class="segmented" role="group" aria-label="View"><button class="seg${tab === 'workouts' ? ' on' : ''}" data-action="history-tab" data-tab="workouts" aria-pressed="${tab === 'workouts'}">Workouts</button><button class="seg${tab === 'exercises' ? ' on' : ''}" data-action="history-tab" data-tab="exercises" aria-pressed="${tab === 'exercises'}">Exercises</button></div>${list}`
    };
  },

  workoutDetail() {
    const s = data.sessions.find(x => x.id === ui.params.id);
    if (!s) { ui.screen = 'history'; return VIEWS.history(); }
    return {
      title: '', tabs: true, left: backBtn(),
      body: `${head('', s.dayName, `${esc(fmtDate(s.finishedAt))} · ${esc(fmtTime(s.startedAt))} · ${fmtDuration(s.startedAt, s.finishedAt)}`)}
        <div class="card">${s.exercises.map(e => reportRow(e, false)).join('')}</div>`
    };
  },

  exerciseDetail() {
    const id = ui.params.id;
    const ex = data.exercises[id];
    if (!ex) { ui.screen = 'history'; return VIEWS.history(); }
    const entries = sessionsFor(id);
    const best = bestFor(entries);
    const days = daysWith(id);
    const manyDays = new Set(entries.map(x => x.session.dayName)).size > 1;
    return {
      title: '', tabs: true, left: backBtn(),
      right: `<button class="bar-btn" data-action="go" data-screen="exercise" data-id="${id}">Edit</button>`,
      body: `${head('', ex.name, `${target(ex.sets, ex.reps)} · ${esc(days.length ? joinAnd(days) : 'Not in the program')}`)}
        <div class="card">
          <div class="row"><div class="row-main"><span class="row-title">Next weight</span></div><div class="row-end">${fig(ex.type, getProgress(id).weight)}</div></div>
          <div class="row"><div class="row-main"><span class="row-title">Best set</span>${best ? `<span class="row-sub">${esc(fmtDate(best.at))}</span>` : ''}</div><div class="row-end">${best ? fig(ex.type, best.weight, `× ${best.reps}`) : '<span class="row-note">None yet</span>'}</div></div>
        </div>
        ${entries.length >= 2 ? `<div class="card chart-card"><h2 class="chart-title">${ex.type === 'bodyweight' ? 'Added weight (lb)' : 'Weight used (lb)'}</h2>${chartSVG(entries)}</div>` : ''}
        ${entries.length ? `<h2 class="section">Workouts</h2><div class="card">${entries.slice().reverse().map(({ session, e }) => {
          const r = resultInfo(e);
          const bits = [esc(fmtDate(session.finishedAt))];
          if (manyDays) bits.push(esc(session.dayName));
          if (r.cls !== 'up') bits.push(`<span class="result is-${r.cls}">${r.text}</span>`);
          return `<button class="row row-link" data-action="go" data-screen="workoutDetail" data-id="${session.id}"><div class="row-main"><span class="row-title did">${performed(e)}</span><span class="row-sub">${bits.join(' · ')}</span>${e.note ? `<span class="row-sub note-line">${esc(e.note)}</span>` : ''}</div><div class="row-end">${I.chevron}</div></button>`;
        }).join('')}</div>` : '<p class="empty">No workouts yet.</p>'}`
    };
  },

  program() {
    const n = data.sessions.length;
    return {
      bar: false, tabs: true,
      body: `${head('', 'Program')}
        <div class="card">${data.days.map((d, i) => {
          const names = d.exercises.filter(id => data.exercises[id]).map(id => data.exercises[id].name);
          return `<button class="row row-link" data-action="go" data-screen="day" data-day="${i}"><div class="row-main"><span class="row-title">${esc(d.name)}</span><span class="row-sub one-line">${names.length ? esc(names.join(', ')) : 'No exercises'}</span></div><div class="row-end">${I.chevron}</div></button>`;
        }).join('')}</div>
        <h2 class="section">Settings</h2>
        <div class="card">
          <label class="row"><div class="row-main"><span class="row-title">Timer sound</span><span class="row-sub">A tone when a rest ends. Silent when the ringer is off.</span></div><div class="row-end"><input type="checkbox" class="switch" role="switch" data-change="sound"${data.settings.sound ? ' checked' : ''} aria-label="Timer sound"></div></label>
        </div>
        <h2 class="section">Backup</h2>
        <div class="card">
          <button class="row row-link" data-action="export"><div class="row-main"><span class="row-title is-accent">Export data</span><span class="row-sub">Save a copy of ${n === 1 ? 'your 1 workout' : `all ${n} workouts`} to Files or iCloud</span></div></button>
          <button class="row row-link" data-action="import"><div class="row-main"><span class="row-title is-accent">Import data</span><span class="row-sub">Replaces everything on this phone</span></div></button>
          ${damagedCopy() ? '<button class="row row-link" data-action="export-damaged"><div class="row-main"><span class="row-title is-accent">Save the damaged copy</span><span class="row-sub">Saved data that could not be read once</span></div></button>' : ''}
        </div>
        ${noticeHTML()}
        <div class="card"><button class="row row-link" data-action="reset"><div class="row-main"><span class="row-title is-danger">Reset all data</span></div></button></div>
        <p class="footnote">Stored on this phone only. Export a copy now and then.</p>
        <p class="footnote">Version ${APP_VERSION}</p>`,
      bottom: mem.confirm ? confirmBar() : ''
    };
  },

  day() {
    const i = ui.params.day;
    const d = data.days[i];
    if (!d) { ui.screen = 'program'; return VIEWS.program(); }
    const edit = !!mem.dayEdit;
    const ids = d.exercises.filter(id => data.exercises[id]);
    return {
      title: d.name, tabs: true, left: backBtn(),
      right: ids.length ? `<button class="bar-btn" data-action="toggle-day-edit">${edit ? 'Done' : 'Edit'}</button>` : '',
      body: `${ids.length ? `<div class="card">${ids.map((id, k) => {
          const ex = data.exercises[id];
          if (!edit) {
            return `<button class="row row-link" data-action="go" data-screen="exercise" data-id="${id}"><div class="row-main"><span class="row-title">${esc(ex.name)}</span><span class="row-sub">${target(ex.sets, ex.reps)}</span></div><div class="row-end">${fig(ex.type, getProgress(id).weight)}${I.chevron}</div></button>`;
          }
          const armed = mem.removeArmed === k;
          return `<div class="row row-edit${mem.movedRow === k ? ' is-moved' : ''}">
            <button class="icon-btn remove" data-action="arm-remove" data-index="${k}" aria-label="Remove ${esc(ex.name)}"><span class="remove-dot">${I.minus}</span></button>
            <div class="row-main"><span class="row-title one-line">${esc(ex.name)}</span></div>
            ${armed
              ? `<button class="btn-remove" data-action="remove-ex" data-day="${i}" data-id="${id}">Remove</button>`
              : `<button class="icon-btn" data-action="move-ex" data-day="${i}" data-index="${k}" data-id="${id}" data-dir="-1" aria-label="Move ${esc(ex.name)} up"${k === 0 ? ' disabled' : ''}>${I.up}</button><button class="icon-btn" data-action="move-ex" data-day="${i}" data-index="${k}" data-id="${id}" data-dir="1" aria-label="Move ${esc(ex.name)} down"${k === ids.length - 1 ? ' disabled' : ''}>${I.down}</button>`}
          </div>`;
        }).join('')}</div>` : '<p class="empty">No exercises on this day.</p>'}
        <button class="btn btn-secondary" data-action="go" data-screen="addExercise" data-day="${i}">Add Exercise</button>`
    };
  },

  addExercise() {
    const i = ui.params.day;
    const d = data.days[i];
    if (!d) { ui.screen = 'program'; return VIEWS.program(); }
    const others = Object.values(data.exercises).filter(ex => !d.exercises.includes(ex.id)).sort((a, b) => a.name.localeCompare(b.name));
    return {
      title: 'Add Exercise', tabs: true, left: backBtn(),
      body: `<div class="card"><button class="row row-link" data-action="new-exercise" data-day="${i}"><div class="row-main"><span class="row-title is-accent">New exercise</span></div><div class="row-end"><span class="row-plus">${I.plus}</span></div></button></div>
        ${others.length ? `<h2 class="section">Add an existing exercise</h2><div class="card">${others.map(ex => {
          const on = daysWith(ex.id);
          return `<button class="row row-link" data-action="add-existing" data-day="${i}" data-id="${ex.id}" aria-label="Add ${esc(ex.name)}"><div class="row-main"><span class="row-title">${esc(ex.name)}</span><span class="row-sub">${target(ex.sets, ex.reps)} · ${typeOf(ex.type).label}${on.length ? ` · on ${esc(joinAnd(on))}` : ''}</span></div><div class="row-end"><span class="row-plus is-quiet">${I.plus}</span></div></button>`;
        }).join('')}</div>` : ''}`
    };
  },

  exercise() {
    const id = ui.params.id;
    const ex = data.exercises[id];
    if (!ex) { ui.screen = 'program'; return VIEWS.program(); }
    const prog = getProgress(id);
    const on = daysWith(id);
    // One number row: label, the value (typed or shown), and a joined minus / plus control.
    const field = (label, name, value, o) => `<div class="row row-field"><div class="row-main"><span class="row-title">${label}</span></div>
      <div class="row-end">${o.typed
        ? `<input class="mini-input" type="text" maxlength="6" inputmode="${o.whole ? 'numeric' : 'decimal'}"${o.whole ? ' pattern="[0-9]*"' : ''} autocomplete="off" enterkeyhint="done" data-input="ex-value" data-id="${id}" data-field="${name}" value="${value}" aria-label="${label}">`
        : `<span class="mini-input mini-value" aria-label="${label}">${value}</span>`}<span class="unit unit-slot">${o.unit || ''}</span>
        <span class="mini-step"><button class="mini-btn" data-action="ex-step" data-id="${id}" data-field="${name}" data-dir="-1" aria-label="Less: ${label}"${o.atMin ? ' disabled' : ''}>${I.minus}</button><button class="mini-btn" data-action="ex-step" data-id="${id}" data-field="${name}" data-dir="1" aria-label="More: ${label}"${o.atMax ? ' disabled' : ''}>${I.plus}</button></span></div></div>`;
    return {
      title: ui.params.isNew ? 'New Exercise' : 'Edit Exercise', tabs: true, left: backBtn(),
      body: `<div class="card">
          <label class="field"><span class="field-label">Name</span><input class="field-input" type="text" autocomplete="off" autocapitalize="words" autocorrect="off" spellcheck="false" maxlength="60" enterkeyhint="done" data-input="ex-name" data-id="${id}" value="${esc(ex.name)}" placeholder="Exercise name"></label>
          <label class="row"><div class="row-main"><span class="row-title">Equipment</span></div><div class="row-end"><select class="select" data-change="ex-type" data-id="${id}" aria-label="Equipment">${Object.keys(TYPES).map(t => `<option value="${t}"${t === ex.type ? ' selected' : ''}>${TYPES[t].label}</option>`).join('')}</select></div></label>
        </div>
        <div class="card">
          ${field('Sets', 'sets', ex.sets, { typed: true, whole: true, atMin: ex.sets <= 1, atMax: ex.sets >= 20 })}
          ${field('Reps', 'reps', ex.reps, { typed: true, whole: true, atMin: ex.reps <= 1, atMax: ex.reps >= 100 })}
          ${field('Add each time', 'increment', fmtW(ex.increment), { typed: true, unit: 'lb', atMin: ex.increment <= 1 })}
          ${field('Rest', 'rest', ex.rest ? fmtRest(ex.rest) : 'Off', { atMin: ex.rest <= 0, atMax: ex.rest >= 1800 })}
        </div>
        <div class="card">${field('Next weight', 'weight', fmtW(prog.weight), { typed: true, unit: 'lb', atMin: prog.weight <= 0 })}</div>
        <p class="footnote">${on.length > 1 ? `Shared by ${esc(joinAnd(on))}. ` : ''}${ex.type === 'bodyweight' ? 'Log the added weight; 0 means bodyweight only. ' : ''}Changes apply from the next workout.</p>`
    };
  }
};

// ---- the workout screen
function exerciseCard(e, i, ns) {
  const loggedCount = e.sets.filter(s => s.status !== 'pending').length;
  if (e.skipped) {
    return `<section class="card ex is-skipped" data-ex="${i}"><div class="ex-head"><div class="ex-text"><h2 class="ex-title">${esc(e.name)}</h2><div class="ex-sub">Skipped${loggedCount ? `. ${plural(loggedCount, 'logged set')} will not count.` : ''}</div></div><button class="quiet-btn" data-action="unskip" data-ex="${i}">Undo</button></div></section>`;
  }
  const done = loggedCount === e.sets.length;
  const last = lastResult(e.exerciseId);
  const noteOpen = mem.noteOpen === i;
  return `<section class="card ex${done ? ' is-done' : ''}${ns && ns.ex === i ? ' is-current' : ''}" data-ex="${i}" aria-label="${esc(e.name)}">
    <div class="ex-head"><div class="ex-text"><h2 class="ex-title">${esc(e.name)}${done ? `<span class="ex-tick" role="img" aria-label="All sets logged">${I.check}</span>` : ''}</h2>
      <div class="ex-sub ex-plan"><span>${target(e.targetSets, e.targetReps)} at ${esc(weightLabel(e.type, e.recommended))}</span><span>${last ? `Last: ${performed(last)}` : 'No earlier workout'}</span></div></div></div>
    <div class="sets"><div class="set-caps" aria-hidden="true"><span>Set</span><span>${e.type === 'bodyweight' ? 'Added (lb)' : 'Weight (lb)'}</span><span>Reps</span><span></span></div>${e.sets.map((s, j) => setRow(e, i, s, j, ns)).join('')}</div>
    ${e.note && !noteOpen ? `<div class="ex-note">${esc(e.note)}</div>` : ''}
    <div class="ex-foot">${noteOpen
      ? `<input class="note-input" type="text" placeholder="Note" autocomplete="off" enterkeyhint="done" maxlength="200" data-input="note" data-ex="${i}" value="${esc(e.note)}" aria-label="Note for ${esc(e.name)}">`
      : `<button class="text-btn" data-action="note" data-ex="${i}">${e.note ? 'Edit note' : 'Add note'}</button>${done ? '' : `<button class="text-btn" data-action="skip" data-ex="${i}">Skip exercise</button>`}`}</div>
  </section>`;
}
const weightAria = (e, s, j) => `Set ${j + 1} ${e.type === 'bodyweight' ? 'added weight' : 'weight'}, ${fmtW(s.weight)} pounds. Change`;
const setState = (s, isNext) => `is-${s.status}${isNext ? ' is-next' : ''}`;
const logIcon = s => s.status === 'done' ? I.check : s.status === 'missed' ? I.cross : '';
const logLabel = (s, j) => s.status === 'pending' ? `Log set ${j + 1}` : `Set ${j + 1} ${s.status === 'done' ? 'done' : 'missed'}. Tap to undo`;
function setRow(e, i, s, j, ns) {
  const key = `${i}-${j}`;
  const editing = mem.edit && mem.edit.ex === i && mem.edit.set === j ? mem.edit.field : null;
  const isNext = !!ns && ns.ex === i && ns.set === j;
  const plus = e.type === 'bodyweight' ? '+' : '';
  return `<div class="set ${setState(s, isNext)}${mem.flash === key ? ' is-flash' : ''}" data-row="${key}">
      <div class="set-n" aria-hidden="true">${j + 1}</div>
      <button class="val${editing === 'weight' ? ' on' : ''}" data-action="edit" data-ex="${i}" data-set="${j}" data-field="weight" aria-label="${weightAria(e, s, j)}"><span class="val-num${(plus + fmtW(s.weight)).length >= 5 ? ' is-long' : ''}">${plus}${fmtW(s.weight)}</span></button>
      <button class="val${editing === 'reps' ? ' on' : ''}" data-action="edit" data-ex="${i}" data-set="${j}" data-field="reps" aria-label="Set ${j + 1} reps, ${s.reps}. Change"><span class="val-num${String(s.reps).length >= 3 ? ' is-long' : ''}">${s.reps}</span></button>
      <button class="log" data-action="toggle-set" data-ex="${i}" data-set="${j}" aria-label="${logLabel(s, j)}"><span class="log-ring">${logIcon(s)}</span></button>
    </div>
    ${editing ? stepperHTML(e, i, s, j, editing) : ''}`;
}
function stepperHTML(e, i, s, j, field) {
  const value = field === 'weight' ? s.weight : s.reps;
  const by = field === 'weight' ? fmtW(typeOf(e.type).step) : '1';
  const unit = field === 'weight' ? 'lb' : 'reps';
  return `<div class="stepper" data-for="${i}-${j}"><button class="step" data-action="step" data-ex="${i}" data-set="${j}" data-field="${field}" data-dir="-1" aria-label="${by} ${unit} less"${value <= 0 ? ' disabled' : ''}>&minus;${by}</button>
    <label class="step-field"><input class="step-input" type="text" inputmode="${field === 'reps' ? 'numeric' : 'decimal'}"${field === 'reps' ? ' pattern="[0-9]*"' : ''} autocomplete="off" enterkeyhint="done" data-input="set-value" data-ex="${i}" data-set="${j}" data-field="${field}" value="${field === 'weight' ? fmtW(value) : value}" aria-label="${field === 'weight' ? 'Weight in pounds' : 'Reps'}"><span class="step-unit">${unit}</span></label>
    <button class="step" data-action="step" data-ex="${i}" data-set="${j}" data-field="${field}" data-dir="1" aria-label="${by} ${unit} more">+${by}</button></div>`;
}
// Redraw one exercise's rows in place (used while typing or stepping, so focus and the keyboard stay).
function refreshSetRows(i) {
  const e = data.active && data.active.exercises[i];
  if (!e) return;
  const ns = nextSet();
  const plus = e.type === 'bodyweight' ? '+' : '';
  e.sets.forEach((s, j) => {
    const row = document.querySelector(`.set[data-row="${i}-${j}"]`);
    if (!row) return;
    const nums = row.querySelectorAll('.val-num');
    nums[0].textContent = plus + fmtW(s.weight);
    nums[0].classList.toggle('is-long', nums[0].textContent.length >= 5);
    nums[1].textContent = s.reps;
    nums[1].classList.toggle('is-long', String(s.reps).length >= 3);
    const vals = row.querySelectorAll('.val');
    vals[0].setAttribute('aria-label', weightAria(e, s, j));
    vals[1].setAttribute('aria-label', `Set ${j + 1} reps, ${s.reps}. Change`);
    row.className = `set ${setState(s, !!ns && ns.ex === i && ns.set === j)}`;
    row.querySelector('.log-ring').innerHTML = logIcon(s);
    row.querySelector('.log').setAttribute('aria-label', logLabel(s, j));
  });
  const stepper = document.querySelector('.stepper');
  if (stepper && mem.edit && mem.edit.ex === i) {
    const s = e.sets[mem.edit.set];
    const value = mem.edit.field === 'weight' ? s.weight : s.reps;
    const input = stepper.querySelector('.step-input');
    if (document.activeElement !== input) input.value = mem.edit.field === 'weight' ? fmtW(value) : value;
    stepper.querySelector('.step').disabled = value <= 0;
  }
}
// The bottom of the workout screen: a caption and the one big button that does the next right thing.
function workoutBar() {
  const a = data.active;
  const c = workoutCounts(a);
  const ns = nextSet();
  const said = mem.loggedLabel && Date.now() < mem.loggedLabel.until ? mem.loggedLabel.text : null;
  let button;
  if (said) button = `<button class="btn btn-primary is-said" disabled>${esc(said)}</button>`;
  else if (ns) button = `<button class="btn btn-primary" data-action="log-next" aria-label="Log set ${ns.set + 1} of ${a.exercises[ns.ex].sets.length}, ${esc(a.exercises[ns.ex].name)}">Log Set ${ns.set + 1} of ${a.exercises[ns.ex].sets.length}</button>`;
  else button = `<button class="btn btn-primary" data-action="finish">Finish Workout</button>`;
  const cap = c.total ? `${c.logged} of ${c.total} sets logged` : 'Every exercise skipped';
  return `<div class="actionbar" id="actionbar"><div class="action-cap">${cap}</div>${button}</div>`;
}
function paintWorkoutBar() {
  const bar = document.getElementById('actionbar');
  if (!bar || ui.screen !== 'workout' || mem.confirm || !data.active) return;
  bar.outerHTML = workoutBar();
}

// The status band: what to do next, the rest countdown, or that the rest is over. Always present,
// always the same height, so nothing on the screen moves when its state changes.
function bandInfo() {
  const a = data.active;
  if (!a) return null;
  const ns = nextSet();
  const e = ns ? a.exercises[ns.ex] : null;
  const s = ns ? e.sets[ns.set] : null;
  const where = ns ? `Set ${ns.set + 1} of ${e.sets.length}` : '';
  const none = workoutCounts(a).total === 0 ? 'Every exercise skipped' : 'All sets logged';
  const t = a.timer;
  if (t) {
    const ms = t.endsAt - Date.now();
    if (ms > 0) return { state: 'rest', cap: ns ? `Rest · then ${e.name}` : 'Rest', big: esc(fmtRest(Math.ceil(ms / 1000))), part: clamp(ms / (t.total * 1000), 0, 1) };
    return { state: 'over', cap: `Rest over ${fmtRest(Math.floor(-ms / 1000))}${ns ? ` · ${e.name} · ${where}` : ''}`, big: ns ? bigSet(e, s) : none, part: 0 };
  }
  if (ns) return { state: 'next', cap: `${e.name} · ${where}`, big: bigSet(e, s), part: 0 };
  return { state: 'done', cap: 'Ready to finish', big: none, part: 0 };
}
// "165 lb × 5" for the band, with the unit and the sign set smaller.
function bigSet(e, s) {
  const w = Number(s.weight) || 0;
  const weight = e.type === 'bodyweight' && w === 0 ? 'Bodyweight' : `${e.type === 'bodyweight' ? '+' : ''}${fmtW(w)}<span class="band-u">${NB}lb</span>`;
  return `${weight}<span class="band-u">${NB}×${NB}</span>${s.reps}`;
}
function bandHTML() {
  return `<section class="band" id="band" aria-label="Status">
    <div class="band-text"><div class="band-cap" id="band-cap"></div><div class="band-big" id="band-big" role="timer"></div></div>
    <div class="band-actions"><button class="band-btn" data-action="timer-add">+30 sec</button><button class="band-btn" data-action="timer-end">End rest</button></div>
    <div class="band-track" aria-hidden="true"><div class="band-fill" id="band-fill"></div></div>
  </section>`;
}
function setText(id, text) {
  const el = document.getElementById(id);
  if (el && el.textContent !== text) el.textContent = text;
}
function setHTML(id, html) {
  const el = document.getElementById(id);
  if (el && el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
}
function paintBand() {
  const band = document.getElementById('band');
  const b = bandInfo();
  if (!band || !b) return;
  if (band.dataset.state !== b.state) {
    band.dataset.state = b.state;
    band.className = `band is-${b.state}`;
  }
  setText('band-cap', b.cap);
  setHTML('band-big', b.big);
  const fill = document.getElementById('band-fill');
  if (fill) fill.style.transform = `scaleX(${b.part})`;
  if (data.active) setText('elapsed', fmtDuration(data.active.startedAt, Date.now()));
}

// Line chart of the weight used in each workout (one series, so no legend). Gridlines sit on round
// values and the points are spaced by date.
function chartSVG(entries) {
  const W = 340, H = 176, R = 14, T = 12, B = 30;
  const inc = Math.max(Number(entries[entries.length - 1].e.increment) || 2.5, 2.5);
  const pts = entries.map(x => Number(x.e.weightUsed) || 0);
  const times = entries.map(x => x.session.finishedAt);
  const n = pts.length, min = Math.min(...pts), max = Math.max(...pts);
  let step = 1000, lo = 0, hi = 1000;
  for (const s of [2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000]) {
    if (s < inc) continue;
    lo = Math.floor(min / s) * s;
    hi = Math.ceil(max / s) * s;
    if (hi === lo) hi = lo + s;
    if ((hi - lo) / s <= 3) { step = s; break; }
  }
  while ((hi - lo) / step < 2) { if (lo - step >= 0) lo -= step; else hi += step; }
  const lines = [];
  for (let v = lo; v <= hi + 1e-9; v += step) lines.push(P.clean(v));
  const L = 14 + Math.max(...lines.map(v => fmtW(v).length)) * 8.5;
  const t0 = times[0], t1 = times[n - 1];
  const x = i => L + (n === 1 ? (W - L - R) / 2 : (t1 > t0 ? (times[i] - t0) / (t1 - t0) : i / (n - 1)) * (W - L - R));
  const y = v => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  const path = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const showDots = n <= 24;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${plural(n, 'workout')}, from ${fmtW(pts[0])} to ${fmtW(pts[n - 1])} pounds">
    ${lines.map(g => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(g).toFixed(1)}" y2="${y(g).toFixed(1)}"/><text x="${L - 8}" y="${(y(g) + 4.5).toFixed(1)}" text-anchor="end">${fmtW(g)}</text>`).join('')}
    <path class="line" d="${path}"/>
    ${pts.map((v, i) => (showDots || i === n - 1) ? `<circle class="dot${i === n - 1 ? ' is-last' : ''}" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="4.5"/>` : '').join('')}
    <text x="${L}" y="${H - 8}">${esc(fmtDate(t0, true))}</text>
    <text x="${W - R}" y="${H - 8}" text-anchor="end">${esc(fmtDate(t1, true))}</text>
  </svg>`;
}

// ------------------------------------------------------------------ Drawing
const app = document.getElementById('app');
function render(opts) {
  opts = opts || {};
  renderCount++;
  const prev = screenEl();
  const keepTop = opts.keepScroll && prev ? prev.scrollTop : null;
  const view = (VIEWS[ui.screen] || VIEWS.home)();
  const nav = mem.nav && !reducedMotion() ? ` nav-${mem.nav}` : '';
  mem.nav = null;
  app.innerHTML =
    `<div class="statusbar" aria-hidden="true"></div>` +
    (view.bar === false ? '' : `<header class="topbar"><div class="bar-side bar-left">${view.left || ''}</div><h1 class="bar-title">${esc(view.title || '')}</h1><div class="bar-side bar-right">${view.right || ''}</div></header>`) +
    (view.band ? bandHTML() : '') +
    `<main class="screen${ui.screen === 'workout' ? ' screen-workout' : ''}${view.bar === false ? ' is-root' : ''}${nav}" id="screen" data-screen="${esc(ui.screen)}"><div class="screen-inner">${view.body}</div></main>` +
    `<div class="chrome">${view.bottom || ''}${view.tabs ? tabbarHTML() : ''}</div>`;
  const sc = screenEl();
  if (keepTop != null) sc.scrollTop = keepTop;
  else if (typeof opts.scroll === 'number') sc.scrollTop = opts.scroll;
  mem.flash = null;
  tick();
  updateWakeLock();
}
// On a fresh visit to the workout screen, show the exercise being worked on, not the top of the list.
function placeWorkoutScroll() {
  const sc = screenEl();
  if (!sc || ui.screen !== 'workout') return;
  if (mem.workoutScroll != null) { sc.scrollTop = mem.workoutScroll; return; }
  const ns = nextSet();
  if (ns && ns.ex > 0) scrollCardToTop(ns.ex, false);
}
function scrollCardToTop(i, smooth) {
  const sc = screenEl();
  const card = sc && sc.querySelector(`.ex[data-ex="${i}"]`);
  if (!card) return;
  const top = Math.max(0, card.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 12);
  if (Math.abs(top - sc.scrollTop) < 2) return;
  if (smooth && !reducedMotion() && sc.scrollTo) sc.scrollTo({ top, behavior: 'smooth' });
  else sc.scrollTop = top;
}
// After an exercise is finished or skipped, bring the next unfinished one to the top of the list.
function autoAdvance() {
  const ns = nextSet();
  if (!ns) return;
  const t0 = Date.now();
  setTimeout(() => {
    if (ui.screen !== 'workout' || mem.listTouchedAt > t0 || mem.edit || mem.noteOpen != null) return;
    mem.lastLogAt = Date.now();   // rings stay inert while the list is moving
    scrollCardToTop(ns.ex, true);
  }, 450);
}

// ------------------------------------------------------------------ Workout actions
function startWorkout(dayIndex) {
  const day = data.days[dayIndex];
  if (!day) return;
  const ids = day.exercises.filter(id => data.exercises[id]);
  if (!ids.length) return;
  data.active = {
    id: uid(), dayIndex, dayName: day.name, startedAt: Date.now(), timer: null,
    exercises: ids.map(id => {
      const ex = data.exercises[id];
      const w = getProgress(id).weight;
      return {
        exerciseId: id, name: ex.name, type: ex.type, targetSets: ex.sets, targetReps: ex.reps,
        increment: ex.increment, rest: ex.rest, recommended: w, skipped: false, note: '',
        sets: Array.from({ length: ex.sets }, () => ({ weight: w, reps: ex.reps, status: 'pending' }))
      };
    })
  };
  ui.focusEx = 0;
  mem.workoutScroll = null;
  mem.loggedLabel = null;
  save();
  go('workout');
}

// Changing a set's weight also moves the later, still unlogged sets that had the same weight.
function setWeight(e, j, w) {
  const old = e.sets[j].weight;
  e.sets[j].weight = w;
  for (let k = j + 1; k < e.sets.length; k++) {
    if (e.sets[k].status === 'pending' && e.sets[k].weight === old) e.sets[k].weight = w;
  }
}
function relog(e, s) {
  if (s.status !== 'pending') s.status = s.reps >= e.targetReps ? 'done' : 'missed';
}
// Log one set exactly as its row shows it. The ring and the big button both end up here.
function logSet(i, j) {
  const a = data.active;
  const e = a.exercises[i];
  const s = e.sets[j];
  const key = `${i}-${j}`;
  s.status = s.reps >= e.targetReps ? 'done' : 'missed';
  ui.focusEx = i;
  mem.edit = null;
  mem.noteOpen = null;
  mem.lastLogAt = Date.now();
  mem.flash = key;
  mem.loggedLabel = { text: `Set ${j + 1} logged`, until: Date.now() + LOGGED_LABEL };
  if (workoutCounts(a).pending > 0 && e.rest > 0) {
    // Keep the rest this one replaces, so undoing a mis-tap brings it back.
    const old = a.timer;
    const prev = old && old.endsAt > Date.now() - REST_OVER_KEEP ? { endsAt: old.endsAt, total: old.total, fired: old.fired, from: old.from } : null;
    a.timer = { endsAt: Date.now() + e.rest * 1000, total: e.rest, fired: false, from: key, prev };
  } else {
    a.timer = null;             // nothing left to rest for
  }
  save();
  saveUI();
  haptic();
  unlockAudio();              // this tap starts the rest, so make sure its tone can play
  render({ keepScroll: true });
  setTimeout(paintWorkoutBar, LOGGED_LABEL + 30);
  if (e.sets.every(x => x.status !== 'pending')) autoAdvance();
}
function unlogSet(i, j) {
  const a = data.active;
  a.exercises[i].sets[j].status = 'pending';
  if (a.timer && a.timer.from === `${i}-${j}`) a.timer = a.timer.prev || null;   // that rest never began
  ui.focusEx = i;
  mem.lastLogAt = Date.now();
  mem.loggedLabel = null;
  save();
  saveUI();
  render({ keepScroll: true });
}

function finishWorkout() {
  const a = data.active;
  if (!a) return;
  if (!hasLoggedSets(a)) { askConfirm({ kind: 'discard' }); return; }
  const finishedAt = Date.now();
  const exercises = a.exercises.map(e => {
    const prog = getProgress(e.exerciseId);
    const judged = e.skipped ? null : P.judgeExercise(e.sets, e.targetReps);
    if (!judged) return Object.assign({}, e, { skipped: true, result: 'skipped', weightUsed: null, nextWeight: prog.weight });
    const next = P.applySession(prog, e.increment, judged.weight, judged.success);
    data.progress[e.exerciseId] = { weight: next.weight, misses: next.misses };
    return Object.assign({}, e, { result: next.result, weightUsed: judged.weight, nextWeight: next.weight });
  });
  const session = { id: a.id, dayIndex: a.dayIndex, dayName: a.dayName, startedAt: a.startedAt, finishedAt, exercises };
  data.sessions.push(session);
  data.nextDay = a.dayIndex + 1 >= data.days.length ? 0 : a.dayIndex + 1;
  data.active = null;
  ui.focusEx = null;
  mem.workoutScroll = null;
  mem.loggedLabel = null;
  save();
  go('summary', { id: session.id });
}
function discardWorkout() {
  data.active = null;
  ui.focusEx = null;
  mem.workoutScroll = null;
  save();
  go('home');
}

// ------------------------------------------------------------------ Rest timer (timestamp based)
// The saved timer is { endsAt, total, fired }. Everything shown is worked out from the clock, so it
// is still right after the screen locked or the app was in the background.
let tickHandle = null;
function tick() {
  const a = data.active;
  const onWorkout = ui.screen === 'workout';
  if (!a || (!a.timer && !onWorkout)) {
    if (tickHandle) { clearInterval(tickHandle); tickHandle = null; }
    return;
  }
  const t = a.timer;
  if (t) {
    const ms = t.endsAt - Date.now();
    if (ms <= 0 && !t.fired) {
      t.fired = true;
      save();
      if (ms > -3000) beep();   // only when it is seen reaching zero; iOS allows a haptic only inside a tap
    }
    if (ms <= -REST_OVER_KEEP) { a.timer = null; save(); }
  }
  if (onWorkout) paintBand();
  updateWakeLock();
  if (!tickHandle) tickHandle = setInterval(tick, 250);
}

// ------------------------------------------------------------------ Sound and touch feedback
let audioCtx = null;
function unlockAudio() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state !== 'running') audioCtx.resume();
    const src = audioCtx.createBufferSource();          // a silent buffer, so iOS lets us play later
    src.buffer = audioCtx.createBuffer(1, 1, 22050);
    src.connect(audioCtx.destination);
    src.start(0);
  } catch (e) { /* no sound available */ }
}
function beep() {
  if (!data.settings.sound || !audioCtx) return;
  const play = () => {
    try {
      const t = audioCtx.currentTime;
      // Two struck notes a moment apart, each with a quieter partial above it and a slow decay.
      [0, 0.35].forEach((delay, k) => {
        [[1046.5, 0.5], [1568, 0.18]].forEach(([freq, peak]) => {
          const o = audioCtx.createOscillator();
          const g = audioCtx.createGain();
          const start = t + delay;
          o.type = 'sine';
          o.frequency.value = freq * (k ? 1.26 : 1);       // the second strike is a third higher
          g.gain.setValueAtTime(0.0001, start);
          g.gain.exponentialRampToValueAtTime(peak, start + 0.008);
          g.gain.exponentialRampToValueAtTime(0.0001, start + 0.6);
          o.connect(g);
          g.connect(audioCtx.destination);
          o.start(start);
          o.stop(start + 0.65);
        });
      });
    } catch (e) { /* ignore */ }
  };
  if (audioCtx.state !== 'running') audioCtx.resume().then(play, () => {});
  else play();
}
// Any tap re-arms sound, so the chime still works after a call, Siri or a trip to another app.
['touchend', 'click', 'keydown'].forEach(evt => document.addEventListener(evt, () => { if (!audioCtx || audioCtx.state !== 'running') unlockAudio(); }, { passive: true }));
if (navigator.audioSession) {
  try { navigator.audioSession.type = 'transient'; } catch (e) { /* ignore */ } // mix with music instead of pausing it
}
// A light tap from the Taptic Engine on recent iPhones: toggling a hidden switch control makes
// iOS play its switch haptic. Where that is not supported this does nothing.
let hapticLabel = null;
function haptic() {
  try {
    if (!hapticLabel) {
      hapticLabel = document.createElement('label');
      hapticLabel.setAttribute('aria-hidden', 'true');
      hapticLabel.style.display = 'none';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.setAttribute('switch', '');
      hapticLabel.appendChild(input);
      document.body.appendChild(hapticLabel);
    }
    hapticLabel.click();
  } catch (e) { /* ignore */ }
}

// ------------------------------------------------------------------ Keep the screen awake during a workout
let wakeLock = null;
let wakePending = false;
// Held only on the workout screen while a rest is showing or the screen was touched recently, so
// a forgotten workout cannot keep the display lit for hours.
function wantsWake() {
  if (!data.active || ui.screen !== 'workout' || document.visibilityState !== 'visible') return false;
  return !!data.active.timer || Date.now() - Math.max(mem.touchedAt, mem.shownAt) < WAKE_IDLE;
}
function requestWakeLock() {
  if (!('wakeLock' in navigator) || (wakeLock && !wakeLock.released) || wakePending) return;
  wakePending = true;
  navigator.wakeLock.request('screen').then(lock => {
    wakePending = false;
    wakeLock = lock;
    lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
    if (!wantsWake()) releaseWakeLock();
  }).catch(() => { wakePending = false; wakeLock = null; });
}
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
function updateWakeLock() {
  if (wantsWake()) requestWakeLock(); else releaseWakeLock();
}

// ------------------------------------------------------------------ Export and import
function exportData() {
  shareText(JSON.stringify(data, null, 2), `workout-tracker-${new Date().toISOString().slice(0, 10)}.json`);
}
function shareText(json, name) {
  try {
    const file = new File([json], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: 'Workout data' }).catch(() => {});
      return;
    }
  } catch (e) { /* fall through to download */ }
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  setTimeout(() => { URL.revokeObjectURL(url); link.remove(); }, 1000);
}
// The file chooser is made on demand, so import works from Settings and from first-run Set Up.
function chooseImportFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.id = 'import-file';
  input.hidden = true;
  input.addEventListener('change', () => {
    const f = input.files && input.files[0];
    input.remove();
    if (f) importFile(f);
  });
  const old = document.getElementById('import-file');
  if (old) old.remove();
  document.body.appendChild(input);
  input.click();
}
function importFile(file) {
  const reader = new FileReader();
  const fail = () => { mem.notice = { text: 'Could not read this file. Choose a file exported from this app.', bad: true }; render({ keepScroll: true }); };
  reader.onload = () => {
    let parsed;
    try { parsed = migrate(JSON.parse(reader.result)); } catch (e) { fail(); return; }
    if (data.sessions.length || data.active) askConfirm({ kind: 'replace', incoming: parsed.sessions.length, payload: parsed });
    else applyImport(parsed);
  };
  reader.onerror = fail;
  reader.readAsText(file);
}
function applyImport(parsed) {
  data = parsed;
  save();
  ui = {};
  mem.tabScroll = {};
  mem.workoutScroll = null;
  go(data.setupDone ? 'home' : 'setup');   // arriving with the data in place is the confirmation
}

// ------------------------------------------------------------------ Actions (taps)
const ACTIONS = {
  tab(d) {
    // Tapping the tab you are already on goes to the top of its first screen.
    if (d.screen === ui.screen && TAB_ROOTS.includes(d.screen)) {
      const sc = screenEl();
      if (sc) { if (sc.scrollTo && !reducedMotion()) sc.scrollTo({ top: 0, behavior: 'smooth' }); else sc.scrollTop = 0; }
      return;
    }
    if (d.screen === ui.screen) return;
    go(d.screen);
  },
  go(d) { go(d.screen, { id: d.id, day: d.day != null ? +d.day : undefined }, true); },
  back() { back(); },
  'finish-setup'() { data.setupDone = true; save(); go('home'); },
  'pick-day'() { mem.pickDay = true; render({ keepScroll: true }); },
  'select-day'(d) {
    const i = +d.day;
    mem.selectedDay = i === nextDayIndex() ? null : i;
    render({ keepScroll: true });
  },
  start(d) { startWorkout(+d.day); },
  resume() { go('workout'); },

  edit(d, el) {
    const next = { ex: +d.ex, set: +d.set, field: d.field };
    const same = mem.edit && mem.edit.ex === next.ex && mem.edit.set === next.set && mem.edit.field === next.field;
    const row = el.closest('.set');
    const before = row ? row.getBoundingClientRect().top : null;
    mem.edit = same ? null : next;
    mem.noteOpen = null;
    render({ keepScroll: true });
    // Keep the tapped row where it was (a stepper above it may have closed), then show the stepper.
    const sc = screenEl();
    const now = sc.querySelector(`.set[data-row="${next.ex}-${next.set}"]`);
    if (before != null && now) sc.scrollTop += now.getBoundingClientRect().top - before;
    const stepper = sc.querySelector('.stepper');
    if (stepper && stepper.scrollIntoView) stepper.scrollIntoView({ block: 'nearest' });
    lockTaps(TAP_LOCK_SHIFT);
  },
  step(d) {
    const i = +d.ex, j = +d.set;
    const e = data.active.exercises[i];
    const s = e.sets[j];
    const dir = +d.dir;
    if (d.field === 'weight') setWeight(e, j, Math.max(0, P.clean(s.weight + dir * typeOf(e.type).step)));
    else s.reps = Math.max(0, s.reps + dir);
    relog(e, s);
    save();
    refreshSetRows(i);
    paintBand();
    paintWorkoutBar();
  },
  'toggle-set'(d) {
    const now = Date.now();
    if (now - mem.lastLogAt < LOG_DEBOUNCE) return;       // a doubled tap must not log and un-log
    const i = +d.ex, j = +d.set;
    if (data.active.exercises[i].sets[j].status === 'pending') logSet(i, j);
    else unlogSet(i, j);
  },
  'log-next'() {
    const now = Date.now();
    if (now - mem.lastLogAt < LOG_DEBOUNCE) return;
    if (mem.loggedLabel && now < mem.loggedLabel.until) return;
    const ns = nextSet();
    if (ns) logSet(ns.ex, ns.set);
  },
  note(d) {
    mem.noteOpen = +d.ex;
    mem.edit = null;
    render({ keepScroll: true });
    const input = document.querySelector(`.note-input[data-ex="${+d.ex}"]`);
    if (input) { input.focus(); try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) { /* ignore */ } }
  },
  skip(d) {
    const a = data.active;
    a.exercises[+d.ex].skipped = true;
    mem.edit = null;
    if (workoutCounts(a).pending === 0) { a.timer = null; }
    save();
    lockTaps(TAP_LOCK_SHIFT);
    render({ keepScroll: true });
    autoAdvance();
  },
  unskip(d) {
    data.active.exercises[+d.ex].skipped = false;
    ui.focusEx = +d.ex;
    save();
    saveUI();
    lockTaps(TAP_LOCK_SHIFT);
    render({ keepScroll: true });
  },
  finish() {
    const a = data.active;
    if (a && workoutCounts(a).total === 0 && hasLoggedSets(a)) askConfirm({ kind: 'finish', count: 0 });
    else finishWorkout();
  },
  'finish-early'() {
    const a = data.active;
    if (!a) return;
    if (!hasLoggedSets(a)) askConfirm({ kind: 'discard' });
    else askConfirm({ kind: 'finish', count: workoutCounts(a).pending });
  },
  'confirm-no'() { mem.confirm = null; render({ keepScroll: true }); },
  'confirm-yes'() {
    const c = mem.confirm;
    if (!c || Date.now() - c.at < CONFIRM_ARM) return;
    mem.confirm = null;
    if (c.kind === 'finish') finishWorkout();
    else if (c.kind === 'discard') discardWorkout();
    else if (c.kind === 'replace') applyImport(c.payload);
    else if (c.kind === 'reset') {
      data = freshData();
      save();
      ui = {};
      mem.tabScroll = {};
      go('setup');
    }
  },
  'timer-add'() {
    const t = data.active && data.active.timer;
    if (!t) return;
    if (t.endsAt <= Date.now()) { t.endsAt = Date.now() + 30000; t.total = 30; }
    else { t.endsAt += 30000; t.total += 30; }
    t.fired = false;
    save();
    tick();
  },
  'timer-end'() {
    if (!data.active) return;
    data.active.timer = null;
    save();
    tick();
  },
  'history-tab'(d) { ui.historyTab = d.tab; saveUI(); render(); },
  'toggle-day-edit'() { mem.dayEdit = !mem.dayEdit; mem.removeArmed = null; mem.movedRow = null; render({ keepScroll: true }); },
  'arm-remove'(d) { mem.removeArmed = mem.removeArmed === +d.index ? null : +d.index; mem.movedRow = null; render({ keepScroll: true }); },
  'move-ex'(d) {
    // Positions are worked out on the visible list, then swapped where they really are in the day.
    const list = data.days[+d.day].exercises;
    const shown = list.filter(x => data.exercises[x]);
    const k = shown.indexOf(d.id), j = k + (+d.dir);
    if (k < 0 || j < 0 || j >= shown.length) return;
    const a = list.indexOf(shown[k]), b = list.indexOf(shown[j]);
    [list[a], list[b]] = [list[b], list[a]];
    mem.movedRow = j;
    save();
    render({ keepScroll: true });
    setTimeout(() => {
      if (mem.movedRow === j && ui.screen === 'day') { mem.movedRow = null; const row = document.querySelector('.row-edit.is-moved'); if (row) row.classList.remove('is-moved'); }
    }, 700);
  },
  'remove-ex'(d) {
    const list = data.days[+d.day].exercises;
    const at = list.indexOf(d.id);
    if (at >= 0) list.splice(at, 1);
    mem.removeArmed = null;
    save();
    render({ keepScroll: true });
  },
  'add-existing'(d) { data.days[+d.day].exercises.push(d.id); save(); back(); },
  'new-exercise'(d) {
    const id = uid();
    data.exercises[id] = { id, name: '', type: 'dumbbell', sets: 3, reps: 8, increment: 2.5, rest: 90 };
    data.progress[id] = { weight: 0, misses: 0 };
    data.days[+d.day].exercises.push(id);
    save();
    back();                                        // the day screen, so "back" from the editor lands there
    mem.lockUntil = 0;
    go('exercise', { id, isNew: true }, true);
    const name = document.querySelector('[data-input="ex-name"]');
    if (name) name.focus();
  },
  'ex-step'(d) {
    const ex = data.exercises[d.id];
    const dir = +d.dir;
    switch (d.field) {
      case 'sets': ex.sets = clamp(ex.sets + dir, 1, 20); break;
      case 'reps': ex.reps = clamp(ex.reps + dir, 1, 100); break;
      case 'increment':
        ex.increment = dir < 0 ? (ex.increment <= 2.5 ? 1 : P.clean(ex.increment - 2.5)) : (ex.increment < 2.5 ? 2.5 : P.clean(ex.increment + 2.5));
        break;
      case 'rest': ex.rest = clamp(ex.rest + dir * 15, 0, 1800); break;
      case 'weight': {
        const p = getProgress(d.id);
        p.weight = Math.max(0, P.clean(p.weight + dir * typeOf(ex.type).step));
        break;
      }
    }
    save();
    render({ keepScroll: true });
  },
  export() { exportData(); },
  'export-damaged'() { const raw = damagedCopy(); if (raw) shareText(raw, `workout-tracker-damaged-${new Date().toISOString().slice(0, 10)}.json`); },
  import() { mem.notice = null; chooseImportFile(); },
  reset() { askConfirm({ kind: 'reset' }); }
};

// Text fields update the data as you type, without redrawing (so the keyboard stays open).
const INPUTS = {
  setup(el) { getProgress(el.dataset.id).weight = parseNum(el.value); save(); },
  note(el) {
    const e = data.active && data.active.exercises[+el.dataset.ex];
    if (e) { e.note = el.value.slice(0, 200); save(); }
  },
  'set-value'(el) {
    const i = +el.dataset.ex, j = +el.dataset.set;
    const e = data.active.exercises[i];
    const s = e.sets[j];
    if (el.dataset.field === 'weight') setWeight(e, j, parseNum(el.value));
    else s.reps = Math.max(0, Math.min(999, Math.round(parseNum(el.value)) || 0));
    relog(e, s);
    save();
    refreshSetRows(i);
    paintBand();
  },
  'ex-name'(el) { data.exercises[el.dataset.id].name = el.value.slice(0, 60); save(); },
  'ex-value'(el) {
    const ex = data.exercises[el.dataset.id];
    const v = parseNum(el.value);
    switch (el.dataset.field) {
      case 'sets': ex.sets = clamp(Math.round(v) || 1, 1, 20); break;
      case 'reps': ex.reps = clamp(Math.round(v) || 1, 1, 100); break;
      case 'increment': if (v > 0) ex.increment = v; break;
      case 'weight': getProgress(el.dataset.id).weight = v; break;
    }
    save();
  }
};
// When a field loses focus, show the value the way the app stored it.
function normalizeInput(el) {
  const f = el.dataset.field;
  switch (el.dataset.input) {
    case 'setup': el.value = fmtW(getProgress(el.dataset.id).weight); break;
    case 'set-value': {
      const e = data.active && data.active.exercises[+el.dataset.ex];
      const s = e && e.sets[+el.dataset.set];
      if (s) el.value = f === 'weight' ? fmtW(s.weight) : s.reps;
      break;
    }
    case 'ex-value': {
      const ex = data.exercises[el.dataset.id];
      if (!ex) break;
      el.value = f === 'weight' ? fmtW(getProgress(ex.id).weight) : f === 'increment' ? fmtW(ex.increment) : ex[f];
      break;
    }
  }
}
const CHANGES = {
  sound(el) { data.settings.sound = el.checked; save(); if (el.checked) { unlockAudio(); beep(); } },
  'ex-type'(el) { data.exercises[el.dataset.id].type = el.value; save(); render({ keepScroll: true }); }
};

app.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  const before = renderCount;
  let stale = false;                       // true when something on screen needs redrawing
  if (!el || el.disabled) {
    if (el) return;
    if (e.target.closest('.topbar, .statusbar')) {     // like the iOS status bar: tap it to go to the top
      const sc = screenEl();
      if (sc) { if (sc.scrollTo && !reducedMotion()) sc.scrollTo({ top: 0, behavior: 'smooth' }); else sc.scrollTop = 0; }
      return;
    }
    if (e.target.closest('input, select, label, .stepper, .actionbar')) return;
    if (mem.edit) { mem.edit = null; stale = true; }
    if (mem.removeArmed != null) { mem.removeArmed = null; stale = true; }
    if (mem.confirm) { mem.confirm = null; stale = true; }
    if (stale) render({ keepScroll: true });
    return;
  }
  if (Date.now() < mem.lockUntil) { e.preventDefault(); return; }
  const name = el.dataset.action;
  if (mem.confirm && name !== 'confirm-yes' && name !== 'confirm-no') { mem.confirm = null; stale = true; }
  if (mem.removeArmed != null && name !== 'remove-ex' && name !== 'arm-remove') { mem.removeArmed = null; stale = true; }
  if (mem.edit && !el.closest('.stepper') && name !== 'edit') { mem.edit = null; stale = true; }
  const fn = ACTIONS[name];
  if (fn) { e.preventDefault(); fn(el.dataset, el); }
  if (stale && renderCount === before) render({ keepScroll: true });
});
app.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.matches('input')) { e.target.blur(); return; }
  // Cards that act as buttons respond to the keyboard too.
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role="button"][data-action]')) { e.preventDefault(); e.target.click(); }
});
app.addEventListener('input', e => {
  const fn = INPUTS[e.target.dataset.input];
  if (fn) fn(e.target);
});
app.addEventListener('change', e => {
  const el = e.target;
  const fn = CHANGES[el.dataset.change];
  if (fn) fn(el);
  else if (el.dataset.input) normalizeInput(el);
});
app.addEventListener('focusin', e => {
  const el = e.target;
  if (el.matches('input.step-input, input.num, input.mini-input')) {
    setTimeout(() => { try { el.setSelectionRange(0, el.value.length); } catch (err) { /* ignore */ } }, 0);
  }
});
app.addEventListener('focusout', e => {
  const el = e.target;
  if (el.matches && el.matches('.note-input')) {
    const i = +el.dataset.ex;
    // Close the note field a moment later, so a tap that caused the blur still lands first.
    setTimeout(() => { if (mem.noteOpen === i && document.activeElement !== el) { mem.noteOpen = null; if (ui.screen === 'workout') render({ keepScroll: true }); } }, 150);
  }
  // iOS can leave the page shifted after the keyboard closes; put it back.
  setTimeout(() => { if (!document.activeElement || !document.activeElement.matches('input, select, textarea')) window.scrollTo(0, 0); }, 60);
});

// Touch plumbing: pressed states on iOS, no pinch zoom, and a swipe from the left edge to go back.
let pressedEl = null;
function unpress() {
  if (pressedEl) { pressedEl.classList.remove('is-pressed'); pressedEl = null; }
}
document.addEventListener('pointerdown', e => {
  unpress();
  const el = e.target.closest && e.target.closest('[data-action]');
  if (el && !el.disabled) { pressedEl = el; el.classList.add('is-pressed'); }
}, { passive: true });
['pointerup', 'pointercancel', 'pointerleave'].forEach(evt => document.addEventListener(evt, unpress, { passive: true }));
let swipe = null;
document.addEventListener('touchstart', e => {
  const t = e.touches[0];
  mem.touchedAt = Date.now();
  mem.touchedSinceLoad = true;
  if (e.target.closest && e.target.closest('#screen')) mem.listTouchedAt = mem.touchedAt;
  const canGoBack = ui.screen !== 'workout' && !!document.querySelector('.bar-back[data-action="back"]');
  swipe = e.touches.length === 1 && t.clientX <= 20 && canGoBack ? { x: t.clientX, y: t.clientY, at: Date.now() } : null;
}, { passive: true });
document.addEventListener('touchend', e => {
  if (!swipe) return;
  const t = e.changedTouches[0];
  const ok = t.clientX - swipe.x >= 70 && Math.abs(t.clientY - swipe.y) < 30 && Date.now() - swipe.at < 600;
  swipe = null;
  if (ok && Date.now() >= mem.lockUntil) back();
}, { passive: true });
document.addEventListener('gesturestart', e => e.preventDefault());

// Make room for the on-screen keyboard: while a field has focus and the visible area is clearly
// shorter than it was without the keyboard, the shell shrinks to fit and the bottom bars step aside,
// so the field is never hidden and nothing is left shifted afterwards. The comparison height is
// taken only while no field has focus, so rotating the phone is never mistaken for a keyboard.
if (window.visualViewport) {
  const vv = window.visualViewport;
  const editing = () => { const el = document.activeElement; return !!(el && el.matches && el.matches('input:not([type="checkbox"]), select, textarea')); };
  let restHeight = vv.height;
  const onViewport = () => {
    if (!editing()) restHeight = vv.height;
    const gap = Math.max(0, restHeight - vv.height);
    const open = editing() && gap > 120;
    document.documentElement.style.setProperty('--keyboard', open ? `${Math.round(gap)}px` : '0px');
    app.classList.toggle('kb-open', open);
    if (open && document.activeElement.scrollIntoView) document.activeElement.scrollIntoView({ block: 'center' });
    if (vv.offsetTop || window.scrollY) window.scrollTo(0, 0);
  };
  vv.addEventListener('resize', onViewport);
  vv.addEventListener('scroll', () => { if (vv.offsetTop) window.scrollTo(0, 0); });
  document.addEventListener('focusout', () => setTimeout(onViewport, 120));
}

// ------------------------------------------------------------------ Start-up
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('./sw.js').catch(() => {});
  // A new version took over. Reload straight away only if nothing has been touched since launch;
  // otherwise wait until the app next goes to the background, so nothing changes under a finger.
  // Every logged set is already saved, so the reload loses nothing.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) {
      if (!mem.touchedSinceLoad && ui.screen !== 'setup') location.reload();
      else mem.reloadWhenHidden = true;
    }
    hadController = true;
  });
}
// Ask for a newer version when the app comes back to the front, at most once an hour.
let lastUpdateCheck = Date.now();
function checkForUpdate() {
  if (!('serviceWorker' in navigator) || Date.now() - lastUpdateCheck < 3600000) return;
  lastUpdateCheck = Date.now();
  navigator.serviceWorker.getRegistration().then(reg => { if (reg) reg.update().catch(() => {}); }).catch(() => {});
}
// Where to open: the workout if one is in progress; the last screen only when the app was in use
// moments ago; otherwise Home. A days-old summary or a deep editor screen is never what greets you.
function openingScreen() {
  dropBlankExercise(ui.screen, ui.params);
  ui.params = ui.params || {};
  ui.stack = ui.stack || [];
  const home = () => { ui.screen = 'home'; ui.params = {}; ui.stack = []; };
  if (!data.setupDone) { ui.screen = 'setup'; ui.params = {}; ui.stack = []; return; }
  if (data.active) { ui.screen = 'workout'; ui.params = {}; ui.stack = []; return; }
  const recent = ui.lastUsed && Date.now() - ui.lastUsed < RESTORE_WINDOW;
  if (!recent || !ui.screen || !VIEWS[ui.screen] || ui.screen === 'setup' || ui.screen === 'workout' || ui.screen === 'summary') home();
}
function init() {
  if (!loadFailed) save(); // keeps any migration applied by load()
  openingScreen();
  saveUI();
  render();
  if (ui.screen === 'workout') placeWorkoutScroll();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      mem.hiddenAt = Date.now();
      saveUI();
      releaseWakeLock();
      if (mem.reloadWhenHidden && !data.active) location.reload();
      return;
    }
    mem.shownAt = Date.now();
    checkForUpdate();
    // Back after a long while with no workout running: start again from Home.
    if (mem.hiddenAt && Date.now() - mem.hiddenAt > STALE_AFTER && !data.active && ui.screen !== 'home' && ui.screen !== 'setup') go('home');
    tick();
    updateWakeLock();
  });
  window.addEventListener('pagehide', saveUI);
  window.addEventListener('pageshow', tick);
  window.addEventListener('load', registerServiceWorker);
  if (document.readyState === 'complete') registerServiceWorker();
}
init();

})();
