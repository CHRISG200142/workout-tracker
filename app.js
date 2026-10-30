/* app.js
 * The whole app: storage, screens, actions, rest timer, sound, wake lock, export and import.
 * Plain JavaScript, no build step. The progression rules live in progression.js and the
 * default program in program.js.
 */
(function () {
'use strict';

const P = window.Progression;
const DEFAULTS = window.ProgramDefaults;
const APP_VERSION = '1.0.0';
const DATA_KEY = 'workout-tracker-data';
const UI_KEY = 'workout-tracker-ui';

// Equipment types. "step" is how far the weight +/- buttons move for that equipment.
const TYPES = {
  barbell:    { label: 'Barbell', step: 5 },
  dumbbell:   { label: 'Dumbbell', step: 2.5 },
  machine:    { label: 'Machine', step: 5 },
  bodyweight: { label: 'Weighted bodyweight', step: 2.5 }
};
const RESULT_LABEL = { up: 'Went up', repeat: 'Repeat', deload: 'Deload', skipped: 'Skipped' };

// ------------------------------------------------------------------ Data and storage
function freshData() {
  const exercises = {}, progress = {};
  DEFAULTS.exercises.forEach(e => {
    exercises[e.id] = Object.assign({}, e);
    progress[e.id] = { weight: 0, misses: 0 };
  });
  return {
    version: 1,
    setupDone: false,
    settings: { sound: true },
    exercises,                                    // id -> { id, name, type, sets, reps, increment, rest }
    days: DEFAULTS.days.map(d => ({ name: d.name, exercises: d.exercises.slice() })),
    progress,                                     // id -> { weight: next recommendation, misses }
    sessions: [],                                 // completed workouts, oldest first
    active: null                                  // the workout in progress, if any
  };
}

// Brings older saved data up to the current schema. Add a step here whenever the schema changes.
function migrate(d) {
  if (!d || typeof d !== 'object') throw new Error('Not a data file.');
  if (!d.version) d.version = 1;
  // Example for a future change:
  // if (d.version === 1) { d.newField = 'default'; d.version = 2; }
  if (!d.exercises || !Array.isArray(d.days) || !Array.isArray(d.sessions) || !d.progress) {
    throw new Error('Not a workout tracker file.');
  }
  if (!d.settings) d.settings = { sound: true };
  if (d.active === undefined) d.active = null;
  return d;
}

function load() {
  try {
    const raw = localStorage.getItem(DATA_KEY);
    if (raw) return migrate(JSON.parse(raw));
  } catch (e) { console.error('Could not read saved data', e); }
  return freshData();
}
function save() {
  try { localStorage.setItem(DATA_KEY, JSON.stringify(data)); }
  catch (e) { console.error('Could not save', e); }
}
function loadUI() {
  try { return JSON.parse(localStorage.getItem(UI_KEY)) || {}; } catch (e) { return {}; }
}
function saveUI() {
  try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch (e) { /* ignore */ }
}

let data = load();
let ui = loadUI();          // { screen, params, stack, historyTab, selectedDay, pickDay, dayEdit }
let editState = null;       // which set value has its stepper open: { ex, set, field }

// ------------------------------------------------------------------ Helpers
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtW = w => String(P.clean(Number(w) || 0));
const fmtRest = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const fmtDate = ts => new Date(ts).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const fmtShortDate = ts => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const fmtTime = ts => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function fmtDuration(a, b) {
  const m = Math.max(1, Math.round((b - a) / 60000));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
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
function weightLabel(type, w) {
  w = Number(w) || 0;
  if (type === 'bodyweight') return w === 0 ? 'Bodyweight' : `+${fmtW(w)} lb`;
  return `${fmtW(w)} lb`;
}
// Rolling order: the day after the last completed workout.
function nextDayIndex() {
  if (!data.days.length) return 0;
  const last = data.sessions[data.sessions.length - 1];
  return last ? (last.dayIndex + 1) % data.days.length : 0;
}
function lastResult(exId) {
  for (let i = data.sessions.length - 1; i >= 0; i--) {
    const e = data.sessions[i].exercises.find(x => x.exerciseId === exId && x.result !== 'skipped');
    if (e) return e;
  }
  return null;
}
function fmtSets(sets) {
  const logged = sets.filter(s => s.status !== 'pending');
  if (!logged.length) return 'nothing logged';
  const reps = sets.map(s => s.status === 'pending' ? '–' : s.reps);
  const w = logged[0].weight;
  if (logged.every(s => s.weight === w)) return `${fmtW(w)} × ${reps.join(', ')}`;
  return sets.map(s => s.status === 'pending' ? '–' : `${fmtW(s.weight)} × ${s.reps}`).join(', ');
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
  entries.forEach(({ e }) => e.sets.forEach(s => {
    if (s.status === 'pending' || s.reps < e.targetReps) return;
    if (!best || s.weight > best.weight || (s.weight === best.weight && s.reps > best.reps)) best = { weight: s.weight, reps: s.reps };
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

// ------------------------------------------------------------------ Icons
const svg = (d, extra) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra ? ' ' + extra : ''}>${d}</svg>`;
const I = {
  check: svg('<path d="M5 12.5l4.5 4.5L19 7"/>'),
  cross: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  chevron: svg('<path d="M9 6l6 6-6 6"/>', 'class="chev"'),
  back: svg('<path d="M15 5l-7 7 7 7"/>', 'class="back-chev"'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  minus: svg('<path d="M5 12h14"/>'),
  up: svg('<path d="M12 19V5M5 12l7-7 7 7"/>'),
  down: svg('<path d="M12 5v14M5 12l7 7 7-7"/>'),
  home: svg('<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'),
  history: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  program: svg('<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>')
};

// ------------------------------------------------------------------ Navigation
// Tab a screen belongs to, and where "back" lands when there is no history.
const TAB_OF = { home: 'home', summary: 'home', history: 'history', workoutDetail: 'history', exerciseDetail: 'history', program: 'program', day: 'program', addExercise: 'program', exercise: 'program' };
const ROOT_OF = { workoutDetail: 'history', exerciseDetail: 'history', day: 'program', addExercise: 'program', exercise: 'program', workout: 'home', summary: 'home' };

function leaveScreen() {
  editState = null;
  if (ui.screen === 'exercise' && ui.params && data.exercises[ui.params.id]) {
    const ex = data.exercises[ui.params.id];
    if (!ex.name.trim()) { ex.name = 'New exercise'; save(); }
  }
}
function go(screen, params, push) {
  leaveScreen();
  ui.stack = push ? (ui.stack || []).concat([{ screen: ui.screen, params: ui.params || {} }]).slice(-12) : [];
  ui.screen = screen;
  ui.params = params || {};
  ui.dayEdit = false;
  saveUI();
  render();
}
function back() {
  leaveScreen();
  const prev = (ui.stack || []).pop();
  if (prev) { ui.screen = prev.screen; ui.params = prev.params || {}; }
  else { ui.screen = ROOT_OF[ui.screen] || 'home'; ui.params = {}; }
  ui.dayEdit = false;
  saveUI();
  render();
}
function titleFor(screen, params) {
  switch (screen) {
    case 'home': return 'Home';
    case 'history': return 'History';
    case 'program': return 'Program';
    case 'day': return data.days[params.day] ? data.days[params.day].name : 'Day';
    case 'exerciseDetail': return data.exercises[params.id] ? data.exercises[params.id].name : 'Exercise';
    case 'workoutDetail': return 'Workout';
    default: return 'Back';
  }
}
function backLabel() {
  const stack = ui.stack || [];
  const prev = stack[stack.length - 1];
  const label = prev ? titleFor(prev.screen, prev.params || {}) : titleFor(ROOT_OF[ui.screen] || 'home', {});
  return label.length > 14 ? 'Back' : label;
}
function backBtn() {
  return `<button class="bar-btn" data-action="back">${I.back}<span>${esc(backLabel())}</span></button>`;
}
function tabbarHTML() {
  const on = TAB_OF[ui.screen] || 'home';
  return `<nav class="tabbar">${[['home', 'Home', I.home], ['history', 'History', I.history], ['program', 'Program', I.program]]
    .map(([k, label, icon]) => `<button class="tab${on === k ? ' on' : ''}" data-action="tab" data-screen="${k}">${icon}<span>${label}</span></button>`).join('')}</nav>`;
}

// ------------------------------------------------------------------ Screens
// Each screen returns { title, left, right, body, bottom, tabs, timer }.
const VIEWS = {

  setup() {
    const ids = allExerciseIds();
    return {
      title: 'Set Up', tabs: false,
      body: `<p class="lead">Enter the weight you currently use for each exercise. These become your first recommended weights. You can change any of them later from the Program tab.</p>
        <div class="card">${ids.map(id => {
          const ex = data.exercises[id];
          return `<label class="row"><span class="row-main"><span class="row-title">${esc(ex.name)}</span>${ex.type === 'bodyweight' ? '<span class="row-sub">Added weight. 0 means bodyweight only.</span>' : ''}</span><span class="row-value"><input class="num" type="text" inputmode="decimal" autocomplete="off" data-input="setup" data-id="${id}" value="${fmtW(getProgress(id).weight)}" aria-label="${esc(ex.name)} weight"><span class="unit">lb</span></span></label>`;
        }).join('')}</div>`,
      bottom: `<button class="btn btn-primary" data-action="finish-setup">Done</button>`
    };
  },

  home() {
    const a = data.active;
    if (a) {
      return {
        title: 'Home', tabs: true,
        body: `<section class="hero"><div class="eyebrow">In progress</div><h1 class="big">${esc(a.dayName)}</h1><div class="sub">Started ${fmtTime(a.startedAt)}</div></section>
          <div class="card">${a.exercises.map(e => {
            const done = e.sets.filter(s => s.status !== 'pending').length;
            return `<div class="row"><span class="row-main"><span class="row-title">${esc(e.name)}</span></span><span class="row-value">${e.skipped ? 'Skipped' : `${done} of ${e.sets.length} sets`}</span></div>`;
          }).join('')}</div>`,
        bottom: `<button class="btn btn-primary" data-action="resume">Resume Workout</button>`
      };
    }
    const next = nextDayIndex();
    const dayIndex = ui.selectedDay != null && data.days[ui.selectedDay] ? ui.selectedDay : next;
    const day = data.days[dayIndex];
    if (!day) return { title: 'Home', tabs: true, body: '<p class="empty">No days in the program.</p>' };
    return {
      title: 'Home', tabs: true,
      body: `<section class="hero"><div class="eyebrow">${dayIndex === next ? 'Next' : 'Selected'}</div><h1 class="big">${esc(day.name)}</h1></section>
        <div class="card">${day.exercises.filter(id => data.exercises[id]).map(id => {
          const ex = data.exercises[id];
          return `<div class="row"><span class="row-main"><span class="row-title">${esc(ex.name)}</span><span class="row-sub">${ex.sets} × ${ex.reps}</span></span><span class="row-value strong">${weightLabel(ex.type, getProgress(id).weight)}</span></div>`;
        }).join('') || '<div class="row"><span class="row-sub">No exercises on this day yet.</span></div>'}</div>
        ${ui.pickDay
          ? `<div class="segmented">${data.days.map((d, i) => `<button class="seg${i === dayIndex ? ' on' : ''}" data-action="select-day" data-day="${i}">${esc(d.name)}</button>`).join('')}</div>`
          : `<button class="link" data-action="pick-day">Pick a different day</button>`}`,
      bottom: `<button class="btn btn-primary" data-action="start" data-day="${dayIndex}">Start ${esc(day.name)}</button>`
    };
  },

  workout() {
    const a = data.active;
    if (!a) { ui.screen = 'home'; return VIEWS.home(); }
    return {
      title: a.dayName, tabs: false, timer: true,
      left: `<button class="bar-btn" data-action="tab" data-screen="home">${I.back}<span>Home</span></button>`,
      body: a.exercises.map((e, i) => exerciseCard(e, i)).join(''),
      bottom: `<button class="btn btn-primary" data-action="finish">Finish Workout</button>`
    };
  },

  summary() {
    const s = data.sessions.find(x => x.id === ui.params.id);
    if (!s) { ui.screen = 'home'; return VIEWS.home(); }
    return {
      title: 'Summary', tabs: true,
      body: `<section class="hero"><div class="eyebrow">Saved</div><h1 class="big">${esc(s.dayName)}</h1><div class="sub">${fmtDate(s.finishedAt)} · ${fmtDuration(s.startedAt, s.finishedAt)}</div></section>
        <div class="card">${s.exercises.map(e => `<div class="row"><span class="row-main"><span class="row-title">${esc(e.name)}</span><span class="row-sub">${resultDetail(e)}</span></span><span class="row-value result-${e.result}">${RESULT_LABEL[e.result]}</span></div>`).join('')}</div>`,
      bottom: `<button class="btn btn-primary" data-action="tab" data-screen="home">Done</button>`
    };
  },

  history() {
    const tab = ui.historyTab === 'exercises' ? 'exercises' : 'workouts';
    let list;
    if (tab === 'workouts') {
      const sessions = data.sessions.slice().reverse();
      list = sessions.length
        ? `<div class="card">${sessions.map(s => `<button class="row row-link" data-action="go" data-screen="workoutDetail" data-id="${s.id}"><span class="row-main"><span class="row-title">${esc(s.dayName)}</span><span class="row-sub">${fmtDate(s.finishedAt)} · ${fmtDuration(s.startedAt, s.finishedAt)}</span></span>${I.chevron}</button>`).join('')}</div>`
        : '<p class="empty">No workouts yet.</p>';
    } else {
      list = `<div class="card">${allExerciseIds().map(id => {
        const ex = data.exercises[id];
        const n = sessionsFor(id).length;
        return `<button class="row row-link" data-action="go" data-screen="exerciseDetail" data-id="${id}"><span class="row-main"><span class="row-title">${esc(ex.name)}</span><span class="row-sub">${n} session${n === 1 ? '' : 's'}</span></span><span class="row-value">${weightLabel(ex.type, getProgress(id).weight)}</span>${I.chevron}</button>`;
      }).join('')}</div>`;
    }
    return {
      title: 'History', tabs: true,
      body: `<div class="segmented"><button class="seg${tab === 'workouts' ? ' on' : ''}" data-action="history-tab" data-tab="workouts">Workouts</button><button class="seg${tab === 'exercises' ? ' on' : ''}" data-action="history-tab" data-tab="exercises">Exercises</button></div>${list}`
    };
  },

  workoutDetail() {
    const s = data.sessions.find(x => x.id === ui.params.id);
    if (!s) { ui.screen = 'history'; return VIEWS.history(); }
    return {
      title: s.dayName, tabs: true, left: backBtn(),
      body: `<section class="hero small"><div class="sub">${fmtDate(s.finishedAt)} · ${fmtTime(s.startedAt)} · ${fmtDuration(s.startedAt, s.finishedAt)}</div></section>
        ${s.exercises.map(e => `<section class="card ex">
          <div class="ex-head"><div class="ex-text"><div class="ex-title">${esc(e.name)}</div><div class="ex-sub">${e.targetSets} × ${e.targetReps} · ${RESULT_LABEL[e.result]}${e.result === 'skipped' ? '' : ` · next ${weightLabel(e.type, e.nextWeight)}`}</div></div></div>
          ${e.result === 'skipped' ? '' : `<div class="sets">${e.sets.map((st, j) => `<div class="set set-${st.status} set-static"><div class="set-n">${j + 1}</div><div class="val"><span class="val-num">${fmtW(st.weight)}</span><span class="val-unit">lb</span></div><div class="val"><span class="val-num">${st.status === 'pending' ? '–' : st.reps}</span><span class="val-unit">reps</span></div><div class="check">${st.status === 'done' ? I.check : st.status === 'missed' ? I.cross : ''}</div></div>`).join('')}</div>`}
          ${e.note ? `<div class="note-static">${esc(e.note)}</div>` : ''}
        </section>`).join('')}`
    };
  },

  exerciseDetail() {
    const id = ui.params.id;
    const ex = data.exercises[id];
    if (!ex) { ui.screen = 'history'; return VIEWS.history(); }
    const entries = sessionsFor(id);
    const best = bestFor(entries);
    return {
      title: ex.name, tabs: true, left: backBtn(),
      body: `<div class="card">
          <div class="row"><span class="row-main"><span class="row-title">Next weight</span></span><span class="row-value strong">${weightLabel(ex.type, getProgress(id).weight)}</span></div>
          <div class="row"><span class="row-main"><span class="row-title">Best</span></span><span class="row-value strong">${best ? `${weightLabel(ex.type, best.weight)} × ${best.reps}` : '–'}</span></div>
          <button class="row row-link" data-action="go" data-screen="exercise" data-id="${id}"><span class="row-main"><span class="row-title accent">Edit exercise and next weight</span></span>${I.chevron}</button>
        </div>
        ${entries.length >= 2 ? `<div class="card chart-card"><div class="chart-title">Working weight</div>${chartSVG(entries)}</div>` : ''}
        ${entries.length
          ? `<div class="card">${entries.slice().reverse().map(({ session, e }) => `<button class="row row-link" data-action="go" data-screen="workoutDetail" data-id="${session.id}"><span class="row-main"><span class="row-title">${fmtSets(e.sets)}</span><span class="row-sub">${fmtDate(session.finishedAt)} · ${esc(session.dayName)} · ${RESULT_LABEL[e.result]}</span></span>${I.chevron}</button>`).join('')}</div>`
          : '<p class="empty">No sessions yet.</p>'}`
    };
  },

  program() {
    return {
      title: 'Program', tabs: true,
      body: `${data.days.map((d, i) => `<div class="card card-link" role="button" tabindex="0" data-action="go" data-screen="day" data-day="${i}">
          <div class="card-head"><span class="card-title">${esc(d.name)}</span>${I.chevron}</div>
          ${d.exercises.filter(id => data.exercises[id]).map(id => { const ex = data.exercises[id]; return `<div class="row row-plain"><span class="row-main"><span class="row-title">${esc(ex.name)}</span></span><span class="row-value">${ex.sets} × ${ex.reps}</span></div>`; }).join('') || '<div class="row row-plain"><span class="row-sub">No exercises</span></div>'}
        </div>`).join('')}
        <h2 class="section">Settings</h2>
        <div class="card">
          <label class="row"><span class="row-main"><span class="row-title">Timer sound</span></span><input type="checkbox" class="switch" data-change="sound"${data.settings.sound ? ' checked' : ''} aria-label="Timer sound"></label>
          <button class="row row-link" data-action="export"><span class="row-main"><span class="row-title">Export data</span><span class="row-sub">Save a copy of everything to Files or iCloud</span></span>${I.chevron}</button>
          <button class="row row-link" data-action="import"><span class="row-main"><span class="row-title">Import data</span><span class="row-sub">Restore from an exported file</span></span>${I.chevron}</button>
          <button class="row row-link" data-action="reset"><span class="row-main"><span class="row-title danger">Reset all data</span></span></button>
        </div>
        <p class="footnote">Everything is stored on this phone only. Export now and then so a cleared browser does not take your history with it.<br>Version ${APP_VERSION}</p>
        <input type="file" id="import-file" accept="application/json,.json" data-change="import-file" hidden>`
    };
  },

  day() {
    const i = ui.params.day;
    const d = data.days[i];
    if (!d) { ui.screen = 'program'; return VIEWS.program(); }
    const edit = !!ui.dayEdit;
    const ids = d.exercises.filter(id => data.exercises[id]);
    return {
      title: d.name, tabs: true, left: backBtn(),
      right: ids.length ? `<button class="bar-btn right" data-action="toggle-day-edit">${edit ? 'Done' : 'Edit'}</button>` : '',
      body: `${ids.length ? `<div class="card">${ids.map((id, k) => {
          const ex = data.exercises[id];
          return `<div class="row${edit ? ' row-edit' : ''}">
            ${edit ? `<button class="icon-btn remove" data-action="remove-ex" data-day="${i}" data-index="${k}" aria-label="Remove ${esc(ex.name)}">${I.minus}</button>` : ''}
            <button class="row-main row-btn" data-action="go" data-screen="exercise" data-id="${id}"><span class="row-title">${esc(ex.name)}</span><span class="row-sub">${ex.sets} × ${ex.reps} · ${typeOf(ex.type).label} · +${fmtW(ex.increment)} lb · Rest ${fmtRest(ex.rest)}</span></button>
            ${edit
              ? `<button class="icon-btn" data-action="move-ex" data-day="${i}" data-index="${k}" data-dir="-1" aria-label="Move up"${k === 0 ? ' disabled' : ''}>${I.up}</button><button class="icon-btn" data-action="move-ex" data-day="${i}" data-index="${k}" data-dir="1" aria-label="Move down"${k === ids.length - 1 ? ' disabled' : ''}>${I.down}</button>`
              : I.chevron}
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
      body: `<div class="card"><button class="row row-link" data-action="new-exercise" data-day="${i}"><span class="row-main"><span class="row-title accent">New Exercise</span></span><span class="accent">${I.plus}</span></button></div>
        ${others.length ? `<h2 class="section">Existing exercises</h2><div class="card">${others.map(ex => `<button class="row row-link" data-action="add-existing" data-day="${i}" data-id="${ex.id}"><span class="row-main"><span class="row-title">${esc(ex.name)}</span><span class="row-sub">${ex.sets} × ${ex.reps} · ${typeOf(ex.type).label}</span></span><span class="accent">${I.plus}</span></button>`).join('')}</div>` : ''}`
    };
  },

  exercise() {
    const id = ui.params.id;
    const ex = data.exercises[id];
    if (!ex) { ui.screen = 'program'; return VIEWS.program(); }
    const prog = getProgress(id);
    const field = (label, value, name, typable) => `<div class="row row-stepper"><span class="row-main"><span class="row-title">${label}</span></span><span class="mini-stepper"><button class="step" data-action="ex-step" data-id="${id}" data-field="${name}" data-dir="-1" aria-label="Decrease ${label}">${I.minus}</button>${typable ? `<input class="step-input" type="text" inputmode="decimal" autocomplete="off" data-input="ex-value" data-id="${id}" data-field="${name}" value="${value}" aria-label="${label}">` : `<span class="step-input">${value}</span>`}<button class="step" data-action="ex-step" data-id="${id}" data-field="${name}" data-dir="1" aria-label="Increase ${label}">${I.plus}</button></span></div>`;
    return {
      title: ui.params.isNew ? 'New Exercise' : 'Edit Exercise', tabs: true, left: backBtn(),
      body: `<div class="card">
          <label class="row"><span class="row-title">Name</span><input class="text" type="text" autocomplete="off" data-input="ex-name" data-id="${id}" value="${esc(ex.name)}" placeholder="Exercise name"></label>
          <label class="row"><span class="row-main"><span class="row-title">Equipment</span></span><select class="select" data-change="ex-type" data-id="${id}">${Object.keys(TYPES).map(t => `<option value="${t}"${t === ex.type ? ' selected' : ''}>${TYPES[t].label}</option>`).join('')}</select></label>
        </div>
        <div class="card">
          ${field('Sets', ex.sets, 'sets', true)}
          ${field('Reps', ex.reps, 'reps', true)}
          ${field('Increment (lb)', fmtW(ex.increment), 'increment', true)}
          ${field('Rest', fmtRest(ex.rest), 'rest', false)}
        </div>
        <div class="card">${field(ex.type === 'bodyweight' ? 'Next added weight (lb)' : 'Next weight (lb)', fmtW(prog.weight), 'weight', true)}</div>
        <p class="footnote">${ex.type === 'bodyweight' ? 'Log the added weight. 0 means bodyweight only. ' : ''}Changes apply from the next workout.</p>`
    };
  }
};

function resultDetail(e) {
  if (e.result === 'skipped') return `Next stays at ${weightLabel(e.type, e.nextWeight)}`;
  return `${weightLabel(e.type, e.weightUsed)} → ${weightLabel(e.type, e.nextWeight)}`;
}

// One exercise on the Workout screen.
function exerciseCard(e, i) {
  if (e.skipped) {
    return `<section class="card ex ex-skipped"><div class="ex-head"><div class="ex-text"><div class="ex-title">${esc(e.name)}</div><div class="ex-sub">Skipped. The recommendation stays at ${weightLabel(e.type, e.recommended)}.</div></div><button class="pill" data-action="unskip" data-ex="${i}">Undo</button></div></section>`;
  }
  const last = lastResult(e.exerciseId);
  return `<section class="card ex">
    <div class="ex-head"><div class="ex-text"><div class="ex-title">${esc(e.name)}</div><div class="ex-sub">${e.targetSets} × ${e.targetReps} at ${weightLabel(e.type, e.recommended)}</div><div class="ex-sub">${last ? `Last: ${fmtSets(last.sets)}` : 'First time logging this'}</div></div><button class="pill" data-action="skip" data-ex="${i}">Skip</button></div>
    <div class="sets">${e.sets.map((s, j) => setRow(e, i, s, j)).join('')}</div>
    <input class="note" type="text" placeholder="Note" autocomplete="off" data-input="note" data-ex="${i}" value="${esc(e.note)}" aria-label="Note for ${esc(e.name)}">
  </section>`;
}
function setRow(e, i, s, j) {
  const editing = editState && editState.ex === i && editState.set === j ? editState.field : null;
  const icon = s.status === 'done' ? I.check : s.status === 'missed' ? I.cross : '';
  const label = s.status === 'pending' ? 'Log set' : 'Undo set';
  return `<div class="set set-${s.status}" data-row="${i}-${j}">
      <div class="set-n">${j + 1}</div>
      <button class="val${editing === 'weight' ? ' val-on' : ''}" data-action="edit" data-ex="${i}" data-set="${j}" data-field="weight" aria-label="Weight"><span class="val-num">${fmtW(s.weight)}</span><span class="val-unit">lb</span></button>
      <button class="val${editing === 'reps' ? ' val-on' : ''}" data-action="edit" data-ex="${i}" data-set="${j}" data-field="reps" aria-label="Reps"><span class="val-num">${s.reps}</span><span class="val-unit">reps</span></button>
      <button class="check" data-action="toggle-set" data-ex="${i}" data-set="${j}" aria-label="${label}">${icon}</button>
    </div>
    ${editing ? `<div class="stepper"><button class="step" data-action="step" data-ex="${i}" data-set="${j}" data-field="${editing}" data-dir="-1" aria-label="Decrease">${I.minus}</button><input class="step-input" type="text" inputmode="decimal" autocomplete="off" data-input="set-value" data-ex="${i}" data-set="${j}" data-field="${editing}" value="${editing === 'weight' ? fmtW(s.weight) : s.reps}" aria-label="${editing === 'weight' ? 'Weight in pounds' : 'Reps'}"><button class="step" data-action="step" data-ex="${i}" data-set="${j}" data-field="${editing}" data-dir="1" aria-label="Increase">${I.plus}</button></div>` : ''}`;
}
// Update one exercise's set rows in place (used while typing, so the keyboard stays open).
function refreshSetRows(i) {
  const e = data.active && data.active.exercises[i];
  if (!e) return;
  e.sets.forEach((s, j) => {
    const row = document.querySelector(`.set[data-row="${i}-${j}"]`);
    if (!row) return;
    const nums = row.querySelectorAll('.val-num');
    nums[0].textContent = fmtW(s.weight);
    nums[1].textContent = s.reps;
    row.className = `set set-${s.status}`;
    row.querySelector('.check').innerHTML = s.status === 'done' ? I.check : s.status === 'missed' ? I.cross : '';
  });
}

// Simple line chart of the working weight per session (one series, so no legend).
function chartSVG(entries) {
  const W = 340, H = 170, L = 46, R = 14, T = 12, B = 28;
  const inc = Math.max(entries[entries.length - 1].e.increment || 2.5, 2.5);
  const pts = entries.map(x => x.e.weightUsed);
  const n = pts.length, min = Math.min(...pts), max = Math.max(...pts);
  const span = (max - min) || inc;
  let lo = Math.floor((min - span * 0.15) / inc) * inc;
  let hi = Math.ceil((max + span * 0.15) / inc) * inc;
  if (lo < 0) lo = 0;
  if (hi <= lo) hi = lo + inc;
  const x = i => L + (n === 1 ? (W - L - R) / 2 : i * (W - L - R) / (n - 1));
  const y = v => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  const grid = [lo, (lo + hi) / 2, hi];
  const path = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const showDots = n <= 24;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Working weight over time">
    ${grid.map(g => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(g).toFixed(1)}" y2="${y(g).toFixed(1)}"/><text x="${L - 8}" y="${(y(g) + 4).toFixed(1)}" text-anchor="end">${fmtW(g)}</text>`).join('')}
    <path class="line" d="${path}"/>
    ${pts.map((v, i) => (showDots || i === n - 1) ? `<circle class="dot" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="4.5"/>` : '').join('')}
    <text x="${L}" y="${H - 8}">${fmtShortDate(entries[0].session.finishedAt)}</text>
    <text x="${W - R}" y="${H - 8}" text-anchor="end">${fmtShortDate(entries[n - 1].session.finishedAt)}</text>
  </svg>`;
}

// ------------------------------------------------------------------ Rendering
const app = document.getElementById('app');
function render(opts) {
  const keep = opts && opts.keepScroll;
  const prev = document.getElementById('screen');
  const scrollTop = keep && prev ? prev.scrollTop : 0;
  const view = (VIEWS[ui.screen] || VIEWS.home)();
  app.innerHTML =
    `<header class="topbar"><div class="bar-left">${view.left || ''}</div><div class="title">${esc(view.title || '')}</div><div class="bar-right">${view.right || ''}</div></header>` +
    (view.timer ? `<div class="timerbar" id="timerbar" hidden><span class="timer-label">Rest</span><span class="timer-time">0:00</span><button class="timer-btn" data-action="timer-add">+30 s</button><button class="timer-btn" data-action="timer-skip">Skip</button><div class="timer-progress"></div></div>` : '') +
    `<main class="screen${ui.screen === 'workout' ? ' screen-workout' : ''}" id="screen">${view.body}</main>` +
    (view.bottom ? `<div class="bottombar${view.tabs ? ' with-tabs' : ''}">${view.bottom}</div>` : '') +
    (view.tabs ? tabbarHTML() : '');
  if (keep) document.getElementById('screen').scrollTop = scrollTop;
  tick();
  updateWakeLock();
}

// ------------------------------------------------------------------ Workout actions
function startWorkout(dayIndex) {
  const day = data.days[dayIndex];
  if (!day) return;
  const ids = day.exercises.filter(id => data.exercises[id]);
  if (!ids.length) { alert(`${day.name} has no exercises. Add some in the Program tab first.`); return; }
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
  ui.selectedDay = null;
  ui.pickDay = false;
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

function finishWorkout() {
  const a = data.active;
  if (!a) return;
  const anyLogged = a.exercises.some(e => !e.skipped && e.sets.some(s => s.status !== 'pending'));
  if (!anyLogged) {
    if (confirm('Nothing was logged. Discard this workout?')) { data.active = null; save(); go('home'); }
    return;
  }
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
  data.active = null;
  save();
  go('summary', { id: session.id });
}

// ------------------------------------------------------------------ Rest timer (timestamp based)
let tickHandle = null;
function startTimer(seconds) {
  if (!data.active || !seconds) return;
  data.active.timer = { endsAt: Date.now() + seconds * 1000, total: seconds, fired: false };
  save();
  tick();
}
function tick() {
  const a = data.active;
  const t = a && a.timer;
  const bar = document.getElementById('timerbar');
  if (!t) {
    if (bar) bar.hidden = true;
    if (tickHandle) { clearInterval(tickHandle); tickHandle = null; }
    return;
  }
  const remainingMs = t.endsAt - Date.now();
  const remaining = Math.ceil(remainingMs / 1000);
  if (remainingMs <= 0) {
    if (!t.fired) {
      t.fired = true;
      save();
      if (remainingMs > -3000) beep(); // only if we are watching it hit zero, not when coming back much later
    }
    if (remainingMs <= -4000) { a.timer = null; save(); tick(); return; }
  }
  if (bar) {
    bar.hidden = false;
    bar.classList.toggle('over', remainingMs <= 0);
    bar.querySelector('.timer-label').textContent = remainingMs <= 0 ? 'Rest over' : 'Rest';
    bar.querySelector('.timer-time').textContent = fmtRest(Math.max(0, remaining));
    bar.querySelector('.timer-progress').style.width = `${clamp(remainingMs / (t.total * 1000) * 100, 0, 100)}%`;
  }
  if (!tickHandle) tickHandle = setInterval(tick, 250);
}

// ------------------------------------------------------------------ Sound
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
      for (let i = 0; i < 3; i++) {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        const start = t + i * 0.22;
        o.type = 'sine';
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.0001, start);
        g.gain.exponentialRampToValueAtTime(0.5, start + 0.02);
        g.gain.setValueAtTime(0.5, start + 0.12);
        g.gain.exponentialRampToValueAtTime(0.0001, start + 0.2);
        o.connect(g);
        g.connect(audioCtx.destination);
        o.start(start);
        o.stop(start + 0.22);
      }
    } catch (e) { /* ignore */ }
  };
  if (audioCtx.state !== 'running') audioCtx.resume().then(play, () => {});
  else play();
}
['touchend', 'click', 'keydown'].forEach(evt => document.addEventListener(evt, unlockAudio, { once: true, passive: true }));
if (navigator.audioSession) {
  try { navigator.audioSession.type = 'transient'; } catch (e) { /* ignore */ } // mix with music instead of pausing it
}

// ------------------------------------------------------------------ Keep the screen awake during a workout
let wakeLock = null;
function requestWakeLock() {
  if (!('wakeLock' in navigator) || !data.active || document.visibilityState !== 'visible') return;
  if (wakeLock && !wakeLock.released) return;
  navigator.wakeLock.request('screen').then(lock => {
    wakeLock = lock;
    lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
  }).catch(() => { wakeLock = null; });
}
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
function updateWakeLock() {
  if (data.active) requestWakeLock(); else releaseWakeLock();
}

// ------------------------------------------------------------------ Export and import
function exportData() {
  const json = JSON.stringify(data, null, 2);
  const name = `workout-tracker-${new Date().toISOString().slice(0, 10)}.json`;
  try {
    const file = new File([json], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: 'Workout data' }).catch(() => {});
      return;
    }
  } catch (e) { /* fall through to download */ }
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}
function importFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try { parsed = migrate(JSON.parse(reader.result)); }
    catch (e) { alert(`Could not read this file. ${e.message}`); return; }
    const n = data.sessions.length;
    if (n && !confirm(`Replace the ${n} workout${n === 1 ? '' : 's'} on this phone with the ${parsed.sessions.length} in this file?`)) return;
    data = parsed;
    save();
    ui = {};
    go(data.setupDone ? 'home' : 'setup');
    alert('Data restored.');
  };
  reader.onerror = () => alert('Could not read this file.');
  reader.readAsText(file);
}

// ------------------------------------------------------------------ Event handling
const ACTIONS = {
  tab(d) { go(d.screen); },
  go(d) { go(d.screen, { id: d.id, day: d.day != null ? +d.day : undefined }, true); },
  back() { back(); },
  'finish-setup'() { data.setupDone = true; save(); go('home'); },
  'pick-day'() { ui.pickDay = true; saveUI(); render({ keepScroll: true }); },
  'select-day'(d) { ui.selectedDay = +d.day; ui.pickDay = false; saveUI(); render({ keepScroll: true }); },
  start(d) { startWorkout(+d.day); },
  resume() { go('workout'); },
  edit(d) {
    const next = { ex: +d.ex, set: +d.set, field: d.field };
    const same = editState && editState.ex === next.ex && editState.set === next.set && editState.field === next.field;
    editState = same ? null : next;
    render({ keepScroll: true });
    const stepper = document.querySelector('.stepper');
    if (stepper) stepper.scrollIntoView({ block: 'nearest' });
  },
  step(d) {
    const e = data.active.exercises[+d.ex];
    const s = e.sets[+d.set];
    const dir = +d.dir;
    if (d.field === 'weight') setWeight(e, +d.set, Math.max(0, P.clean(s.weight + dir * typeOf(e.type).step)));
    else s.reps = Math.max(0, s.reps + dir);
    relog(e, s);
    save();
    render({ keepScroll: true });
  },
  'toggle-set'(d) {
    const e = data.active.exercises[+d.ex];
    const s = e.sets[+d.set];
    if (s.status === 'pending') {
      s.status = s.reps >= e.targetReps ? 'done' : 'missed';
      editState = null;
      save();
      startTimer(e.rest);
    } else {
      s.status = 'pending';
      save();
    }
    render({ keepScroll: true });
  },
  skip(d) { data.active.exercises[+d.ex].skipped = true; editState = null; save(); render({ keepScroll: true }); },
  unskip(d) { data.active.exercises[+d.ex].skipped = false; save(); render({ keepScroll: true }); },
  finish() { finishWorkout(); },
  'timer-add'() {
    const t = data.active && data.active.timer;
    if (!t) return;
    t.endsAt = Math.max(t.endsAt, Date.now()) + 30000;
    t.total += 30;
    t.fired = false;
    save();
    tick();
  },
  'timer-skip'() { if (data.active) { data.active.timer = null; save(); tick(); } },
  'history-tab'(d) { ui.historyTab = d.tab; saveUI(); render(); },
  'toggle-day-edit'() { ui.dayEdit = !ui.dayEdit; saveUI(); render({ keepScroll: true }); },
  'move-ex'(d) {
    const list = data.days[+d.day].exercises;
    const i = +d.index, j = i + (+d.dir);
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    save();
    render({ keepScroll: true });
  },
  'remove-ex'(d) { data.days[+d.day].exercises.splice(+d.index, 1); save(); render({ keepScroll: true }); },
  'add-existing'(d) { data.days[+d.day].exercises.push(d.id); save(); back(); },
  'new-exercise'(d) {
    const id = uid();
    data.exercises[id] = { id, name: '', type: 'dumbbell', sets: 3, reps: 8, increment: 2.5, rest: 90 };
    data.progress[id] = { weight: 0, misses: 0 };
    data.days[+d.day].exercises.push(id);
    save();
    back();                                        // the day screen, so "back" from the editor lands there
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
  import() { const inp = document.getElementById('import-file'); if (inp) inp.click(); },
  reset() {
    if (!confirm('Delete all workouts, history, program changes and settings? This cannot be undone.')) return;
    data = freshData();
    save();
    ui = {};
    go('setup');
  }
};

// Text inputs update the data as you type, without re-rendering (so the keyboard stays open).
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
    else s.reps = Math.round(parseNum(el.value));
    relog(e, s);
    save();
    refreshSetRows(i);
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
      const s = data.active && data.active.exercises[+el.dataset.ex] && data.active.exercises[+el.dataset.ex].sets[+el.dataset.set];
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
  'ex-type'(el) { data.exercises[el.dataset.id].type = el.value; save(); render({ keepScroll: true }); },
  'import-file'(el) { const f = el.files && el.files[0]; if (f) importFile(f); el.value = ''; }
};

app.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = ACTIONS[el.dataset.action];
  if (fn) { e.preventDefault(); fn(el.dataset, el); }
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
app.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.matches('input')) e.target.blur();
});
app.addEventListener('focusin', e => {
  const el = e.target;
  if (el.matches('input.step-input, input.num')) {
    setTimeout(() => { try { el.setSelectionRange(0, el.value.length); } catch (err) { /* ignore */ } }, 0);
  }
});

// ------------------------------------------------------------------ Start-up
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('./sw.js').catch(() => {});
  // A new version took over: reload to use it, unless a workout is in progress.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !data.active && ui.screen !== 'setup') location.reload();
    hadController = true;
  });
}
function init() {
  ui.params = ui.params || {};
  ui.stack = ui.stack || [];
  if (!data.setupDone) { ui.screen = 'setup'; ui.stack = []; }
  else if (!ui.screen || ui.screen === 'setup' || !VIEWS[ui.screen]) { ui.screen = 'home'; ui.stack = []; }
  if (ui.screen === 'workout' && !data.active) { ui.screen = 'home'; ui.stack = []; }
  saveUI();
  render();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { tick(); requestWakeLock(); }
  });
  window.addEventListener('pageshow', tick);
  window.addEventListener('load', registerServiceWorker);
  if (document.readyState === 'complete') registerServiceWorker();
}
init();

})();
