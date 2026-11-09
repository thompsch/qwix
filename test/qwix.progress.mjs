/**
 * Unit tests for the bits of progression that are easy to break and awkward to
 * play into: the extra life every half million points, and the two ways out of
 * the game-over card.
 *
 * Like qwix.hits.mjs, this boots the real qwix.js with one line added at the
 * bottom that hands the state and the two functions out on globalThis. The game
 * itself is untouched.
 *
 * Run: node test/qwix.progress.mjs   (or: npm test)
 */
import fs from 'node:fs';

const noop = () => {};
const ctx = new Proxy({}, {
  get: (target, prop) => (prop in target ? target[prop] : noop),
  set: (target, prop, value) => { target[prop] = value; return true; },
});
const element = (id) => ({
  id, textContent: '', style: {}, hidden: false, className: '',
  addEventListener: noop, getContext: () => ctx,
});
const els = {};

globalThis.window = globalThis;
globalThis.location = { search: '' }; // the variant switch writes to this
globalThis.addEventListener = noop;
globalThis.document = {
  getElementById: (id) => (els[id] ??= element(id)),
  createElement: (tag) => {
    const node = element(tag);
    node.width = 0;
    node.height = 0;
    return node;
  },
  querySelectorAll: () => [],
  addEventListener: noop,
};
globalThis.localStorage = { getItem: () => null, setItem: noop };
globalThis.requestAnimationFrame = noop;

const GAME = fs.readFileSync(new URL('../qwix.js', import.meta.url), 'utf8');
const PROBE = GAME.replace(
  '  requestAnimationFrame(frame);\n})();',
  '  globalThis.__probe = { S, RULES, VARIANTS, checkLifeMilestones, lifeCost, awardTrap,'
  + ' finishLevel, survivorBonusFor, playVersion, openHelp, closeHelp, helpText, backToMenu, continueGame, newRun,'
  + ' syncOverlay, resetBoard, nextLevel, qixCount, sparxCount, sparxStepMs, speedAtLevel,'
  + ' qixScale, chaseField, chaseStep, sparxStep, sparxCanStand, homeSparx,'
  + ' closeClaim, updateLevelClock, sparxIdleAllowance, setHunting, fuseGrace, updateFuse, afterDeath,'
  + ' chooseDir, canStep, hold, release, playerStep, updatePlayer, update, VARIANTS,'
       + ' typeDigit, backspaceDigit, clearTypedLevel, typedLevelNumber, startQixDeath, saveBest,'
       + ' updateDeaths, QIX_DEATH_MS, QIX_DEATH_RINGS, QIX_DEATH_SHARDS, levelComplete,'
  + ' bonusMultiplier, captureColor, CAPTURE_COLORS, SPARX_CALM, SPARX_HUNT,'
  + ' parMs, fastWinBonus, duration, TARGET_PERCENT, OVER_TARGET_PER_PERCENT,'
       + ' SPEED_BONUS_PER_SECOND,'
  + ' LIFE_EVERY_POINTS, SURVIVOR_BONUS, START_LIVES };\n})();'
);
if (PROBE === GAME) throw new Error('could not hook the game source');

(0, eval)(fs.readFileSync(new URL('../engine.js', import.meta.url), 'utf8'));
(0, eval)(PROBE);
const P = globalThis.__probe;

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         got ${a}\n         exp ${e}`); }
};

// --- a life every million ---------------------------------------------------
{
  const S = P.S;
  const step = P.LIFE_EVERY_POINTS;
  check('the milestone is a million points', step, 1000000);

  S.state = 'playing';
  S.lives = 3;
  S.score = 0;
  S.nextLifeAt = step;

  S.score = step - 1;
  P.checkLifeMilestones();
  check('short of the milestone is no life', S.lives, 3);

  S.score = step;
  P.checkLifeMilestones();
  check('a million buys a life', S.lives, 4);
  check('and the next one is queued', S.nextLifeAt, step * 2);

  P.checkLifeMilestones();
  check('checking again does not pay twice', S.lives, 4);

  S.score = step * 3;
  P.checkLifeMilestones();
  check('a jump over two milestones pays two lives', S.lives, 6);
  check('and lands on the next one past the score', S.nextLifeAt, step * 4);

  S.score = step * 4 + step / 2;
  P.checkLifeMilestones();
  check('however far it jumps, it keeps up',
    [S.lives, S.nextLifeAt], [7, step * 5]);
}

// --- the game-over card -----------------------------------------------------
{
  const S = P.S;
  S.state = 'gameover';
  S.level = 7;
  S.score = 123456;
  S.multiplier = 3;
  S.lives = 0;
  P.syncOverlay();

  check('the card is up', els.overlay.hidden, false);
  check('it says what happened', els['overlay-title'].textContent, 'GAME OVER');
  check('the continue button offers the same level',
    els['overlay-button'].textContent, 'Continue level 7');
  check('and a second button offers a fresh run',
    [els['overlay-button-2'].textContent, els['overlay-button-2'].hidden], ['New game', false]);
  check('and a third goes back to the menu',
    [els['overlay-button-3'].textContent, els['overlay-button-3'].hidden], ['Menu', false]);

  // Continue: same level, fresh board, lives back - and the score starts again.
  P.continueGame();
  check('continue resumes play', S.state, 'playing');
  check('on the level the run ended on', S.level, 7);
  check('with the score started again from zero', S.score, 0);
  check('and the multiplier is still what level 7 pays', S.multiplier, 1);
  check('with a full set of lives', S.lives, P.START_LIVES);
  check('and a fresh field', S.percent, 0);
  check('the card is gone', els.overlay.hidden, true);

  // New game: everything back to the start.
  S.state = 'gameover';
  S.level = 7;
  S.score = 123456;
  S.multiplier = 3;
  S.nextLifeAt = 1500000;
  P.newRun();
  check('a new run starts at level 1', S.level, 1);
  check('with no score', S.score, 0);
  check('no multiplier', S.multiplier, 1);
  check('a full set of lives', S.lives, P.START_LIVES);
  check('and its life milestones reset', S.nextLifeAt, P.LIFE_EVERY_POINTS);
  check('and it is playing', S.state, 'playing');

  // Menu: back to the chooser, with the question and its three buttons.
  S.state = 'gameover';
  P.backToMenu();
  check('the menu button returns to the chooser', S.state, 'title');
  check('which asks the question again', els['overlay-title'].textContent, 'QWIX');
  check('and offers both versions and the help again',
    [els['overlay-button'].textContent, els['overlay-button-2'].textContent,
      els['overlay-button-3'].textContent],
    ['Capture the Qwix', 'Kill the Qwix', 'How to play']);
}

// --- a Sparx every twenty levels -------------------------------------------
{
  const counts = [1, 19, 20, 39, 40, 59, 60, 200].map((l) => P.sparxCount(l));
  check('one Sparx until level 20, then another every twenty levels, capped at four',
    counts, [1, 1, 2, 2, 3, 3, 4, 4]);

  const S = P.S;
  S.level = 20;
  S.state = 'playing';
  P.resetBoard();
  check('level 20 starts with two Sparx on the board', S.sparx.length, 2);
  check('and they do not start on top of each other',
    S.sparx.length === 2 && (S.sparx[0].x !== S.sparx[1].x || S.sparx[0].y !== S.sparx[1].y), true);

  S.level = 40;
  P.resetBoard();
  check('level 40 starts with three', S.sparx.length, 3);

  S.level = 1;
  P.resetBoard();
  check('and level 1 still has just the one', S.sparx.length, 1);
}

// --- the Qix speeds up every ten levels ------------------------------------
{
  const speed = (level) => P.speedAtLevel(level);
  check('level 1 to 10 all run at the base speed',
    [1, 5, 10].map(speed), [9, 9, 9]);
  check('level 11 is the first step up', speed(11), 11);
  check('and it holds for the rest of that decade',
    [11, 15, 20].map(speed), [11, 11, 11]);
  check('level 21 is the next step', speed(21), 13);
  check('level 31 the next', speed(31), 15);
  check('and it tops out instead of climbing forever',
    [speed(36), speed(50), speed(71), speed(200)], [15, 17, 22, 22]);
}

// --- the bonus multiplier steps up every ten levels --------------------------
{
  check('x1 for the first nine levels',
    [P.bonusMultiplier(1), P.bonusMultiplier(9)], [1, 1]);
  check('x2 from level 10, x3 from 20, and so on',
    [P.bonusMultiplier(10), P.bonusMultiplier(19), P.bonusMultiplier(20),
      P.bonusMultiplier(50)], [2, 2, 3, 6]);
  check('up to a ceiling of 9',
    [P.bonusMultiplier(80), P.bonusMultiplier(200)], [9, 9]);

  const S = P.S;
  S.state = 'playing';
  S.level = 9;
  P.resetBoard();
  check('a board takes its multiplier from its level', [S.level, S.multiplier], [9, 1]);
  S.level = 10;
  P.resetBoard();
  check('and level 10 starts at x2', [S.level, S.multiplier], [10, 2]);

  // A kill used to move it; nothing does now but the level.
  S.trapDone = false;
  const before = S.multiplier;
  P.awardTrap(1);
  check('a kill does not move the multiplier', S.multiplier, before);

  S.level = 1;
  P.resetBoard();
}

// --- the over-achiever bonus only pays for whole points past the target ------
{
  const S = P.S;
  const recap = (percent) => {
    S.state = 'playing';
    S.level = 3;
    S.percent = percent;
    S.score = 0;
    S.qixes = [{}];
    S.multiplier = 1;      // the ramp gives level 3 an x1
    S.levelAge = P.parMs(); // no speed bonus in these sums
    S.flashQueue.length = 0;
    P.finishLevel(0);
    return {
      bonus: S.clearInfo.bonus,
      over: S.clearInfo.over,
      notice: S.flashQueue.map((n) => n.text).find((t) => t.indexOf('Over achiever: ') === 0),
    };
  };

  check('exactly on the target pays nothing', recap(P.TARGET_PERCENT).bonus, 0);
  check('and there is no notice for it', recap(P.TARGET_PERCENT).notice, undefined);
  check('nor just above it: 85.9% is still on the number',
    [recap(P.TARGET_PERCENT + 0.9).bonus, recap(P.TARGET_PERCENT + 0.9).notice], [0, undefined]);

  const one = recap(P.TARGET_PERCENT + 1);
  check('one whole point past it pays the rate', one.bonus, P.OVER_TARGET_PER_PERCENT);
  check('and the notice says so, without a multiplier at x1',
    one.notice, 'Over achiever: 2,000');

  const three = recap(P.TARGET_PERCENT + 3.7); // three whole points
  check('a fractional point does not count on top',
    [three.bonus, three.over], [3 * P.OVER_TARGET_PER_PERCENT, 3]);
}

// --- the Qix grows as a level drags on --------------------------------------
{
  const S = P.S;
  S.levelAge = 0;
  check('a fresh level starts at normal size', P.qixScale(), 1);
  S.levelAge = 60000;
  check('a minute in it has barely grown', P.qixScale(), 1.2);
  S.levelAge = 150000;
  check('two and a half minutes is the ceiling', P.qixScale(), 1.5);
  S.levelAge = 900000;
  check('and it stops growing there', P.qixScale(), 1.5);
  S.levelAge = 0;
}

// --- Sparx quicken slowly with the level ------------------------------------
{
  const S = P.S;
  const normal = { super: false };
  const supered = { super: true };
  const at = (level, s) => { S.level = level; return P.sparxStepMs(s); };

  check('level 1 Sparx step is the base', [at(1, normal), at(1, supered)], [88, 62]);
  check('level 11 is ten milliseconds quicker', [at(11, normal), at(11, supered)], [78, 52]);
  check('it stops quickening at level 21',
    [at(21, normal), at(41, normal), at(21, supered), at(99, supered)], [68, 68, 42, 42]);
}

// --- another Qix every twenty levels ----------------------------------------
{
  const counts = [1, 2, 3, 19, 20, 39, 40, 79, 80, 120, 160].map((l) => P.qixCount(l));
  check('two Qix from level 1, another every ten levels after',
    counts, [2, 2, 2, 3, 4, 5, 6, 9, 10, 14, 18]);

  const S = P.S;
  S.level = 9;
  S.state = 'playing';
  P.resetBoard();
  check('level 9 still has two on the board', S.qixes.length, 2);

  S.level = 10;
  P.resetBoard();
  check('level 10 has three', S.qixes.length, 3);
  const gap = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  check('and they start apart from each other',
    S.qixes.length === 3 &&
      gap(S.qixes[0], S.qixes[1]) >= 14 &&
      gap(S.qixes[1], S.qixes[2]) >= 14,
    true);

  S.level = 20;
  P.resetBoard();
  check('level 20 has four', S.qixes.length, 4);

  S.level = 40;
  P.resetBoard();
  check('level 40 has six', S.qixes.length, 6);

  S.level = 80;
  P.resetBoard();
  check('level 80 has ten', S.qixes.length, 10);
  check('and ten of them still start clear of each other', (() => {
    for (let i = 0; i < S.qixes.length; i++) {
      for (let j = i + 1; j < S.qixes.length; j++) {
        if (gap(S.qixes[i], S.qixes[j]) < 14) return false;
      }
    }
    return true;
  })(), true);

  S.level = 1;
  P.resetBoard();
  check('and level 1 starts with two as well', S.qixes.length, 2);
}

// --- the Qix stays alive through the end of a round -------------------------
{
  const S = P.S;
  S.level = 1;
  S.state = 'playing';
  P.resetBoard();

  // A live board animates: the clock the figures breathe off keeps advancing.
  const liveFrom = S.anim;
  P.update(100);
  check('a live board advances the figure clock', S.anim > liveFrom, true);

  // ...and so does the end-of-round recap: a cleared level leaves the Qix
  // writhing behind the notices rather than frozen with the rest of the board.
  S.state = 'levelclear';
  S.timer = 60000;              // a long recap, so nothing hands over mid-check
  S.flash = null;
  S.flashQueue.length = 0;
  const clearFrom = S.anim;
  for (let t = 0; t < 5; t++) P.update(100);
  check('the recap keeps the figure clock running', S.anim > clearFrom + 400, true);

  // ...but a card does freeze it: these are the states that stop the board.
  const pausedFrom = S.anim;
  S.state = 'paused';
  for (let t = 0; t < 5; t++) P.update(100);
  check('a pause still holds it', S.anim, pausedFrom);
}

// --- continuing, and which runs are ranked -----------------------------------
{
  const S = P.S;
  S.state = 'title';
  P.clearTypedLevel();
  P.playVersion(P.VARIANTS.survivors.name);
  check('a run from level 1 is ranked', [S.level, S.ranked], [1, true]);

  // A continue keeps the level but not the score.
  S.score = 123456;
  S.lives = 0;
  S.state = 'gameover';
  P.continueGame();
  check('a continue starts the score again from zero', S.score, 0);
  check('with three lives and the level kept',
    [S.state, S.lives, S.level], ['playing', 3, 1]);

  // Started above level 1: the score is not a high score.
  S.state = 'title';
  P.typeDigit('3');
  P.typeDigit('0');
  P.playVersion(P.VARIANTS.survivors.name);
  check('a run that starts above level 1 is unranked', [S.level, S.ranked], [30, false]);

  S.best = 1000;
  S.score = 999999;
  P.saveBest();
  check('and its score is never recorded as a best', S.best, 1000);

  // ...while a ranked run still is.
  S.ranked = true;
  P.saveBest();
  check('a ranked score is recorded', S.best, 999999);

  // Starting at level 1 again puts it back in the running.
  S.state = 'title';
  P.clearTypedLevel();
  P.playVersion(P.VARIANTS.traps.name);
  check('a fresh run from level 1 ranks again', [S.level, S.ranked], [1, true]);
}

// --- the hidden level picker ------------------------------------------------
{
  const S = P.S;
  S.state = 'title';
  P.clearTypedLevel();

  check('the picker is silent to begin with', P.typedLevelNumber(), 0);
  check('a digit is taken', [P.typeDigit('1'), P.typeDigit('0'), P.typedLevelNumber()],
    [true, true, 10]);
  check('backspace takes one back', [P.backspaceDigit(), P.typedLevelNumber()], [true, 1]);
  check('escape drops it entirely', [P.clearTypedLevel(), P.typedLevelNumber()], [true, 0]);
  check('zero on its own is not a level', [P.typeDigit('0'), P.typedLevelNumber()], [false, 0]);
  check('three digits is the most it takes',
    [P.typeDigit('9'), P.typeDigit('9'), P.typeDigit('9'), P.typeDigit('9')],
    [true, true, true, false]);
  check('...and level 999 is where that ends', P.typedLevelNumber(), 999);
  check('digits outside the menu do nothing', (() => {
    P.clearTypedLevel();
    S.state = 'playing';
    return P.typeDigit('5');
  })(), false);

  // A run started with a number on the menu begins at that level - one shot.
  P.clearTypedLevel();
  S.state = 'title';
  P.typeDigit('2');
  P.typeDigit('0');
  P.playVersion(P.VARIANTS.survivors.name);
  check('the run starts on the level that was typed', S.level, 20);
  check('with the multiplier that level earns', S.multiplier, 3);
  check('and a crowd to match', S.qixes.length, 4); // 2 + floor(20/10)
  check('and the picker is spent', [P.typedLevelNumber(), S.state], [0, 'playing']);

  P.playVersion(P.VARIANTS.traps.name);
  check('so the next new game starts at one again', S.level, 1);

  // The other version starts on the same typed level, not on level 1.
  S.state = 'title';
  P.typeDigit('4');
  P.typeDigit('5');
  P.playVersion(P.VARIANTS.traps.name);
  // The probe's RULES binding is captured once, so read the rules through their
  // behaviour: under Kill the Qwix a kill pays.
  const trapPaid = P.awardTrap(1) > 0;
  check('whichever version is picked starts there', [S.level, trapPaid], [45, true]);
}

// --- Kill the Qwix ends only when the crowd is down to one --------------------
{
  const S = P.S;

  // The kill rules add a second condition to the 85% target.
  P.playVersion(P.VARIANTS.traps.name);
  S.state = 'playing';
  // The probe's RULES binding is captured once, so read the rule by what it does.
  check('kill mode starts with two Qix on the board', S.qixes.length, 2);

  S.percent = 90;
  check('a full board with two still on it is not a clear', P.levelComplete(), false);

  S.qixes.length = 1;
  check('one Qix left and the target met is a clear', P.levelComplete(), true);

  S.qixes.length = 0;
  check('and none left is a clear too', P.levelComplete(), true);

  S.qixes.length = 2;
  S.percent = 84;
  check('without the target it is not a clear either', P.levelComplete(), false);

  // Capture the Qwix is unchanged: the target alone clears it.
  P.playVersion(P.VARIANTS.survivors.name);
  S.qixes.length = 3;
  S.percent = 90;
  check('Capture the Qwix still clears on the target alone', P.levelComplete(), true);
  S.percent = 85;
  check('exactly on the target is enough', P.levelComplete(), true);
}

// --- a killed figure collapses on screen ------------------------------------
{
  const S = P.S;
  S.state = 'playing';
  S.level = 1;
  P.resetBoard();
  check('nothing is dying on a fresh board', S.deaths.length, 0);

  const qix = S.qixes[0];
  P.startQixDeath(qix);
  check('a kill queues the figure for its death', S.deaths.length, 1);
  check('at its own position, with its spines',
    [S.deaths[0].x, S.deaths[0].y, S.deaths[0].segs.length, S.deaths[0].age],
    [qix.x, qix.y, qix.segs.length, 0]);

  P.updateDeaths(200);
  check('it stays for a while', [S.deaths.length, S.deaths[0].age], [1, 200]);
  P.updateDeaths(P.QIX_DEATH_MS);
  check('and then it is gone', S.deaths.length, 0);

  // A crowd losing several at once cannot flood the effect.
  for (let i = 0; i < 8; i++) P.startQixDeath(S.qixes[0]);
  check('at most four are kept', S.deaths.length, 4);

  P.resetBoard();
  check('and a new board clears them', S.deaths.length, 0);

  // The explosion is three staggered rings and a burst of shrapnel, and it takes
  // long enough to read.
  check('the explosion has a ring and shard budget',
    [P.QIX_DEATH_RINGS, P.QIX_DEATH_SHARDS], [3, 16]);
  check('and it lasts the best part of a second', P.QIX_DEATH_MS >= 800, true);
  P.startQixDeath(S.qixes[0]);
  check('the burst is seeded from where it died, so it is reproducible',
    typeof S.deaths[0].seed === 'number' && S.deaths[0].seed >= 0 && S.deaths[0].seed < Math.PI * 2,
    true);
}

// --- a life every million, dearer on deeper levels --------------------------
{
  const S = P.S;
  const step = P.LIFE_EVERY_POINTS;
  check('the first milestone is a million points', step, 1000000);
  check('and its price climbs a hundred thousand a level',
    [1, 2, 11, 41].map((l) => { S.level = l; return P.lifeCost(); }),
    [1000000, 1100000, 2000000, 5000000]);

  S.level = 1;
  S.state = 'playing';
  S.lives = 3;
  S.score = 0;
  S.nextLifeAt = step;

  S.score = step - 1;
  P.checkLifeMilestones();
  check('short of the milestone is no life', S.lives, 3);

  S.score = step;
  P.checkLifeMilestones();
  check('a million buys a life on level 1', S.lives, 4);
  check('and the next one is queued', S.nextLifeAt, step * 2);

  P.checkLifeMilestones();
  check('checking again does not pay twice', S.lives, 4);

  S.score = step * 3;
  P.checkLifeMilestones();
  check('a jump over two milestones pays two lives', S.lives, 6);
  check('and lands on the next one past the score', S.nextLifeAt, step * 4);

  S.score = step * 4 + step / 2;
  P.checkLifeMilestones();
  check('however far it jumps, it keeps up',
    [S.lives, S.nextLifeAt], [7, step * 5]);
}

// --- on a deeper level the gap between lives grows --------------------------
{
  const S = P.S;
  const step = P.LIFE_EVERY_POINTS;

  S.level = 21;                  // a life now costs 1M + 20 x 100k = 3M
  S.state = 'playing';
  S.lives = 3;
  S.score = 0;
  S.nextLifeAt = step;           // one landmark carried over from earlier levels

  S.score = step;
  P.checkLifeMilestones();
  check('the landmark already stood on is still paid', S.lives, 4);
  check('but the next one is three million further on', S.nextLifeAt, step * 4);

  S.score = step * 4 - 1;
  P.checkLifeMilestones();
  check('and a point short of it buys nothing', S.lives, 4);

  S.score = step * 4;
  P.checkLifeMilestones();
  check('the full premium does', S.lives, 5);
  check('which pushes the next landmark out by another premium', S.nextLifeAt, step * 7);
}

// --- the two scoring variants ----------------------------------------------
{
  check('the default rules keep them alive (Capture)',
    [P.RULES.name, P.RULES.trapBonus, P.RULES.survivorBonus], ['survivors', false, true]);
  check('the other pays for a kill instead',
    [P.VARIANTS.traps.trapBonus, P.VARIANTS.traps.survivorBonus], [true, false]);

  // The pot itself: nothing for the first Qix, one share per extra.
  const m = P.SURVIVOR_BONUS;
  check('one Qix alive is worth nothing extra',
    [P.survivorBonusFor(0, 1), P.survivorBonusFor(1, 1)], [0, 0]);
  check('each one beyond the first is a share',
    [P.survivorBonusFor(2, 1), P.survivorBonusFor(3, 1), P.survivorBonusFor(4, 1)],
    [m, m * 2, m * 3]);
  check('and the multiplier applies', P.survivorBonusFor(3, 2), m * 4);

  // The menu names the two versions, and the names are the author's.
  check('Capture keeps them and Kill erases one',
    [P.VARIANTS.survivors.label, P.VARIANTS.traps.label],
    ['Capture the Qwix', 'Kill the Qwix']);
  check('and the first of them is the one a run starts on',
    P.RULES.name, 'survivors');

  // Each menu button swaps the rules before the board is built. P.RULES is a
  // capture of the value, so the proof is what the game then pays for a kill.
  const S = P.S;
  S.state = 'playing';
  S.trapDone = false;
  S.multiplier = 1;
  S.score = 0;
  P.playVersion(P.VARIANTS.traps.name);
  check('Kill the Qwix pays for a kill', P.awardTrap(1) > 0, true);

  S.trapDone = false;
  P.playVersion(P.VARIANTS.survivors.name);
  check('Capture the Qwix pays nothing for one', P.awardTrap(1), 0);

  // ...and leave the game on the default for anything that follows.
  P.playVersion(P.VARIANTS.survivors.name);
}

// --- the survivors variant in play -----------------------------------------
{
  const S = P.S;
  const rules = P.RULES;
  const wasTrap = rules.trapBonus;
  const wasSurvivor = rules.survivorBonus;

  // This block drives the flags directly, so set them rather than assuming what
  // the menu last left behind.
  rules.trapBonus = true;
  rules.survivorBonus = false;
  S.trapDone = false;
  check('in the traps rules a walled-in Qix pays out', P.awardTrap(1) > 0, true);

  // The banner names what was caught without inventing a plural: two Qix, so
  // "2 QIX KILLED", never "QIXES".
  S.trapDone = false;
  S.flashQueue.length = 0;
  P.awardTrap(2);
  // Notices are queued now, so the banner is the head of the queue.
  const banner = S.flashQueue[0] || { text: '' };
  check('the kill banner says QIX for two as well',
    [/^2 QIX KILLED/.test(banner.text), /QIXES/.test(banner.text)],
    [true, false]);

  rules.trapBonus = false;
  rules.survivorBonus = true;
  S.trapDone = false;
  check('in the survivors rules a kill pays nothing', P.awardTrap(1), 0);

  // A clear with three Qix alive: two extra shares, and a multiplier step of
  // two, which the area bonus is then paid at. The level clock is parked on par
  // so the speed demon bonus stays out of these sums.
  S.state = 'playing';
  S.level = 6;
  S.percent = 90;   // five over the target
  S.score = 0;
  S.multiplier = 1;
  S.qixes = [{}, {}, {}];
  S.levelAge = P.parMs();
  S.flashQueue.length = 0;
  P.finishLevel(0);
  check('clearing with three Qix alive pays two shares',
    S.clearInfo.survivors, P.SURVIVOR_BONUS * 2);
  check('and reports all three, not just the two that paid',
    S.clearInfo.qixesAlive, 3);
  // The end of a round is a queue of notices across the board, not a card.
  const notices = () => S.flashQueue.map((n) => n.text);
  // At x1 there is no multiplier tail at all - '1x bonus' is not information.
  check('the recap names the capture and what it paid',
    notices().some((t) => t ===
      'Qwix Captured: ' + S.clearInfo.survivors.toLocaleString('en-US')), true);
  check('and no notice mentions a multiplier at all',
    notices().some((t) => /\dx/.test(t) || /bonus x/.test(t) || /x bonus/.test(t)), false);
  check('and "Qix" is the plural too, never "Qixes"',
    notices().some((t) => /Qixes/.test(t)), false);
  check('and the multiplier is not moved by it', S.multiplier, 1);
  const overPot = 5 * P.OVER_TARGET_PER_PERCENT;
  check('the area bonus is paid at the multiplier for the level',
    [S.clearInfo.bonus, S.score], [overPot, P.SURVIVOR_BONUS * 2 + overPot]);

  // A clear with one Qix alive pays no extra at all.
  S.state = 'playing';
  S.percent = 90;
  S.score = 0;
  S.multiplier = 1;
  S.qixes = [{}];
  S.levelAge = P.parMs();
  S.flashQueue.length = 0;
  P.finishLevel(0);
  check('a clear with one Qix left pays no survivor bonus',
    [S.clearInfo.survivors, S.clearInfo.qixesAlive], [0, 1]);
  // No money for a crowd of one, and no notice pretending otherwise.
  check('and there is no capture notice at all',
    [S.clearInfo.survivors, S.clearInfo.extraQixes,
      notices().some((t) => /Qwix Captured/.test(t))], [0, 0, false]);

  // Put the menu's default rules back for anything that follows - and those are
  // now the "Capture" ones, where the crowd pays.
  rules.trapBonus = wasTrap;
  rules.survivorBonus = wasSurvivor;
  S.state = 'playing';
  S.percent = 90;
  S.score = 0;
  S.multiplier = 1;
  S.qixes = [{}, {}, {}];
  S.levelAge = P.parMs();
  S.flashQueue.length = 0;
  P.finishLevel(0);
  check('back on the default (Capture) rules the same clear pays the pot',
    [S.clearInfo.survivors, S.score],
    [P.SURVIVOR_BONUS * 2, P.SURVIVOR_BONUS * 2 + 5 * P.OVER_TARGET_PER_PERCENT]);
}

// --- a red Sparx hunts ------------------------------------------------------
{
  const S = P.S;
  const E = globalThis.QwixEngine;
  const cols = S.field.cols;
  const rows = S.field.rows;

  S.level = 1;
  S.state = 'playing';
  P.resetBoard(); // fresh board, marker back on the top edge

  check('open ground is not somewhere a Sparx stands',
    [P.sparxCanStand(2, 2), P.sparxCanStand(0, 5)], [false, true]);

  /** Steps left to the marker, from the distance field the chase follows. */
  const routeLeft = (cell) => P.chaseField()[E.index(S.field, cell.x, cell.y)];

  // One Sparx, painted red, put in the far bottom-left corner.
  const s = { x: 1, y: rows - 1, dir: 0, acc: 0, super: true };
  const start = routeLeft(s);
  check('it starts a long way off', start > 90, true);

  // Step it and watch the route to the marker shrink by exactly one each time -
  // it follows the shortest path, so it can never wander off it.
  let last = start;
  let steps = 0;
  let strays = 0;
  let arrived = false;
  for (let i = 0; i < (cols + rows) * 3; i++) {
    S.now += 16; // a new frame, so the distance field is rebuilt
    P.sparxStep(s);
    steps += 1;
    const left = routeLeft(s);
    if (left < 0 || left !== last - 1) strays += 1;
    last = left;
    if (left === 0) {
      arrived = true;
      break;
    }
  }
  check('a red Sparx walks straight to the marker', arrived, true);
  check('in exactly one step per cell of the route', steps, start);
  check('without ever straying off it', strays, 0);

  // A normal one patrols the outline instead: same start, no beeline.
  const normal = { x: 1, y: rows - 1, dir: 0, acc: 0, super: false };
  for (let i = 0; i < start; i++) {
    S.now += 16;
    P.sparxStep(normal);
  }
  check('a normal Sparx is still just patrolling the outline', routeLeft(normal) > 0, true);
}

// --- the two level bonuses: quick wins, and ground past the target ----------
{
  const S = P.S;

  // Par: 20 seconds, on every level - it is not a function of the level.
  check('the par is 20 seconds', P.parMs(), 20000);
  check('and the level does not change it', (() => {
    const was = S.level;
    const at = [1, 11, 51, 400].map((l) => { S.level = l; return P.parMs(); });
    S.level = was;
    return at;
  })(), [20000, 20000, 20000, 20000]);

  // The pot is a rate: 10,000 for each whole second finished inside the par.
  check('the rate is 10,000 a second', P.SPEED_BONUS_PER_SECOND, 10000);
  check('ten seconds under a twenty-second par is ten seconds of pot',
    P.fastWinBonus(10000, 1), 10 * P.SPEED_BONUS_PER_SECOND);
  check('one second under is one second of pot',
    P.fastWinBonus(19000, 1), P.SPEED_BONUS_PER_SECOND);
  check('and the multiplier multiplies it',
    P.fastWinBonus(10000, 4), 10 * P.SPEED_BONUS_PER_SECOND * 4);
  check('part seconds do not count',
    P.fastWinBonus(18500, 1), P.SPEED_BONUS_PER_SECOND);
  check('par exactly pays nothing',
    P.fastWinBonus(20000, 1), 0);
  check('so does anything slower than par',
    [P.fastWinBonus(30000, 1), P.fastWinBonus(900000, 9)], [0, 0]);

  // Durations, as the card prints them.
  check('durations read like a clock',
    [P.duration(0), P.duration(9000), P.duration(72345), P.duration(120000)],
    ['0:00', '0:09', '1:12', '2:00']);

  // Over-target: every point past 85% pays, at the multiplier.
  check('the over-target rate is 2,000 a percent', P.OVER_TARGET_PER_PERCENT, 2000);
  S.state = 'playing';
  S.level = 4;
  S.percent = 100;          // fifteen past the target
  S.score = 0;
  S.multiplier = 2;
  S.qixes = [{}];
  S.levelAge = P.parMs();  // no speed demon bonus in this sum
  P.finishLevel(0);
  check('fifteen points past the target pay the rate times the multiplier',
    S.clearInfo.bonus, 15 * 2000 * 2);
  check('and the level clock is on the card too',
    [S.clearInfo.levelMs, S.clearInfo.parMs], [P.parMs(), P.parMs()]);
  check('exactly on the target pays no over-target bonus', (() => {
    S.state = 'playing';
    S.percent = P.TARGET_PERCENT;
    S.score = 0;
    S.multiplier = 1;
    S.qixes = [{}];
    S.levelAge = P.parMs();
    P.finishLevel(0);
    return S.clearInfo.bonus;
  })(), 0);

  // Both at once: a fast, thorough level pays both pots at the multiplier.
  S.state = 'playing';
  S.level = 4;
  S.percent = 95;           // ten past the target
  S.score = 0;
  S.multiplier = 3;
  S.qixes = [{}];
  S.levelAge = P.parMs() / 2; // half the par used, so half the pot
  S.flashQueue.length = 0;
  P.finishLevel(0);
  const over = 10 * 2000 * 3;
  const quick = 10 * P.SPEED_BONUS_PER_SECOND * 3; // half of a 20 s par is 10 s under
  check('a quick, thorough level pays both pots',
    [S.clearInfo.bonus, S.clearInfo.winBonus, S.score], [over, quick, over + quick]);
  check('and the recap queues a notice for each pot', (() => {
    const texts = S.flashQueue.map((n) => n.text);
    return [
      texts[0],
      texts.some((t) => t ===
        'Over achiever: ' + S.clearInfo.bonus.toLocaleString('en-US')),
      texts.some((t) => t ===
        'Speed bonus: ' + S.clearInfo.winBonus.toLocaleString('en-US')),
    ];
  })(), ['LEVEL 4 CLEAR', true, true]);

  // A slow level won exactly on the target pays no bonuses, and the card does
  // not invent lines for pots that came to nothing.
  S.state = 'playing';
  S.level = 4;
  S.percent = P.TARGET_PERCENT;
  S.score = 0;
  S.multiplier = 1;
  S.qixes = [{}];
  S.levelAge = P.parMs() + 5000;
  S.flashQueue.length = 0;
  P.finishLevel(0);
  check('a slow level on the number pays nothing extra',
    [S.clearInfo.bonus, S.clearInfo.winBonus, S.score], [0, 0, 0]);
  check('and the recap says only that the level is clear', (() => {
    const texts = S.flashQueue.map((n) => n.text);
    return [texts.length, texts[0]];
  })(), [1, 'LEVEL 4 CLEAR']);
}

// --- a Sparx caught by a claim must not freeze -------------------------------
{
  const S = P.S;
  const E = globalThis.QwixEngine;

  // A block of claimed ground with a line running through its middle - which is
  // exactly what is left when a red Sparx has climbed the Stix and the player
  // closes it: the trail becomes shading, and the old Stix a line inside it.
  P.resetBoard();
  S.state = 'playing';
  for (let y = 20; y < 28; y++) {
    for (let x = 30; x < 40; x++) S.field.cells[y * S.field.cols + x] = 1;
  }
  const cx = 35, cy = 24;
  for (let x = 31; x < 39; x++) S.field.lines[cy * S.field.cols + x] = 1;

  check('the Sparx is standing on a line inside claimed ground', [
    E.isLine(S.field, cx, cy), E.isBoundaryCell(S.field, cx, cy)], [true, false]);
  check('which gives it nowhere to walk', E.nextBoundaryStep(S.field, cx, cy, E.RIGHT), null);

  const s = { x: cx, y: cy, dir: E.RIGHT, acc: 0, super: false };
  check('a stranded Sparx is put back on the outline', P.homeSparx(s), true);
  check('and stands on an outline cell', E.isBoundaryCell(S.field, s.x, s.y), true);
  check('somewhere other than where it was stranded', s.x === cx && s.y === cy, false);

  // ...and from there it keeps walking, which is the whole point.
  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    S.now += 16;
    P.sparxStep(s);
    seen.add(s.x + ',' + s.y);
  }
  check('a rescued Sparx carries on patrolling', seen.size > 3, true);

  // Even if the sweep after a claim were skipped, the next step gets it out:
  // a stranded cell has no boundary neighbour, which is the signal to re-home.
  const late = { x: cx, y: cy, dir: E.RIGHT, acc: 0, super: false };
  S.now += 16;
  P.sparxStep(late);
  check('a step taken from a stranded cell homes it as well',
    E.isBoundaryCell(S.field, late.x, late.y), true);

  // The same for a red one, whose chase route out of a buried cell is gone too.
  const red = { x: cx + 1, y: cy, dir: E.RIGHT, acc: 0, super: true };
  S.now += 16;
  P.sparxStep(red);
  check('a stranded red Sparx is not left behind either',
    E.isBoundaryCell(S.field, red.x, red.y) || P.S.field.lines[red.y * 80 + red.x] === 1,
    true);

  // A healthy one is not moved about: the frame is outline enough.
  const onFrame = { x: 0, y: 30, dir: E.RIGHT, acc: 0, super: false };
  check('a Sparx already on the outline is left where it is',
    [P.homeSparx(onFrame), onFrame.x, onFrame.y], [false, 0, 30]);
}

// --- the Sparx turn red when you stop drawing ---------------------------------
{
  const S = P.S;
  const E = globalThis.QwixEngine;
  const p = S.player;

  const letGo = () => {
    for (const d of [E.UP, E.RIGHT, E.DOWN, E.LEFT]) P.release(d);
  };
  const calm = () => {
    S.super = false;
    for (const s of S.sparx) s.super = false;
  };
  // A board with the opening grace already spent, so the hunt clock is live.
  const liveBoard = () => {
    P.resetBoard();
    S.state = 'playing';
    S.level = 1;
    S.awaitingFirstLine = false;
    S.sinceLine = 0;
    letGo();
    calm();
  };

  check('the grace is 15 seconds', P.sparxIdleAllowance(), 15000);
  check('and the level does not change it', (() => {
    const was = S.level;
    const at = [1, 6, 11, 25, 400].map((l) => { S.level = l; return P.sparxIdleAllowance(); });
    S.level = was;
    return at;
  })(), [15000, 15000, 15000, 15000, 15000]);

  // Inactivity is *not drawing*: a Stix holds the clock at zero.
  liveBoard();
  p.x = 40;
  p.y = 0;
  p.dir = E.DOWN;
  p.drawing = true;
  S.sinceLine = 14990;
  P.updateLevelClock(16);
  check('a Stix being drawn resets the clock', S.sinceLine, 0);
  P.updateLevelClock(12000);
  check('and however long the line takes, the wave stays calm', S.super, false);

  // Walking is not activity: it does not touch this clock at all.
  liveBoard();
  p.drawing = false;
  p.x = 40;
  p.y = 0; // on the frame, so a step is a walk and not a Stix
  p.dir = E.RIGHT;
  P.hold(E.RIGHT);
  S.sinceLine = 8000;
  P.updatePlayer(30); // steps along the frame
  check('a step does not touch the hunt clock', S.sinceLine, 8000);
  P.updateLevelClock(16);
  check('so pacing the outline runs the clock like anything else',
    S.sinceLine, 8016);
  letGo();

  // Fifteen seconds of no line at all is enough.
  liveBoard();
  S.sinceLine = P.sparxIdleAllowance() - 1;
  P.updateLevelClock(0);
  check('one millisecond short of it they are still violet', S.super, false);
  S.sinceLine = P.sparxIdleAllowance();
  P.updateLevelClock(0);
  check('fifteen seconds without a line turns them red',
    [S.super, S.sparx.every((s) => s.super)], [true, true]);

  // A Stix, laid down the way the game lays one down: a run of cells from the
  // marker's launch point, with the mask that keeps them in step.
  const layStix = (col, rows) => {
    p.x = col;
    p.y = 0;
    p.dir = E.DOWN;
    p.drawing = true;
    p.allSlow = false;
    p.trail = [];
    p.trailMask = new Uint8Array(S.field.cells.length);
    for (const y of rows) {
      const cell = y * S.field.cols + col;
      p.trail.push(cell);
      p.trailMask[cell] = 1;
    }
  };

  // Drawing again does not call a hunt off - only a death or a cleared level does.
  S.super = true; // already hunting, from the clock above
  for (const s of S.sparx) s.super = true;
  S.sinceLine = 20000;
  layStix(40, Array.from({ length: 58 }, (_, i) => i + 1)); // frame to frame: a split
  P.closeClaim();
  check('drawing and claiming does not call the hunt off',
    [S.sinceLine, S.super], [20000, true]);

  // A death calms them again: red was the run you just lost.
  S.lives = 2;
  S.state = 'dying';
  P.afterDeath();
  check('dying calms the wave',
    [S.state, S.super, S.sparx.length > 0 && S.sparx.some((s) => s.super), S.sinceLine],
    ['playing', false, false, 0]);

  // ...and hands back a full allowance before they hunt again.
  S.state = 'playing';
  S.awaitingFirstLine = false;
  S.sinceLine = P.sparxIdleAllowance() - 1;
  P.updateLevelClock(0);
  check('with the clock started over, a death buys a fresh allowance',
    S.super, false);
  S.sinceLine = P.sparxIdleAllowance();
  P.updateLevelClock(0);
  check('and they hunt again once that is spent', S.super, true);

  // Clearing the level builds a new wave anyway.
  P.resetBoard();
  check('a new level starts with the Sparx calm',
    [S.super, S.sparx.every((s) => !s.super), S.sinceLine], [false, true, 0]);
}

// --- the opening grace ------------------------------------------------------
// A board starts with the hunt clock switched off: it begins when the player draws
// their first line, or after 45 s if they simply sit there.
{
  const S = P.S;
  const E = globalThis.QwixEngine;
  const p = S.player;
  const calm = () => {
    S.super = false;
    for (const s of S.sparx) s.super = false;
  };
  const letGo = () => {
    for (const d of [E.UP, E.RIGHT, E.DOWN, E.LEFT]) P.release(d);
  };
  letGo();

  P.resetBoard();
  S.state = 'playing';
  calm();
  check('a fresh board holds the hunt clock',
    [S.awaitingFirstLine, S.sinceBoard, S.sinceLine], [true, 0, 0]);

  // Fifteen seconds of standing there is not counted at all.
  P.updatePlayer(15000);
  P.updateLevelClock(15000);
  check('fifteen seconds of standing on a fresh board is not counted',
    [S.sinceLine, S.super], [0, false]);

  // The first line is what starts it.
  p.drawing = true;
  P.updateLevelClock(16);
  check('the first Stix starts the clock',
    [S.awaitingFirstLine, S.sinceLine], [false, 0]);
  p.drawing = false;

  // ...and the hold is not indefinite: at 45 s the clock starts anyway.
  P.resetBoard();
  S.state = 'playing';
  calm();
  S.sinceBoard = 44999;
  P.updateLevelClock(0);
  check('one millisecond short of 45 s it is still held',
    [S.awaitingFirstLine, S.super], [true, false]);
  S.sinceBoard = 45000;
  P.updateLevelClock(0);
  check('at 45 s the clock starts',
    [S.awaitingFirstLine, S.sinceLine], [false, 0]);
  P.updateLevelClock(15000);
  check('and fifteen seconds after that they hunt',
    [S.sinceLine, S.super], [15000, true]);

  // A death puts the grace back.
  S.lives = 2;
  S.state = 'dying';
  P.afterDeath();
  check('a death hands back the opening grace',
    [S.awaitingFirstLine, S.sinceBoard, S.sinceLine], [true, 0, 0]);
}

// --- a short Stix gets a longer fuse ----------------------------------------
{
  const S = P.S;
  P.resetBoard();
  S.state = 'playing';
  const p = S.player;

  const grace = (cells) => {
    p.trail = new Array(cells).fill(0);
    return P.fuseGrace();
  };
  check('a line of 50 px or more keeps the usual 420 ms',
    [grace(5), grace(6), grace(40)], [420, 420, 420]);
  check('a cell short of 50 px buys another 120 ms',
    [grace(4), grace(3), grace(2)], [540, 660, 780]);
  check('and a one-cell dab gets 900 ms',
    grace(1), 900);

  // The fuse itself uses it: half a second of stillness, which used to light a
  // one-cell Stix, now does not.
  const lightAfter = (cells, still) => {
    p.drawing = true;
    p.trail = new Array(cells).fill(0);
    p.still = still;
    S.fuse.active = false;
    S.fuse.pos = 0;
    S.fuse.acc = 0;
    P.updateFuse(16);
    return S.fuse.active;
  };
  check('half a second does not light a one-cell fuse',
    lightAfter(1, 500), false);
  check('but the longer grace does', lightAfter(1, 900), true);
  check('a long line still lights at 420 ms', lightAfter(20, 420), true);
  check('and not a millisecond before', lightAfter(20, 419), false);
  p.drawing = false;
  p.still = 0;
}

// --- two keys on a line: keep going, turn as soon as you can -----------------
{
  const S = P.S;
  const E = globalThis.QwixEngine;
  const p = () => S.player;

  const letGo = () => {
    for (const d of [E.UP, E.RIGHT, E.DOWN, E.LEFT]) P.release(d);
  };

  // A block of claimed ground along the top, so the cell below the frame is
  // shading the marker cannot enter - not a line, not the outline, just ground.
  P.resetBoard();
  S.state = 'playing';
  for (let y = 1; y <= 4; y++) {
    for (let x = 4; x <= 8; x++) S.field.cells[y * S.field.cols + x] = 1;
  }

  const start = (x, y, dir) => {
    letGo();
    p().x = x;
    p().y = y;
    p().dir = dir;
    p().drawing = false;
  };

  start(5, 0, E.RIGHT);          // on the frame, heading right
  P.hold(E.RIGHT);               // ...because this key is down
  P.hold(E.DOWN);                // ...and this one wants a turn, which is blocked

  check('the turn below the frame is not walkable',
    [E.isFilled(S.field, 5, 1), P.canStep(E.DOWN)], [true, false]);
  check('so the marker keeps its heading', P.chooseDir(), E.RIGHT);
  check('and takes the step', [P.playerStep(E.RIGHT), p().x, p().y], [true, 6, 0]);
  check('still blocked, still straight on', [P.chooseDir(), P.playerStep(E.RIGHT), p().x], [E.RIGHT, true, 7]);
  check('and again', [P.chooseDir(), P.playerStep(E.RIGHT), p().x], [E.RIGHT, true, 8]);
  check('where the turn finally opens', P.canStep(E.DOWN), true);
  check('and is taken at once rather than one cell later', P.chooseDir(), E.DOWN);
  check('riding the outline, not drawing',
    [P.playerStep(E.DOWN), p().x, p().y, p().drawing, p().dir],
    [true, 8, 1, false, E.DOWN]);

  // While drawing, nothing changes: the newest key or nothing. A Stix is a
  // commitment, and coasting on the old direction would quietly extend it.
  start(40, 0, E.DOWN);
  check('a single key starts a Stix', [P.playerStep(E.DOWN), p().drawing], [true, true]);
  P.hold(E.DOWN);
  P.hold(E.UP);                  // the way back, which a Stix forbids
  check('while drawing, a blocked key is not swapped for the other one',
    [P.chooseDir(), P.canStep(E.UP)], [E.UP, false]);
  check('so the marker waits instead of coasting', P.playerStep(E.UP), false);
  check('and does not move on the old heading',
    [p().x, p().y], [40, 1]);

  letGo();
}

// --- red has to read on every ground ----------------------------------------
{
  const fills = P.CAPTURE_COLORS;

  check('each level paints its claimed ground a different shade',
    fills.map((_, i) => P.captureColor(i + 1)), fills);

  // The pair is fixed again: violet to patrol, red to hunt, on every level.
  check('the Sparx are violet and red, whatever the level',
    [P.SPARX_CALM, P.SPARX_HUNT], ['#c9a0ff', '#ff4d6d']);

  // So the ground has to stay out of red's way. A tiny HSL helper of its own:
  // this asserts a property of the palette, so it should not borrow the game's.
  const hueOf = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    if (!d) return 0;
    const x = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (x * 60 + 360) % 360;
  };
  check('no level paints its ground a warm colour',
    fills.filter((fill) => hueOf(fill) < 70 || hueOf(fill) > 320), []);
  check('and none of them is the orange that used to swallow the red',
    fills.indexOf('#a85f2a'), -1);

  // The lightness of each ground, so red has an edge on all of them.
  const lumaOf = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  check('every ground is dark enough for a bright red to stand off it',
    fills.map((fill) => lumaOf(fill) < 0.55), [true, true, true, true, true]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
