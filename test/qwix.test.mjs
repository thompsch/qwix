/**
 * Offline unit tests for ../engine.js - the rules of the game
 * without a browser, a canvas or a clock. No dependencies.
 * Run: node test/qwix.test.mjs   (or: npm test)
 */
import fs from 'node:fs';

// engine.js is a plain browser script; Node just needs a global to attach to.
// eval (not import) so it runs exactly as the <script> tag in index.html runs it.
(0, eval)(fs.readFileSync(new URL('../engine.js', import.meta.url), 'utf8'));
const E = globalThis.QwixEngine;

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         got ${a}\n         exp ${e}`); }
};
const near = (name, actual, expected) => check(name, Math.round(actual * 1000) / 1000, expected);

// A 10x10 board: 8x8 interior (64 claimable cells) inside a one-cell frame.
const board = () => E.createField(10, 10);
const at = (x, y) => y * 10 + x;
const cellAt = (field, cell) => [E.cellX(field, cell), E.cellY(field, cell)];

// --- the playfield ---------------------------------------------------------
{
  const f = board();
  check('the frame is claimed', [E.isFilled(f, 0, 0), E.isFilled(f, 9, 4), E.isFilled(f, 4, 9)], [true, true, true]);
  check('the interior starts open', [E.isFilled(f, 1, 1), E.isFilled(f, 8, 8)], [false, false]);
  check('outside the board counts as solid', [E.isFilled(f, -1, 5), E.isFilled(f, 10, 5)], [true, true]);
  check('claimable counts the interior only', f.claimable, 64);
  check('a fresh level reads 0%', E.percentFilled(f), 0);
  check('the open interior is one region', E.floodRegion(f, at(1, 1)).length, 64);
  check('a claimed cell floods to nothing', E.floodRegion(f, at(0, 0)).length, 0);
  check('opposite flips a direction', [E.opposite(E.UP), E.opposite(E.DOWN), E.opposite(E.LEFT)], [E.DOWN, E.UP, E.RIGHT]);
}

// --- boundary detection and the right-hand rule -----------------------------
{
  const f = board();
  check('a frame cell is a boundary cell', E.isBoundaryCell(f, 0, 5), true);
  check('an open cell is never a boundary cell', E.isBoundaryCell(f, 5, 5), false);

  const step1 = E.nextBoundaryStep(f, 1, 0, E.RIGHT);
  check('a Sparx runs straight along the frame', [step1.x, step1.y, step1.dir], [2, 0, E.RIGHT]);
  const step2 = E.nextBoundaryStep(f, 9, 0, E.RIGHT);
  check('and turns the corner instead of leaving the board', [step2.x, step2.y, step2.dir], [9, 1, E.DOWN]);

  // Walking the outline from a corner must come back to it, having visited
  // every frame cell exactly once: 2*10 + 2*8 = 36 of them.
  let x = 0, y = 0, dir = E.RIGHT, visited = 0;
  for (let i = 0; i < 200; i++) {
    const next = E.nextBoundaryStep(f, x, y, dir);
    if (!next) break;
    x = next.x; y = next.y; dir = next.dir; visited++;
    if (x === 0 && y === 0) break;
  }
  check('the outline walk closes its loop', [x, y], [0, 0]);
  check('after exactly one lap of the frame', visited, 36);
}

// --- capture: a Stix that splits the board --------------------------------
// A vertical line down x=3, from the top frame to the bottom frame, leaves a
// 2-wide strip on the left (16 cells) and a 5-wide block on the right (40).
{
  const f = board();
  const trail = [];
  for (let y = 1; y <= 8; y++) trail.push(at(3, y));
  const res = E.resolveClaim(f, trail, [at(7, 4)]);

  check('the Stix becomes solid ground', trail.every((c) => f.cells[c] === E.FILLED), true);
  check('the side the Qix is not on is claimed', res.claimed.length, 16);
  check('and it is the left strip', res.claimed.every((c) => E.cellX(f, c) <= 2), true);
  near('the Stix counts as claimed ground too', res.percent, 37.5);
  check('one Qix cannot be split', res.split, false);
  check('the Qix keeps its region open', f.cells[at(7, 4)], E.EMPTY);
  const region = res.qixRegions[res.qixRegionIds[0]];
  check('the kept region is exactly the right block', region.length, 40);
}

// --- capture: a Stix that encloses nothing --------------------------------
// One square step out of the frame and straight back in: the trail is solid but
// no area got sealed off, so nothing is won.
{
  const f = board();
  const res = E.resolveClaim(f, [at(1, 1)], [at(7, 4)]);
  check('a bump that seals nothing scores nothing', res.claimed.length, 0);
  near('but the ground it drew is still claimed', res.percent, 1.563);
}

// --- capture: two Qix ---------------------------------------------------
// Level 3+ has two Qix. A Qix only holds ground while it has the roomiest
// patch to run in: cut the board so each one is alone and the one in the
// smaller patch is crushed, its ground taken, while the other keeps its own.
{
  const f = board();
  const trail = [];
  for (let y = 1; y <= 8; y++) trail.push(at(3, y));
  const res = E.resolveClaim(f, trail, [at(1, 4), at(7, 4)]);
  check('two Qix in two regions is a split', res.split, true);
  check('and the ids differ', res.qixRegionIds[0] !== res.qixRegionIds[1], true);
  check('the Qix boxed into the smaller patch is the one that loses',
    [res.qixRegionIds[0] !== res.keptRegionId, res.qixRegionIds[1] === res.keptRegionId],
    [true, true]);
  check('its ground is taken with the rest', res.claimed.length, 16);
  check('the roomiest patch stays open for the other Qix',
    [E.isFilled(f, 1, 4), E.isFilled(f, 7, 4)], [true, false]);
  near('so the board is not full and the level goes on', res.percent, 37.5);
}
{
  const f = board();
  const trail = [];
  for (let y = 1; y <= 8; y++) trail.push(at(3, y));
  const res = E.resolveClaim(f, trail, [at(6, 4), at(7, 4)]);
  check('two Qix sharing a region is not a split', res.split, false);
  check('the free side is still claimed', res.claimed.length, 16);
  check('and the shared half stays open for them', res.percent, 37.5);
}

// --- edge cases -----------------------------------------------------------
{
  const f = board();
  const res = E.resolveClaim(f, [at(1, 1)], [at(1, 1)]);
  check('a Qix caught under the line is lifted to open ground', res.qixRegionIds[0] >= 0, true);
}
{
  const f = board();
  check('nearestEmpty finds the cell next to the frame', E.nearestEmpty(f, at(0, 0), 4), at(1, 1));
  E.setFilled(f, 1, 1, true);
  check('and skips claimed ground', cellAt(f, E.nearestEmpty(f, at(0, 0), 4)), [2, 1]);
  const full = board();
  full.cells.fill(E.FILLED);
  check('a board with no open cell has no nearest empty cell', E.nearestEmpty(full, at(5, 5), 8), -1);
  check('and reads 100%', E.percentFilled(full), 100);
}

// --- the marker rides the lines -------------------------------------------
// Claimed ground is solid: only its outline is walkable, never its interior.
{
  const f = board();
  const trail = [];
  for (let y = 1; y <= 8; y++) trail.push(at(3, y));
  E.resolveClaim(f, trail, [at(7, 4)]); // the left strip plus the Stix column

  check('the outline of captured ground is a line', E.isBoundaryCell(f, 3, 4), true);
  check('the shaded interior is not a line',
    [E.isBoundaryCell(f, 1, 4), E.isBoundaryCell(f, 2, 4)], [false, false]);
  check('the frame is always a line',
    [E.isBoundaryCell(f, 0, 4), E.isBoundaryCell(f, 9, 9), E.isBoundaryCell(f, 4, 9)],
    [true, true, true]);

  const rescued = E.nearestBoundaryCell(f, at(1, 4), 8);
  check('a marker stranded in the shading is put back on a line',
    E.isBoundaryCell(f, E.cellX(f, rescued), E.cellY(f, rescued)), true);
  check('a marker already on a line stays exactly where it is',
    E.nearestBoundaryCell(f, at(3, 4), 8), at(3, 4));
  check('a marker on the frame is left alone',
    E.nearestBoundaryCell(f, at(0, 4), 8), at(0, 4));
}

// --- old Stix lines stay walkable -----------------------------------------
// A line that closed an area becomes ground, but it is remembered as a line.
// When later claims close the shading over it, it is still the way through.
{
  const f = board();
  check('a fresh board has no lines on it', E.isLine(f, 1, 1), false);

  const firstLine = [];
  for (let y = 1; y <= 8; y++) firstLine.push(at(3, y));
  E.resolveClaim(f, firstLine, [at(7, 4)]);
  check('the line that closed an area is remembered', E.isLine(f, 3, 4), true);
  check('and it is walkable while it is still the outline', E.isWalkable(f, 3, 4), true);

  // A second claim takes everything to its right, so the old line ends up with
  // claimed ground on both sides.
  const secondLine = [];
  for (let y = 1; y <= 8; y++) secondLine.push(at(7, y));
  E.resolveClaim(f, secondLine, [at(8, 4)]);

  check('the old line is no longer an outline', E.isBoundaryCell(f, 3, 4), false);
  check('but it is still a line', E.isLine(f, 3, 4), true);
  check('so the marker can still travel it', E.isWalkable(f, 3, 4), true);
  check('plain shaded ground is still not walkable', E.isWalkable(f, 2, 4), false);
  check('the frame always is', E.isWalkable(f, 0, 4), true);
  check('and open ground never is - you draw instead', E.isWalkable(f, 8, 4), false);

  const rescued = E.nearestWalkableCell(f, at(2, 4), 4);
  check('a marker stranded in the shading is put onto the old line',
    E.isLine(f, E.cellX(f, rescued), E.cellY(f, rescued)), true);
  check('a marker already on a walkable cell stays put',
    E.nearestWalkableCell(f, at(3, 4), 4), at(3, 4));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

