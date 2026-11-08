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
  '  globalThis.__probe = { S, checkLifeMilestones, lifeCost, continueGame, newRun, syncOverlay,'
  + ' resetBoard, qixCount, sparxCount, sparxStepMs, speedAtLevel, qixScale,'
  + ' LIFE_EVERY_POINTS, START_LIVES };\n})();'
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

  // Continue: same level and score, fresh board, lives back.
  P.continueGame();
  check('continue resumes play', S.state, 'playing');
  check('on the level the run ended on', S.level, 7);
  check('with the score intact', S.score, 123456);
  check('and the multiplier intact', S.multiplier, 3);
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

// --- the Qix grows as a level drags on --------------------------------------
{
  const S = P.S;
  S.levelAge = 0;
  check('a fresh level starts at normal size', P.qixScale(), 1);
  S.levelAge = 60000;
  check('a minute in, it is half again as big', P.qixScale(), 1.5);
  S.levelAge = 120000;
  check('two minutes is the cap', P.qixScale(), 1.75);
  S.levelAge = 900000;
  check('and it stops growing there', P.qixScale(), 1.75);
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

// --- another Qix every forty levels ----------------------------------------
{
  const counts = [1, 2, 3, 39, 40, 79, 80, 120, 160].map((l) => P.qixCount(l));
  check('one Qix, a second from level 3, another every forty levels after',
    counts, [1, 1, 2, 2, 3, 3, 4, 5, 6]);

  const S = P.S;
  S.level = 39;
  S.state = 'playing';
  P.resetBoard();
  check('level 39 has two on the board', S.qixes.length, 2);

  S.level = 40;
  P.resetBoard();
  check('level 40 has three', S.qixes.length, 3);
  const gap = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  check('and they start apart from each other',
    S.qixes.length === 3 &&
      gap(S.qixes[0], S.qixes[1]) >= 14 &&
      gap(S.qixes[1], S.qixes[2]) >= 14,
    true);

  S.level = 80;
  P.resetBoard();
  check('level 80 has four', S.qixes.length, 4);

  S.level = 1;
  P.resetBoard();
  check('and level 1 still has just the one', S.qixes.length, 1);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
