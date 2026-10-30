/* test/progression.test.js
 * Run with:  node test/progression.test.js
 *
 * Simulates 12 weeks of the rolling 4-day program (48 workouts) using the same
 * rule functions the app uses (progression.js) and the default program (program.js).
 * Barbell Squat, Overhead Pull-up and Lateral Raise follow scripted outcomes with a
 * mix of hits, misses, skips, overrides and three-miss deloads; every other exercise
 * simply hits. The script prints each tracked exercise's recommendation sequence and
 * checks it against expectations worked out by hand from the rules.
 */
'use strict';
const assert = require('assert');
const P = require('../progression.js');
const DEFAULTS = require('../program.js');

// ---------- tiny unit checks on the pure functions ----------
assert.strictEqual(P.deload(225, 10), 200, '225 lb minus 10% = 202.5, nearest 10 = 200');
assert.strictEqual(P.deload(255, 10), 230, '255 lb minus 10% = 229.5, nearest 10 = 230');
assert.strictEqual(P.deload(20, 2.5), 17.5, '20 lb minus 10% = 18, nearest 2.5 = 17.5');
assert.strictEqual(P.deload(10, 2.5), 7.5, 'rounding would give 10 again, so drop one increment');
assert.strictEqual(P.deload(0, 2.5), 0, 'bodyweight only cannot deload below 0');

const set = (weight, reps, status) => ({ weight, reps, status: status || (reps >= 5 ? 'done' : 'missed') });
assert.deepStrictEqual(P.judgeExercise([set(185, 5), set(185, 5), set(185, 5)], 5), { weight: 185, success: true });
assert.deepStrictEqual(P.judgeExercise([set(185, 7), set(185, 6), set(185, 5)], 5), { weight: 185, success: true }, 'extra reps still count as a hit');
assert.deepStrictEqual(P.judgeExercise([set(185, 5), set(185, 5), set(185, 4)], 5), { weight: 185, success: false });
assert.deepStrictEqual(P.judgeExercise([set(185, 3), set(175, 5), set(175, 5)], 5), { weight: 185, success: false }, 'dropped weight mid-exercise: judged at the heaviest weight, as a miss');
assert.deepStrictEqual(P.judgeExercise([set(185, 5), set(185, 5), set(175, 5)], 5), { weight: 185, success: false }, 'not every set at the heaviest weight: a miss');
assert.deepStrictEqual(P.judgeExercise([set(185, 5), set(185, 5), set(185, 5, 'pending')], 5), { weight: 185, success: false }, 'an unlogged set means the exercise was not completed');
assert.strictEqual(P.judgeExercise([set(185, 5, 'pending'), set(185, 5, 'pending'), set(185, 5, 'pending')], 5), null, 'nothing logged = skipped');

let st = { weight: 0, misses: 0 };
st = P.applySession(st, 2.5, 0, false); st = P.applySession(st, 2.5, 0, false); st = P.applySession(st, 2.5, 0, false);
assert.deepStrictEqual(st, { weight: 0, misses: 0, result: 'deload' }, 'three misses at bodyweight stay at 0');

// ---------- the 12-week simulation ----------
const exercises = {};
DEFAULTS.exercises.forEach(e => { exercises[e.id] = e; });

const starting = { squat: 225, pullup: 0, 'lateral-raise': 15 };
const progress = {};
DEFAULTS.exercises.forEach(e => { progress[e.id] = { weight: e.id in starting ? starting[e.id] : 100, misses: 0 }; });

// Outcome per session for the three tracked exercises, in the order the sessions happen.
//   'hit'   every set reaches the target reps at the recommended weight
//   'hit+'  every set beats the target reps (extra reps must not change anything)
//   'miss'  the last set falls one rep short
//   'skip'  the exercise is skipped (no change to the recommendation)
//   { use: W, outcome } overrides the recommended weight with W for every set
const script = {
  squat: ['hit', 'hit', 'miss', 'hit', 'miss', 'miss', 'miss', 'hit', { use: 250, outcome: 'hit' }, 'skip', 'miss', { use: 255, outcome: 'miss' }],
  pullup: ['hit', 'hit', 'hit', 'miss', 'miss', 'miss', 'hit', 'hit', 'miss', 'skip', 'miss', 'hit',
           'hit', 'hit', 'miss', 'miss', 'miss', 'hit', 'hit', 'miss', 'hit', 'hit', 'miss', 'hit'],
  'lateral-raise': ['hit', 'miss', 'hit', 'miss', 'miss', 'miss', 'hit', 'hit', 'hit', 'miss', 'miss', 'hit',
                    'miss', 'miss', 'miss', 'hit', 'hit+', 'miss', 'skip', 'skip', 'miss', 'miss', 'hit', 'hit'],
};

// Expected recommendation AFTER each session, worked out by hand from the rules.
const expected = {
  squat: [235, 245, 245, 255, 255, 255, 230, 240, 260, 260, 260, 255],
  pullup: [2.5, 5, 7.5, 7.5, 7.5, 5, 7.5, 10, 10, 10, 10, 12.5,
           15, 17.5, 17.5, 17.5, 15, 17.5, 20, 20, 22.5, 25, 25, 27.5],
  'lateral-raise': [17.5, 17.5, 20, 20, 20, 17.5, 20, 22.5, 25, 25, 25, 27.5,
                    27.5, 27.5, 25, 27.5, 30, 30, 30, 30, 30, 27.5, 30, 32.5],
};

const counters = {};
const log = {};
Object.keys(script).forEach(id => { counters[id] = 0; log[id] = []; });

// This mirrors finishWorkout() in app.js: skipped or nothing logged -> no change;
// otherwise judge the sets and apply the rules.
function performExercise(id, outcome, week, dayName) {
  const ex = exercises[id];
  const state = progress[id];
  const recommended = state.weight;
  if (outcome === 'skip') {
    if (log[id]) log[id].push({ week, dayName, recommended, did: 'skipped', result: 'skipped', next: state.weight });
    return;
  }
  const weight = typeof outcome === 'object' ? outcome.use : recommended;
  const kind = typeof outcome === 'object' ? outcome.outcome : outcome;
  const sets = [];
  for (let i = 0; i < ex.sets; i++) {
    let reps = ex.reps;
    if (kind === 'hit+') reps = ex.reps + 2;
    if (kind === 'miss' && i === ex.sets - 1) reps = ex.reps - 1;
    sets.push({ weight, reps, status: reps >= ex.reps ? 'done' : 'missed' });
  }
  const judged = P.judgeExercise(sets, ex.reps);
  const next = P.applySession(state, ex.increment, judged.weight, judged.success);
  progress[id] = { weight: next.weight, misses: next.misses };
  if (log[id]) log[id].push({
    week, dayName, recommended,
    did: `${weight} x ${sets.map(s => s.reps).join(', ')}`,
    result: next.result, next: next.weight,
  });
}

let dayIndex = 0; // rolling order: the next workout is the day after the last completed one
for (let workout = 0; workout < 48; workout++) {
  const week = Math.floor(workout / 4) + 1;
  const day = DEFAULTS.days[dayIndex];
  day.exercises.forEach(id => {
    const outcome = script[id] ? script[id][counters[id]++] : 'hit';
    performExercise(id, outcome, week, day.name);
  });
  dayIndex = (dayIndex + 1) % DEFAULTS.days.length;
}

// ---------- print and check ----------
const pad = (s, n) => String(s).padEnd(n);
for (const id of Object.keys(script)) {
  const ex = exercises[id];
  const unit = ex.type === 'bodyweight' ? 'lb added' : 'lb';
  console.log(`\n${ex.name}  (${ex.sets} x ${ex.reps}, increment ${ex.increment} ${unit}, starting at ${starting[id]} ${unit})`);
  console.log(`${pad('#', 3)} ${pad('Week', 5)} ${pad('Day', 6)} ${pad('Recommended', 12)} ${pad('Did', 16)} ${pad('Result', 8)} Next`);
  log[id].forEach((row, i) => {
    console.log(`${pad(i + 1, 3)} ${pad(row.week, 5)} ${pad(row.dayName, 6)} ${pad(row.recommended, 12)} ${pad(row.did, 16)} ${pad(row.result, 8)} ${row.next}`);
  });
  const sequence = log[id].map(r => r.next);
  console.log(`Recommendation sequence: ${sequence.join(' -> ')}`);
  assert.deepStrictEqual(sequence, expected[id], `${ex.name} sequence differs from the hand-computed expectation`);
  assert.strictEqual(log[id].length, expected[id].length, `${ex.name} should have ${expected[id].length} sessions in 12 weeks`);
}

// Shared exercises: Lateral Raise on Day 2 and Day 4 share one history and one progression.
assert.strictEqual(log['lateral-raise'].filter(r => r.dayName === 'Day 2').length, 12);
assert.strictEqual(log['lateral-raise'].filter(r => r.dayName === 'Day 4').length, 12);
assert.strictEqual(log.pullup.filter(r => r.dayName === 'Day 1').length, 12);
assert.strictEqual(log.pullup.filter(r => r.dayName === 'Day 3').length, 12);

console.log('\nAll progression checks passed.');
