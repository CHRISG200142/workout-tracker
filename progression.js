/* progression.js
 * The progression rules. Pure functions, no DOM, so the same code runs in the
 * app (app.js) and in the test script (test/progression.test.js).
 *
 * To change the rules, edit the two numbers below or the functions that follow.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Progression = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DELOAD_AFTER_MISSES = 3; // consecutive missed sessions at the same weight before a deload
  var DELOAD_PERCENT = 10;     // a deload drops the weight by this much, rounded to the nearest increment

  function clean(n) { return Math.round(n * 100) / 100; }

  // Weight after a deload: minus DELOAD_PERCENT, rounded to the nearest increment, never below 0.
  // If rounding would land back on the same weight (small weights), drop exactly one increment instead.
  function deload(weight, increment) {
    if (weight <= 0) return 0;
    var w = Math.round((weight * (1 - DELOAD_PERCENT / 100)) / increment) * increment;
    if (w >= weight) w = weight - increment;
    return clean(Math.max(0, w));
  }

  // Judge one exercise in one session from its sets.
  // Each set is { weight, reps, status } where status is 'pending' (not logged), 'done' or 'missed'.
  // Returns null when no set was logged (treated like a skip). Otherwise returns
  // { weight, success }: weight is the heaviest weight used, and success means every set
  // was logged at that weight with at least the target reps.
  function judgeExercise(sets, targetReps) {
    var logged = sets.filter(function (s) { return s.status !== 'pending'; });
    if (logged.length === 0) return null;
    var weight = Math.max.apply(null, logged.map(function (s) { return s.weight; }));
    var success = sets.every(function (s) {
      return s.status !== 'pending' && s.weight === weight && s.reps >= targetReps;
    });
    return { weight: weight, success: success };
  }

  // Apply one session to an exercise's progression state.
  //   state      = { weight: current recommendation, misses: consecutive misses at that weight }
  //   increment  = the exercise's increment in lb
  //   weightUsed = the weight the session was judged at (see judgeExercise)
  //   success    = true when every set hit the target reps at weightUsed
  // Returns { weight, misses, result } with result 'up', 'repeat' or 'deload'.
  function applySession(state, increment, weightUsed, success) {
    if (success) return { weight: clean(weightUsed + increment), misses: 0, result: 'up' };
    var misses = (state.weight === weightUsed ? state.misses : 0) + 1;
    if (misses >= DELOAD_AFTER_MISSES) {
      return { weight: deload(weightUsed, increment), misses: 0, result: 'deload' };
    }
    return { weight: weightUsed, misses: misses, result: 'repeat' };
  }

  return {
    DELOAD_AFTER_MISSES: DELOAD_AFTER_MISSES,
    DELOAD_PERCENT: DELOAD_PERCENT,
    clean: clean,
    deload: deload,
    judgeExercise: judgeExercise,
    applySession: applySession
  };
});
