/**
 * Headless smoke test for ../qwix.js - the game loop, not the rules
 * (those are in qwix.test.mjs). A stub DOM, a stub canvas and a hand-cranked
 * clock are enough to drive the real script: boot it, press keys, run frames,
 * and check the readout moves the way the game should.
 *
 * Each "page" is a fresh boot of the script, so one scenario's deaths and
 * claims cannot leak into the next.
 *
 * Run: node test/qwix.smoke.mjs   (or: npm test)
 */
import fs from 'node:fs';

const ENGINE = fs.readFileSync(new URL('../engine.js', import.meta.url), 'utf8');
const GAME = fs.readFileSync(new URL('../qwix.js', import.meta.url), 'utf8');

// Must match the constants at the top of qwix.js.
const COLS = 80;
const ROWS = 60;
const CELL = 10;

const noop = () => {};
const element = (id, ctx) => ({
  id,
  textContent: '',
  style: {},
  hidden: false,
  className: '',
  addEventListener: noop,
  getContext: () => ctx,
});

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail === undefined ? '' : `  (${detail})`}`); }
};

/**
 * Boot the real game against a fake page. Returns the rig used to play it:
 * press/lift keys, advance the clock a number of milliseconds, read the HUD.
 *
 * The fake 2d context is not passive: it records the claimed-area rectangles
 * that paintField draws and the pixel the marker is translated to, which is
 * enough to rebuild the board and ask the engine whether the marker is standing
 * somewhere legal.
 *
 * `options.immortal` boots a copy of the game with killPlayer() neutered, for
 * the scenarios that are about scoring and progression rather than survival -
 * otherwise a Qix eating the marker mid-stroke turns those into coin flips.
 */
function boot(options) {
  const opts = options || {};
  const els = {};
  let keydown = null;
  let keyup = null;
  let raf = null;
  let clock = 0;

  const claimed = new Set();
  const lineCells = new Set();
  let lastTranslate = { x: 0, y: 0 };
  let markerPixel = null;
  // Reset every frame: drawQix emits six moveTo calls from the figure's centre,
  // so the busiest point on the canvas is where each Qix is.
  const moveTos = [];
  // Not reset per frame: the block percentages are painted once, when a claim
  // repaints the field, so they would be lost if this were cleared each frame.
  const texts = [];

  const ctx = new Proxy({}, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'fillRect') {
        // paintField fills the whole board first, then the claimed runs, then
        // the old Stix lines in a translucent white on top of them.
        return (x, y, w, h) => {
          if (h === ROWS * CELL) { claimed.clear(); lineCells.clear(); return; }
          if (h !== CELL) return;
          const into = String(target.fillStyle || '').indexOf('rgba') === 0 ? lineCells : claimed;
          const row = Math.round(y / CELL);
          for (let col = Math.round(x / CELL); col < Math.round((x + w) / CELL); col++) {
            into.add(row * COLS + col);
          }
        };
      }
      if (prop === 'translate') {
        return (x, y) => { lastTranslate = { x, y }; };
      }
      if (prop === 'moveTo') {
        // Sparx and the marker moveTo local coordinates after a translate, which
        // are negative; board-space points are the interesting ones. Kept exact
        // (not rounded) so the Qix's sub-pixel drift is measurable.
        return (x, y) => {
          if (x >= 0 && y >= 0) moveTos.push([x, y]);
        };
      }
      if (prop === 'fillText') {
        return (text, x, y) => {
          if (texts.length < 400) texts.push({ text: String(text), x: Math.round(x), y: Math.round(y) });
        };
      }
      if (prop === 'fill') {
        // Only the marker fills pure white, immediately after its own
        // translate, so this pins the marker without guessing at draw order.
        return () => {
          if (target.fillStyle === '#ffffff') markerPixel = lastTranslate;
        };
      }
      return noop;
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });

  globalThis.window = globalThis;
  globalThis.addEventListener = noop;
  globalThis.document = {
    getElementById: (id) => (els[id] ??= element(id, ctx)),
    createElement: (tag) => {
      const node = element(tag, ctx);
      node.width = 0;
      node.height = 0;
      return node;
    },
    querySelectorAll: () => [],
    addEventListener: (type, fn) => {
      if (type === 'keydown') keydown = fn;
      if (type === 'keyup') keyup = fn;
    },
  };
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  globalThis.requestAnimationFrame = (cb) => {
    raf = cb;
    return 1;
  };

  (0, eval)(ENGINE);
  (0, eval)(
    opts.immortal
      ? GAME.replace('function killPlayer() {', 'function killPlayer() { return;')
      : GAME
  );
  const engine = globalThis.QwixEngine;

  const advance = (ms) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 16) {
      clock += 16;
      moveTos.length = 0;
      const cb = raf;
      raf = null;
      if (!cb) throw new Error('the game stopped asking for frames');
      cb(clock);
    }
  };

  const hud = (id) => els[id].textContent;
  const page = {
    el: (id) => els[id],
    advance,
    reboot: () => boot(opts),
    press: (key) => keydown({ key, preventDefault: noop }),
    lift: (key) => keyup({ key }),
    hud,
    percent: () => Number(String(hud('hud-percent')).replace('%', '')),
    score: () => Number(hud('hud-score')),
    lives: () => (String(hud('hud-lives')).match(/\u25C6/g) || []).length,
    overlayUp: () => els.overlay.hidden === false,
    overlayTitle: () => els['overlay-title'].textContent,
    overlayBody: () => els['overlay-body'].textContent,
    lineCount: () => lineCells.size,
    /** Everything painted with fillText, in order. */
    texts: () => texts,
    /**
     * Just the block percentages. Each one is painted twice - a dark offset copy
     * behind it so it reads over the shading - so identical neighbours collapse
     * into one entry.
     */
    blockLabels() {
      const out = [];
      for (const t of texts) {
        if (!/^\d+(\.\d+)?%$/.test(t.text)) continue;
        const last = out[out.length - 1];
        if (last && last.text === t.text &&
            Math.abs(last.x - t.x) < 3 && Math.abs(last.y - t.y) < 3) continue;
        out.push(t);
      }
      return out;
    },

    /** The board as the canvas was last painted. */
    board() {
      const field = engine.createField(COLS, ROWS);
      for (const cell of claimed) field.cells[cell] = 1;
      for (const cell of lineCells) field.lines[cell] = 1;
      return field;
    },
    /** The cell the marker diamond was last drawn in. */
    marker() {
      const px = markerPixel || lastTranslate;
      return { x: Math.round(px.x / CELL - 0.5), y: Math.round(px.y / CELL - 0.5) };
    },
    /**
     * Where every Qix was drawn in the last frame, in cell coordinates. Each
     * figure aims six spines from one centre, so the busiest point is the body.
     */
    qixCells() {
      return page.qixCentres().map((c) => ({ x: Math.round(c.x - 0.5), y: Math.round(c.y - 0.5) }));
    },
    /** The same centres, exactly as drawn: cell coordinates with fractions. */
    qixCentres() {
      const counts = new Map();
      for (const [x, y] of moveTos) {
        const key = x + ',' + y;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      const out = [];
      for (const [key, n] of counts) {
        if (n < 5) continue; // six spines from one centre
        const [x, y] = key.split(',').map(Number);
        out.push({ x: x / CELL, y: y / CELL });
      }
      return out;
    },
    /**
     * The rule under test: the marker either stands in open space (drawing) or
     * on a line - the outline of claimed ground, or an old Stix line through it.
     */
    markerOnLine() {
      if (!markerPixel) return true;
      const field = page.board();
      const at = page.marker();
      if (!engine.isFilled(field, at.x, at.y)) return true;
      return engine.isWalkable(field, at.x, at.y);
    },
  };
  return page;
}

/** Advance in slices, checking the marker's footing on every slice. */
function watchFooting(page, ms, violations) {
  for (let elapsed = 0; elapsed < ms; elapsed += 100) {
    page.advance(Math.min(100, ms - elapsed));
    if (!page.markerOnLine()) violations.push(page.marker());
  }
}

/** Walk the frame back to the bottom-left corner, and say whether it worked. */
function goToCorner(target) {
  for (let attempt = 0; attempt < 2; attempt++) {
    target.press('ArrowLeft');
    target.advance(1800);
    target.lift('ArrowLeft');
    target.press('ArrowDown');
    target.advance(1800);
    target.lift('ArrowDown');
    const at = target.marker();
    if (at.x === 0 && at.y === ROWS - 1) return true;
  }
  return false;
}

/**
 * The column that splits the open area most evenly, out of the columns that
 * actually have open ground on the bottom row to start a cut from.
 */
function cutColumn(target, skip) {
  const engine = globalThis.QwixEngine;
  const field = target.board();
  let seed = -1;
  for (let x = 1; x <= COLS - 2 && seed < 0; x++) {
    if (!engine.isFilled(field, x, ROWS - 2)) seed = (ROWS - 2) * COLS + x;
  }
  if (seed < 0) return null;

  const region = engine.floodRegion(field, seed);
  const perColumn = new Array(COLS).fill(0);
  for (const cell of region) perColumn[cell % COLS] += 1;

  const usable = [];
  for (let x = 1; x <= COLS - 2; x++) {
    if (perColumn[x] > 0 && !engine.isFilled(field, x, ROWS - 2) && !skip.has(x)) usable.push(x);
  }
  if (!usable.length) return null;

  let running = 0;
  const half = region.length / 2;
  let best = usable[0];
  let bestGap = Infinity;
  for (let x = 1; x <= COLS - 2; x++) {
    running += perColumn[x];
    if (!usable.includes(x)) continue;
    const gap = Math.abs(running - half);
    if (gap < bestGap) { bestGap = gap; best = x; }
  }
  return best;
}

/**
 * Play a level out: bisect the open area with full-height cuts until the level
 * clears. Restarts the game if the Qix wins, and returns the page it ended on.
 */
function clearLevel(startPage, swept) {
  let page = startPage;

  for (let run = 0; run < 40; run++) {
    if (run > 0) {
      page = startPage.reboot();
      page.press('ArrowDown');
      page.advance(100);
    }

    const tried = new Set();
    for (let stroke = 0; stroke < 20; stroke++) {
      const title = page.overlayUp() ? page.overlayTitle() : '';
      if (/^LEVEL \d+ CLEAR$/.test(title)) return { page, cleared: true };
      if (title === 'GAME OVER') break;

      const column = cutColumn(page, tried);
      if (column === null) break;
      tried.add(column);
      const before = page.percent();

      page.lift('ArrowDown');
      page.lift('ArrowRight');
      page.lift('ArrowUp');
      page.lift('ArrowLeft');
      if (!goToCorner(page)) continue;

      page.press('ArrowRight');
      page.advance(column * 22 + 40);
      page.lift('ArrowRight');
      page.press('ArrowUp');
      watchFooting(page, 2600, swept);
      page.lift('ArrowUp');
      page.advance(100);

      if (page.percent() === before) continue; // that cut missed
      // The board changed shape, so columns ruled out before are fair game again.
      tried.clear();
    }
  }
  return { page, cleared: false };
}


// --- page 1: start up and capture a region ---------------------------------
{
  let page = boot();
  console.log('\nthe title card');
  check('the page opens on the title card', page.overlayUp() && page.overlayTitle() === 'QWIX');
  check('a fresh game has three lives', page.lives() === 3, 'lives=' + page.lives());
  check('nothing is claimed yet', page.percent() === 0, 'percent=' + page.percent());
  check('the claimed share is shown as a plain number',
    /^\d+%$/.test(page.hud('hud-percent')), page.hud('hud-percent'));

  page.advance(200);
  check('the title card just idles', page.overlayUp());

  // The frame is a line, so a direction press both starts the game and walks
  // the marker along the top edge to the corner.
  console.log('\nriding the frame');
  page.press('ArrowLeft');
  page.advance(1200);
  page.lift('ArrowLeft');
  check('pressing a direction starts play', !page.overlayUp());
  const edge = page.marker();
  check('the marker can ride the frame', edge.x === 0 && edge.y === 0, JSON.stringify(edge));
  check('and is standing on a line', page.markerOnLine(), JSON.stringify(edge));

  // Out to the middle of the top edge, then straight down until the Stix lands
  // on the bottom frame: that cut leaves the Qix on one side, and the other
  // side is the player's. A Qix taking the marker out mid-stroke is a normal
  // death rather than a bug, and the Qix is quick enough to take all three, so
  // this retries - from a fresh page if it has to.
  console.log('\ndrawing a Stix across the field');
  page.press('ArrowRight');
  page.advance(900);
  page.lift('ArrowRight');

  let claimed = false;
  for (let attempt = 0; attempt < 5 && !claimed; attempt++) {
    if (page.overlayUp() && page.overlayTitle() === 'GAME OVER') {
      page = boot();
      page.press('ArrowDown');
      page.advance(100);
    }
    page.press('ArrowDown');
    // Stop as soon as the capture lands, so the marker never starts a second
    // Stix before the checks below; a death simply runs the stroke out and the
    // next attempt starts again from the respawn point.
    for (let t = 0; t < 2600 && page.percent() <= 30; t += 100) page.advance(100);
    page.lift('ArrowDown');
    page.advance(1400); // let a death resolve and respawn
    claimed = page.percent() > 30;
  }
  check('closing a Stix scores points', page.score() > 0, 'score=' + page.score());
  check('and claims a serious share of the field', claimed, 'percent=' + page.percent());
  check('the number in the readout follows the claim',
    page.hud('hud-percent') === page.percent() + '%', page.hud('hud-percent'));
  check('one cut of half the field does not clear the level',
    page.overlayTitle() !== 'LEVEL 1 CLEAR', page.overlayTitle());
  check('the marker is still standing on a line', page.markerOnLine(), JSON.stringify(page.marker()));
  check('the line that closed the area is kept and drawn',
    page.lineCount() > 0, 'lines=' + page.lineCount());

  const labels = page.blockLabels();
  check('the won block has its percentage written in it', labels.length === 1,
    JSON.stringify(labels));
  check('and that number is the block\'s share of the field',
    labels.length === 1 && Number(labels[0].text.replace('%', '')) > 30,
    labels.length ? labels[0].text : 'none');
  check('written on the board, not off the edge of it',
    labels.length === 1 && labels[0].x > 0 && labels[0].x < COLS * CELL &&
      labels[0].y > 0 && labels[0].y < ROWS * CELL,
    JSON.stringify(labels[0] || null));

  // ...and every step of a long walk has to stay on one.
  console.log('\nwalking the shaded edge');
  const footing = [];
  page.press('ArrowUp');
  watchFooting(page, 1200, footing);
  page.lift('ArrowUp');
  page.press('ArrowLeft');
  watchFooting(page, 1200, footing);
  page.lift('ArrowLeft');
  check('walking never steps into the shaded area', footing.length === 0, JSON.stringify(footing.slice(0, 3)));
}

// --- page 2: abandon a Stix and the fuse comes for you ---------------------
{
  const page = boot();
  console.log('\nthe fuse');
  page.press('ArrowDown');
  page.advance(400);   // a dozen cells of Stix
  page.lift('ArrowDown');
  page.advance(2200);  // stand still: the fuse lights and burns back
  check('standing still mid-Stix costs a life', page.lives() < 3, 'lives=' + page.lives());
  page.advance(3000);  // respawn, still carrying two lives
  check('the game carries on after a death', page.lives() === 2, 'lives=' + page.lives());
}

// --- page 2b: dying on a line puts the marker back where it began ----------
{
  const page = boot();
  console.log('\ndying on a line');
  page.press('ArrowLeft');   // starts the game and walks along the top edge
  page.advance(600);
  page.lift('ArrowLeft');
  // The marker blinks while it is invulnerable, so its last painted position can
  // be a frame or two behind; let the opening blink run out before reading it.
  page.advance(1200);
  const start = page.marker();
  check('the marker is up on the top edge', start.y === 0, JSON.stringify(start));

  page.press('ArrowDown');   // begin a Stix from here, out into open space
  page.advance(300);
  page.lift('ArrowDown');

  page.advance(5000);        // fuse lights (or the Qix arrives), death, respawn

  check('the line cost a life', page.lives() < 3, 'lives=' + page.lives());
  const back = page.marker();
  check('the marker comes back to where that line started',
    back.x === start.x && back.y === start.y, JSON.stringify({ start, back }));
}

// --- page 3: pause, then a badly-flown minute ------------------------------
{
  const page = boot();
  console.log('\npausing');
  page.press('ArrowDown');
  page.advance(100);
  page.press('p');
  page.advance(50);
  check('p pauses the game', page.overlayUp() && page.overlayTitle() === 'PAUSED');
  page.press('p');
  page.advance(50);
  check('p resumes it', !page.overlayUp());

  console.log('\na minute of frantic play');
  const keys = ['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft'];
  let held = 'ArrowDown';
  let thrown = null;
  const missteps = [];
  try {
    for (let i = 0; i < 60; i++) {
      page.lift(held);
      held = keys[i % keys.length];
      page.press(held);
      watchFooting(page, 1000, missteps);
    }
  } catch (err) {
    thrown = err;
  }
  check('random input for a minute runs clean', thrown === null, thrown && thrown.message);
  check(
    'the readout still holds together',
    page.percent() >= 0 && page.percent() <= 100,
    'percent=' + page.percent()
  );
  check('and the marker never wanders into the shading', missteps.length === 0,
    JSON.stringify(missteps.slice(0, 3)));
}

// --- page 4: clear a level ------------------------------------------------
// Level 1 is won at 85% of the field. clearLevel() above does the playing: it
// reads the board back from the canvas, halves the open area with full-height
// strokes, and restarts if the Qix wins.
{
  console.log('\nclearing a level');
  const swept = [];
  const start = boot();
  start.press('ArrowDown');
  start.advance(100);

  const result = clearLevel(start, swept);
  const page = result.page;

  check('85% of the field clears the level', result.cleared, 'percent=' + page.percent());
  check('no stroke left the marker off its line', swept.length === 0, JSON.stringify(swept.slice(0, 3)));
  if (result.cleared) {
    check('the clear card reports the level', /^LEVEL \d+ CLEAR$/.test(page.overlayTitle()), page.overlayTitle());
    const seen = Number(page.hud('hud-level'));
    page.advance(2400); // the card times out on its own
    check('the next level begins', Number(page.hud('hud-level')) > seen,
      seen + ' -> ' + page.hud('hud-level'));
    check('with a fresh, empty field', page.percent() === 0, 'percent=' + page.percent());
  }
}

// --- page 5: splitting two Qixes pays out and carries on ------------------
// Level 3 is the first with two Qixes. Sealing each one in its own region is
// the big score of that level, and it must NOT end the level: there is still
// 85% of the field to take, now in two separate plots.
//
// The page is booted immortal here. This scenario is about scoring, not
// survival, and a fast erratic Qix eating the marker mid-stroke would turn it
// into a coin flip. Survival is covered by the claim and fuse scenarios above.
{
  console.log('\nsplitting two Qixes');
  const swept = [];
  let page = boot({ immortal: true });
  page.press('ArrowDown');
  page.advance(100);

  let cleared = 0;
  for (let guard = 0; guard < 8 && Number(page.hud('hud-level')) < 3; guard++) {
    const result = clearLevel(page, swept);
    if (!result.cleared) break;
    page = result.page;
    page.advance(2400); // the card times out and the next level begins
    cleared += 1;
  }
  check('two levels can be cleared to reach level 3',
    Number(page.hud('hud-level')) >= 3, 'level=' + page.hud('hud-level') + ' after ' + cleared + ' clears');

  const multAtStart = page.hud('hud-mult');
  let split = false;
  let gained = 0;
  let taken = 0;

  /**
   * One full-height cut: walk to the corner, then pick the column, then walk out
   * and stroke straight up. The column is chosen after the walk, because the
   * figures drift the whole time and a stale column misses the gap entirely.
   */
  const cut = (pickColumn) => {
    if (!goToCorner(page)) return false;
    const column = pickColumn();
    if (column === null) return false;
    page.press('ArrowRight');
    page.advance(column * 22 + 40);
    page.lift('ArrowRight');
    page.press('ArrowUp');
    watchFooting(page, 2600, swept);
    page.lift('ArrowUp');
    page.advance(200);
    return true;
  };

  /** The column between the two figures, or null if they are not separable. */
  const betweenTheQixes = () => {
    let pair = page.qixCells();
    for (let i = 0; i < 8 && pair.length === 2 && pair[0].x === pair[1].x; i++) {
      page.advance(200);
      pair = page.qixCells();
    }
    if (pair.length !== 2) return null;
    const left = Math.min(pair[0].x, pair[1].x);
    const right = Math.max(pair[0].x, pair[1].x);
    if (right - left < 2) return null; // too close together to wall off
    return Math.round((left + right) / 2);
  };

  // The first two strokes bisect the open field, which is how a real level gets
  // near 85% - and that is exactly the state where a trap and the target can
  // land on the same stroke. After that the strokes are aimed between the two
  // figures.
  for (let attempt = 0; attempt < 16 && !split; attempt++) {
    if (page.overlayUp()) page.advance(2400); // let any card time out
    if (page.overlayUp() && page.overlayTitle() === 'GAME OVER') break;

    const scoreBefore = page.score();
    const percentBefore = page.percent();

    // Bisect up to ~70% first: that is the state a real level reaches before the
    // figures are split, and the state where a trap and the 85% target can land
    // on the same stroke.
    const bisect = page.percent() < 70 && attempt < 4;
    if (!cut(() => (bisect ? cutColumn(page, new Set()) : betweenTheQixes()))) continue;

    // Only a trap moves the multiplier, so that is the signal that it landed.
    if (page.hud('hud-mult') !== multAtStart) {
      split = true;
      gained = page.score() - scoreBefore;
      taken = page.percent() - percentBefore;
    }
  }

  check('the two figures can be split apart', split, 'no split in 16 attempts');
  if (split) {
    check('a trap pays a very large bonus', gained >= 50000, 'gained ' + gained);
    check('the ground under the crushed Qix is taken too', taken > 0, 'percent +' + taken);
    check('one Qix is gone and one still roams', page.qixCells().length === 1,
      JSON.stringify(page.qixCells()));

    if (page.overlayUp()) {
      // Trap and target on the same stroke: the bonus still has to be paid, and
      // the clearance card has to own up to it.
      check('a trap on the winning stroke takes the total over the line',
        page.percent() >= 85, 'percent=' + page.percent());
      check('and the clearance card shows the trap bonus',
        /trapped on the way out/.test(page.overlayBody()), page.overlayBody());
    } else {
      // The trap alone must never finish a level - only the 85% rule can.
      check('a trap on its own never ends the level', page.percent() < 85,
        page.overlayTitle() + ' at ' + page.percent() + '%');
    }
  }
  check('no stroke left the marker off its line', swept.length === 0, JSON.stringify(swept.slice(0, 3)));
}
// --- page 6: the Qix steers, it does not jink ------------------------------
// Sample the figure's centre once per frame and look at how much its heading
// changes between frames. A steering limit means a few hundredths of a radian;
// the old snap-to-a-new-jitter model changed direction by up to a radian.
{
  const page = boot();
  console.log('\nsmooth movement');
  page.press('ArrowRight');  // start the game moving in a straight line
  page.advance(150);
  page.lift('ArrowRight');
  page.advance(200);         // marker stops; the Qix carries on

  const path = [];
  for (let i = 0; i < 240; i++) {
    page.advance(16);
    const centres = page.qixCentres();
    if (centres.length === 1) path.push(centres[0]);
  }

  let jinks = 0;
  let prev = null;
  let counted = 0;
  for (let i = 1; i < path.length; i++) {
    const dx = path[i].x - path[i - 1].x;
    const dy = path[i].y - path[i - 1].y;
    if (Math.hypot(dx, dy) < 0.02) continue; // not moving this frame
    const dir = Math.atan2(dy, dx);
    if (prev !== null) {
      // Bounces are legitimate instantaneous turns, and they can only happen
      // near a wall. Everything else must obey the steering limit.
      const nearWall =
        path[i].x < 5 || path[i].x > COLS - 5 || path[i].y < 5 || path[i].y > ROWS - 5;
      if (!nearWall) {
        counted += 1;
        let turn = dir - prev;
        while (turn > Math.PI) turn -= Math.PI * 2;
        while (turn < -Math.PI) turn += Math.PI * 2;
        if (Math.abs(turn) > 0.12) jinks += 1;
      }
    }
    prev = dir;
  }

  check('the figure is drawn every frame', path.length > 200, 'frames=' + path.length);
  check('and away from the walls it never snaps direction',
    counted >= 40 && jinks === 0, 'turns=' + counted + ' jinks=' + jinks);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
