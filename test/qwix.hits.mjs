/**
 * Unit tests for the Qix's hit geometry - the one rule that depends on what is
 * being *drawn*: every part of the figure counts, body and spines alike.
 *
 * qwix.js keeps `hitsQix` inside its closure, so this boots the real file with
 * one line added at the bottom that hands the function out on globalThis. The
 * game itself is untouched.
 *
 * Run: node test/qwix.hits.mjs   (or: npm test)
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
// Hand out the internals: the hit test and the two numbers it works with.
const PROBE = GAME.replace(
  '  requestAnimationFrame(frame);\n})();',
  '  globalThis.__probe = { hitsQix, flexQix, QIX_TOUCH, QIX_HIT_WIDTH };\n})();'
);
if (PROBE === GAME) throw new Error('could not hook the game source');

(0, eval)(fs.readFileSync(new URL('../engine.js', import.meta.url), 'utf8'));
(0, eval)(PROBE);
const Q = globalThis.__probe;

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         got ${a}\n         exp ${e}`); }
};

// A figure sitting at the centre of cell (10,10), one spine five cells long
// pointing straight up the grid. Cells, not pixels: the argument is a cell index.
const qix = {
  x: 10.5,
  y: 10.5,
  segs: [{ a: -Math.PI / 2, angle: -Math.PI / 2, reach: 5 }],
};
const hits = (x, y) => Q.hitsQix(qix, x, y);

console.log('the body');
check('the centre of the figure is lethal', hits(10, 10), true);
check('the rim of the body is lethal', hits(10, 7), true);
check('clear of the body and the spine is safe', hits(12, 7), false);

console.log('\nthe spines');
check('a spine is lethal at its tip', hits(10, 5), true);
check('past the tip is safe', hits(10, 4), false);
// The point of the whole exercise: four cells up the spine is well outside the
// body's three-cell reach, and it still counts.
check('a spine is lethal four cells out, past the body', hits(10, 6), true);
check('half a cell off a spine is lethal', hits(10, 8), true);
check('a cell off a spine is safe - the figure is not a blob', hits(11, 6), false);
check('diagonally clear of everything is safe', hits(13, 13), false);

console.log('\nno spine at all');
check('a bare body still only reaches its own radius',
  Q.hitsQix({ x: 10.5, y: 10.5, segs: [] }, 10, 6), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
