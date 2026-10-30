/* program.js
 * The default program: the exercise library and the four days.
 * Used on the first run and after "Reset all data". Once the app has saved data,
 * edit the program inside the app (Program tab); changing this file does not alter saved data.
 *
 * Fields: sets and reps are the target, increment is in lb, rest is in seconds.
 * type is 'barbell', 'dumbbell', 'machine' or 'bodyweight' (weighted bodyweight: the app
 * logs the ADDED weight, 0 meaning bodyweight only). The type also sets the step of the
 * +/- weight buttons: barbell 5 lb, dumbbell 2.5 lb, machine 5 lb, bodyweight 2.5 lb.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProgramDefaults = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var exercises = [
    { id: 'paused-bench',     name: 'Paused Barbell Bench Press',          type: 'barbell',    sets: 3, reps: 5,  increment: 5,   rest: 180 },
    { id: 'sa-db-row',        name: 'Single Arm Dumbbell Row',             type: 'dumbbell',   sets: 3, reps: 5,  increment: 2.5, rest: 90 },
    { id: 'db-fly',           name: 'Dumbbell Chest Fly',                  type: 'dumbbell',   sets: 3, reps: 6,  increment: 2.5, rest: 90 },
    { id: 'pullup',           name: 'Overhead Pull-up',                    type: 'bodyweight', sets: 3, reps: 5,  increment: 2.5, rest: 180 },
    { id: 'tricep-pushdown',  name: 'Tricep Pushdown',                     type: 'machine',    sets: 3, reps: 8,  increment: 5,   rest: 90 },
    { id: 'squat',            name: 'Barbell Squat',                       type: 'barbell',    sets: 3, reps: 5,  increment: 10,  rest: 180 },
    { id: 'rdl',              name: 'Barbell RDL',                         type: 'barbell',    sets: 3, reps: 5,  increment: 10,  rest: 180 },
    { id: 'incline-curl',     name: 'Incline Dumbbell Bicep Curl',         type: 'dumbbell',   sets: 3, reps: 8,  increment: 2.5, rest: 90 },
    { id: 'leg-ext',          name: 'Leg Extension',                       type: 'machine',    sets: 3, reps: 8,  increment: 5,   rest: 90 },
    { id: 'lateral-raise',    name: 'Lateral Raise',                       type: 'dumbbell',   sets: 3, reps: 12, increment: 2.5, rest: 90 },
    { id: 'incline-db-bench', name: 'Incline Dumbbell Bench Press',        type: 'dumbbell',   sets: 3, reps: 5,  increment: 2.5, rest: 90 },
    { id: 'incline-db-row',   name: 'Incline Dumbbell Row',                type: 'dumbbell',   sets: 3, reps: 5,  increment: 2.5, rest: 90 },
    { id: 'sa-db-ohp',        name: 'Single Arm Dumbbell Overhead Press',  type: 'dumbbell',   sets: 3, reps: 5,  increment: 2.5, rest: 90 },
    { id: 'oh-tricep-ext',    name: 'Overhead Dumbbell Tricep Extension',  type: 'dumbbell',   sets: 3, reps: 8,  increment: 2.5, rest: 90 },
    { id: 'sumo-dl',          name: 'Sumo Deadlift (Barbell)',             type: 'barbell',    sets: 3, reps: 5,  increment: 10,  rest: 180 },
    { id: 'db-split-squat',   name: 'Dumbbell Split Squat',                type: 'dumbbell',   sets: 3, reps: 8,  increment: 2.5, rest: 90 },
    { id: 'hip-abductor',     name: 'Hip Abductor Machine',                type: 'machine',    sets: 3, reps: 8,  increment: 5,   rest: 90 }
  ];

  var days = [
    { name: 'Day 1', exercises: ['paused-bench', 'sa-db-row', 'db-fly', 'pullup', 'tricep-pushdown'] },
    { name: 'Day 2', exercises: ['squat', 'rdl', 'incline-curl', 'leg-ext', 'lateral-raise'] },
    { name: 'Day 3', exercises: ['incline-db-bench', 'incline-db-row', 'sa-db-ohp', 'pullup', 'oh-tricep-ext'] },
    { name: 'Day 4', exercises: ['sumo-dl', 'db-split-squat', 'hip-abductor', 'incline-curl', 'lateral-raise'] }
  ];

  return { exercises: exercises, days: days };
});
