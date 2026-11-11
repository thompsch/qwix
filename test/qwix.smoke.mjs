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
// Level 1's Sparx pair, which is what the game picks for its green ground.
const SPARX_CALM = '#c9a0ff';
const SPARX_HUNT = '#ff4d6d';

// The real page, so the readout the game looks up can be checked to exist.
const PAGE = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

// Must match the constants at the top of qwix.js.
const COLS = 80;
const ROWS = 60;
const CELL = 10;

const noop = () => {};
/**
 * A stub element that remembers its listeners, so a card button can be pressed
 * the way a player presses it (element.click()) rather than by calling the
 * handler the test guesses it was wired to.
 */
const element = (id, ctx) => {
  const listeners = {};
  return {
    id,
    textContent: '',
    style: {},
    hidden: false,
    className: '',
    addEventListener: (type, fn) => {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    click: () => (listeners.click || []).forEach((fn) => fn({ preventDefault: noop })),
    getContext: () => ctx,
  };
};

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail === undefined ? '' : `  (${detail})`}`); }
};

/**
 * Strict comparison, for the checks that are about a value rather than a plain
 * condition. `check` takes a boolean, so passing it two values would always pass.
 */
const same = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);

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
  // Reset every frame, like moveTos: one entry per Sparx drawn in that frame.
  const sparxPixels = [];
  // The Qix spines: lineTo endpoints drawn with an hsl stroke - nothing else
  // paints that way, so this is exactly the figure's outline.
  const spineTips = [];
  // ...and the grey halo disc drawn under each of them.
  const halos = [];
  // Not reset per frame: a kill rings the board once, and the test looks back.
  const rings = [];
  let lastArc = null;
  let recordedFrom = null;
  // Reset every frame: drawQix emits six moveTo calls from the figure's centre,
  // so the busiest point on the canvas is where each Qix is.
  const moveTos = [];
  // Not reset per frame: the block percentages are painted once, when a claim
  // repaints the field, so they would be lost if this were cleared each frame.
  const texts = [];
  // Reset every frame: exactly what was painted this frame, for "shown at once".
  const frameTexts = [];

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
          const entry = { text: String(text), x: Math.round(x), y: Math.round(y) };
          if (texts.length < 5000) texts.push(entry);
          frameTexts.push(entry);
        };
      }
      if (prop === 'lineTo') {
        return (x, y) => {
          if (String(target.strokeStyle).indexOf('hsl(') === 0) {
            spineTips.push([Math.round(x), Math.round(y)]);
          }
        };
      }
      if (prop === 'arc') {
        return (x, y, r) => {
          lastArc = { x, y, r, style: target.fillStyle };
          // A killed figure's shockwave: an arc *stroked* in hsla. Nothing else
          // strokes that way (live spines use hsl), so this is the death tell.
          if (String(target.strokeStyle || '').indexOf('hsla(') === 0) {
            rings.push({ x, y, r, style: target.strokeStyle });
          }
        };
      }
      if (prop === 'fill') {
        // Only the marker fills pure white, immediately after its own
        // translate, so this pins the marker without guessing at draw order.
        return () => {
          if (target.fillStyle === '#ffffff') {
            markerPixel = lastTranslate;
            return;
          }
          // The Sparx halo: a yellow disc, only when hunting, drawn from the
          // Sparx's own translate.
          if (lastArc && /^rgba\(255, 224, 102/.test(String(target.fillStyle))) {
            halos.push({ x: lastTranslate.x, y: lastTranslate.y, r: lastArc.r });
          }
        };
      }
      if (prop === 'stroke') {
        // A Sparx sets its colours straight after its own translate and then
        // strokes its cross in local coordinates; nothing else uses them. It
        // strokes twice from the same translate, so only the first counts.
        // These are LEVEL 1's pair (violet / red): the game picks a pair per level
        // to suit that level's claimed ground, so a rig that looked at a deeper
        // level would need that level's colours too.
        return () => {
          const style = target.strokeStyle;
          if (style !== SPARX_CALM && style !== SPARX_HUNT) return;
          if (lastTranslate === recordedFrom) return;
          recordedFrom = lastTranslate;
          sparxPixels.push({ x: lastTranslate.x, y: lastTranslate.y, style });
        };
      }
      return noop;
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });

  globalThis.window = globalThis;
  // The variant is chosen from the query string, so every boot states its URL.
  globalThis.location = { search: opts.variant ? '?variant=' + opts.variant : '' };
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
      sparxPixels.length = 0;
      halos.length = 0;
      spineTips.length = 0;
      frameTexts.length = 0;
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
    /**
     * Confirm whatever card is up, the way a player would: the start card, the
     * clearance card and the game-over card all wait for this.
     */
    confirm() {
      keydown({ key: 'Enter', preventDefault: noop });
      advance(60);
    },
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
     * Was a notice with this text painted at some point? Notices are canvas
     * text now, so this is how the tests read what the game announced.
     */
    sawNotice(pattern) {
      return texts.some((t) => (pattern instanceof RegExp ? pattern.test(t.text)
        : t.text === pattern));
    },

    /** Everything painted with fillText in the last frame, in paint order. */
    frameTexts: () => frameTexts.map((t) => t.text),
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

    /** Where every Sparx was drawn in the last frame, in cell coordinates. */
    sparxCells() {
      return sparxPixels.map((px) => ({
        x: Math.round(px.x / CELL - 0.5),
        y: Math.round(px.y / CELL - 0.5),
      }));
    },

    /** Where the Qix spines ended in the last frame, in board pixels. */
    spineTips: () => spineTips.map((t) => t.join(',')),

    /** The grey haloes drawn under the Sparx in the last frame. */
    sparxHalos: () => halos.map((h) => ({ x: Math.round(h.x / CELL - 0.5), y: Math.round(h.y / CELL - 0.5), r: h.r })),

    /** Did any figure die on screen? A kill leaves an expanding hsla ring. */
    sawDeathRing: () => rings.length > 0,

    /** The radii that ring was drawn at, so it can be shown to expand. */
    deathRingRadii: () => [...new Set(rings.map((r) => Math.round(r.r)))],

    /**
     * The colour the Sparx were painted in: violet patrolling, red hunting.
     * They are all painted from the same flag, so any red means the wave is red.
     */
    sparxColour() {
      if (!sparxPixels.length) return 'none';
      return sparxPixels.some((px) => px.style === SPARX_HUNT) ? 'red' : 'violet';
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

    /**
     * Sparx standing where a Sparx cannot stand: off the outline and off a
     * line, which means the shading has closed over them and they are stuck.
     */
    sparxOffOutline() {
      const field = page.board();
      return page.sparxCells().filter((c) =>
        !engine.isBoundaryCell(field, c.x, c.y) && !engine.isLine(field, c.x, c.y));
    },
  };
  return page;
}

/** Advance in slices, checking the marker's footing on every slice. */
/**
 * Advance in slices, checking the marker's footing on every slice. Give it a level
 * and it stops as soon as the level changes, for the same reason goToCorner does:
 * the recap has started and the next board is about to be handed over.
 */
function watchFooting(page, ms, violations, level) {
  for (let elapsed = 0; elapsed < ms; elapsed += 100) {
    if (level !== undefined && page.hud('hud-level') !== level) return false;
    page.advance(Math.min(100, ms - elapsed));
    if (!page.markerOnLine()) violations.push(page.marker());
  }
  return true;
}

/**
 * Walk the frame back to the bottom-left corner, and say whether it worked.
 * Give it a level and it advances in slices, giving up the moment the level
 * changes - a clear mid-walk means the recap is playing and the next board is
 * about to be handed over, and a helper that keeps holding a direction then draws
 * on it.
 */
function goToCorner(target, level) {
  const guarded = level !== undefined;
  const move = (ms) => {
    if (!guarded) { target.advance(ms); return true; }
    for (let t = 0; t < ms; t += 100) {
      if (target.hud('hud-level') !== level) return false;
      target.advance(100);
    }
    return true;
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    target.press('ArrowLeft');
    if (!move(1800)) { target.lift('ArrowLeft'); return false; }
    target.lift('ArrowLeft');
    target.press('ArrowDown');
    if (!move(1800)) { target.lift('ArrowDown'); return false; }
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
      const noticeOf = () => page.texts().map((t) => t.text)
        .find((t) => /^LEVEL \d+ CLEAR$/.test(t));
      const notice = noticeOf();
      if (notice) return { page, cleared: true, level: Number(notice.split(' ')[1]) };
      const title = page.overlayUp() ? page.overlayTitle() : '';
      if (title === 'GAME OVER') break;

      const column = cutColumn(page, tried);
      if (column === null) break;
      tried.add(column);
      const before = page.percent();
      const levelAtStart = page.hud('hud-level');

      page.lift('ArrowDown');
      page.lift('ArrowRight');
      page.lift('ArrowUp');
      page.lift('ArrowLeft');
      // Guarded: if the level changes while walking, the recap has started and
      // this run is over - do not go on to draw on the next board.
      if (!goToCorner(page, levelAtStart)) {
        const done = noticeOf();
        if (done) return { page, cleared: true, level: Number(done.split(' ')[1]) };
        continue;
      }

      page.press('ArrowRight');
      page.advance(column * 22 + 40);
      page.lift('ArrowRight');
      page.press('ArrowUp');
      const walked = watchFooting(page, 2600, swept, levelAtStart);
      page.lift('ArrowUp');
      page.advance(100);

      if (!walked || page.hud('hud-level') !== levelAtStart) {
        const done = noticeOf();
        if (done) return { page, cleared: true, level: Number(done.split(' ')[1]) };
      }

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

  // The halo is a hunting tell, not decoration: a patrolling Sparx has none.
  same('a patrolling Sparx is drawn without a halo',
    [page.sparxHalos().length, page.sparxCells().length], [0, 1]);

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

  // A Sparx can be standing on the Stix a claim closes - a red one is allowed to
  // climb it - and the new shading then leaves it with no outline to walk. It
  // must be put back on one instead of sitting there for the rest of the level.
  const sparx = page.sparxCells();
  check('there are Sparx on the board to look at', sparx.length > 0, JSON.stringify(sparx));
  check('and none of them is stranded off the outline by the claim',
    page.sparxOffOutline().length === 0, JSON.stringify(page.sparxOffOutline()));
  // A stranded Sparx freezes for good, so "it is still moving" is the symptom
  // that matters. A death freezes the whole board by design - and game over
  // freezes it for good - so give it long enough to outlast any death pause, and
  // excuse it when there is a card up or no lives left.
  const startSparx = JSON.stringify(page.sparxCells());
  let moved = false;
  for (let t = 0; t < 2000 && !moved; t += 100) {
    page.advance(100);
    moved = JSON.stringify(page.sparxCells()) !== startSparx;
  }
  const frozenByDesign = page.lives() === 0 || page.overlayUp();
  check('and they are still walking the outline after the claim',
    moved || frozenByDesign,
    startSparx + ' -> ' + JSON.stringify(page.sparxCells()) + ', lives ' + page.lives());

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
// The fuse only lights on a line of FUSE_MIN_CELLS (20) or more, so this draws
// well past that: a 30-cell stroke, still, and the spark walks back down it.
{
  const page = boot();
  console.log('\nthe fuse');
  page.press('ArrowDown');
  page.advance(30 * 30 + 200); // thirty cells of Stix (fast draw is 30 ms a cell)
  page.lift('ArrowDown');
  page.advance(2200 + 30 * 90); // still, then the fuse lights and burns the line
  check('standing still mid-Stix costs a life', page.lives() < 3, 'lives=' + page.lives());
  page.advance(3333);  // respawn, still carrying two lives
  check('the game carries on after a death', page.lives() === 2, 'lives=' + page.lives());
}

// ...and a line shorter than ten is never fatal, however long it is left.
{
  const page = boot();
  console.log('\na short line is safe');
  page.press('ArrowDown');
  page.advance(180); // six cells: under the limit
  page.lift('ArrowDown');
  page.advance(6000); // stand there for six seconds
  check('a six-cell line left standing never lights a fuse', page.lives(), 3);
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
  page.advance(30 * 30 + 200); // thirty cells: long enough for the fuse to light
  page.lift('ArrowDown');

  page.advance(2200 + 30 * 90); // fuse lights, burns down the line, death, respawn
  check('the line cost a life', page.lives() < 3, 'lives=' + page.lives());
  // The marker blinks while invulnerable, so its last painted position can be a
  // frame or two stale: let that run out before reading where it came back to.
  page.advance(2000);
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

// --- the game-over card is a way back to the menu ---------------------------
// "New game" no longer starts a run of its own: it returns the player to the
// chooser, so the version (and the starting level, if they know the trick) is
// theirs to pick rather than one being assumed.
{
  console.log('\nthe game-over card');
  const page = boot();
  page.confirm(); // start from the menu

  // Lose the three lives to the fuse: draw a long line, then stand still and let
  // it burn back. Repeat until the card appears (a Qix may get there first, which
  // is just as good).
  for (let round = 0; round < 12; round++) {
    if (page.overlayUp() && page.overlayTitle() === 'GAME OVER') break;
    page.press('ArrowDown');
    page.advance(1200); // draw down into open space: a Stix long enough to burn
    page.lift('ArrowDown');
    page.advance(6000); // stand still: the fuse lights and walks back to the marker
  }
  same('three deaths bring up the game-over card',
    [page.overlayUp(), page.overlayTitle()], [true, 'GAME OVER']);
  same('which offers the level it ended on, and a way back to the menu',
    [page.el('overlay-button').textContent, page.el('overlay-button-2').textContent],
    ['Continue level 1', 'New game']);

  page.el('overlay-button-2').click();
  page.advance(60);
  same('and New game lands on the menu',
    [page.overlayTitle(), /Which version/.test(page.overlayBody())], ['QWIX', true]);
  same('with both versions to choose from',
    [page.el('overlay-button').textContent, page.el('overlay-button-2').textContent],
    ['Capture the Qwix', 'Kill the Qwix']);
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
    // The end of a round is announced with the same notices as everything else,
    // and there is no card: the next level follows the last notice.
    const levelCleared = result.level;
    same('no summary card is shown', page.overlayUp(), false);
    same('the recap says the level is clear',
      page.sawNotice('LEVEL ' + levelCleared + ' CLEAR'), true);

    // The recap is a stack: by the time the last line is in, every line is on the
    // board in the same frame - and it gets there line by line, each one starting
    // only once the one above it has finished fading in.
    if (page.hud('hud-level') === String(levelCleared)) {
      const seen = [];
      let together = 0;
      for (let t = 0; t < 40 && page.hud('hud-level') === String(levelCleared); t++) {
        page.advance(60);
        const drawn = page.frameTexts();
        for (const text of drawn) if (/CLEAR|bonus|achiever|Qwix|quicker/.test(text)) seen.push(text);
        together = Math.max(together, drawn.filter((text) => /CLEAR|bonus|achiever|Qwix|quicker/.test(text)).length);
      }
      same('the recap shows its whole stack at once',
        [together, new Set(seen).size, together === new Set(seen).size],
        [together, together, true]);
    }

    // The Qix is not frozen by the end of a round: if the recap is still
    // playing, its drawn spines keep flexing behind the notices.
    if (Number(page.hud('hud-level')) === levelCleared) {
      const shapes = [];
      for (let t = 0; t < 5; t++) {
        page.advance(100);
        shapes.push(JSON.stringify(page.spineTips()));
        if (page.hud('hud-level') !== String(levelCleared)) break;
      }
      same('the Qix keeps flexing through the recap', new Set(shapes).size > 1, true);
    }
    // Wait for the recap to run out, catching the level change as it happens, so
    // the new board is read before this test's own stray keys can draw on it.
    // The helper stops the moment the level changes, so the next board may be up
    // already; otherwise wait for the recap to run out and catch the change.
    let landedAt = Number(page.hud('hud-level')) === levelCleared + 1
      ? page.percent() : null;
    for (let t = 0; t < 200 && landedAt === null; t++) {
      const before = page.hud('hud-level');
      page.advance(100);
      if (page.hud('hud-level') !== before) {
        landedAt = page.percent();
        break;
      }
    }
    same('and the next level follows on its own',
      Number(page.hud('hud-level')), levelCleared + 1);
    same('which starts on an empty field', landedAt, 0);
  }
}

// --- page 5: splitting two Qix pays out and carries on ------------------
// Level 3 is the first with two Qix. Sealing each one in its own region is
// the big score of that level, and it must NOT end the level: there is still
// 85% of the field to take, now in two separate plots.
//
// The page is booted immortal here. This scenario is about scoring, not
// survival, and a fast erratic Qix eating the marker mid-stroke would turn it
// into a coin flip. Survival is covered by the claim and fuse scenarios above.
{
  console.log('\nsplitting two Qix');
  const swept = [];
  const page = boot({ immortal: true });
  // The menu's second button is "Kill the Qwix", the version where a trap pays
  // for the Qix it takes - which is what this scenario is about. (The default,
  // "Capture the Qwix", pays nothing for a kill.)
  page.el('overlay-button-2').click();
  page.advance(100);
  check('the board starts with two Qix to split', page.qixCells().length === 2,
    JSON.stringify(page.qixCells()));

  let split = false;
  let gained = 0;
  let taken = null;
  let clearedOnTrap = false;
  let percentBeforeTrap = 0; // the board state at the split, for the message

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
  const betweenTheQix = () => {
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
  let paidKill = false; // the trap bonus itself (once a level) was seen paying
  for (let attempt = 0; attempt < 70 && !split; attempt++) {
    if (page.overlayUp()) page.confirm(); // clear whatever card is up
    if (page.overlayUp() && page.overlayTitle() === 'GAME OVER') break;

    const scoreBefore = page.score();
    const percentBefore = page.percent();
    const levelBefore = page.hud('hud-level');
    const figuresBefore = page.qixCells().length;

    // Aim between the figures first: a cut there *is* the split. Only when they
    // are too close to wall off does it fall back to bisecting the open field,
    // which is how a real level gets near 85% - the state where a trap and the
    // target can land on the same stroke.
    const DBG = process.env.QWIX_DEBUG;
    if (DBG) {
      console.log('  [dbg] attempt ' + attempt + ' percent=' + page.percent() +
        ' figures=' + figuresBefore + ' level=' + page.hud('hud-level') +
        ' gap=' + JSON.stringify(betweenTheQix()) +
        ' marker=' + JSON.stringify(page.marker()));
    }
    const pick = () => {
      const gap = betweenTheQix();
      if (gap !== null) return gap;
      // With no usable gap, bisecting is only worth it while there is open ground
      // to take: once the board is mostly ours, filling the last of it only makes
      // the split harder, so wait for the figures to drift apart instead. (Kill
      // the Qwix now needs the split even past 85%, so that matters.)
      return page.percent() >= 70 ? null : cutColumn(page, new Set());
    };
    if (!cut(pick)) continue;

    // A trap takes a figure off the board: one fewer figure than before the
    // stroke *is* the split. The payday is a separate question - the bonus is
    // once per level, so a figure killed later in the same level pays nothing -
    // which is why the money is tracked alongside rather than as the signal.
    if (page.qixCells().length < figuresBefore) {
      const payday = page.score() - scoreBefore;
      if (payday >= 50000) paidKill = true;
      split = true;
      gained = payday;
      const after = page.percent();
      percentBeforeTrap = percentBefore;
      const sameLevel = page.hud('hud-level') === levelBefore;
      // A stroke that also clears the level takes the board away with it, so the
      // percentage can only be compared while the same board is still there.
      taken = (sameLevel && after >= percentBefore) ? after - percentBefore : null;
      clearedOnTrap = !sameLevel || after >= 85;
      continue;
    }

    // No trap: the stroke may have cleared the level. The recap plays out on its
    // own and the next level follows, so wait for it and carry on.
    if (page.hud('hud-level') !== levelBefore) page.advance(9000);
  }

  // A split between the figures is best-effort: by the time the board is past the
  // target the open ground can be a strip with no cut that separates them, and a
  // bot cannot find one that a player could. The payout arithmetic for a split is
  // pinned deterministically in the progression suite; what this live scenario must
  // pin is the rule - and if no split came off, that rule is what gets checked.
  if (!split) {
    check('past the target with both Qix on it is not a clear',
      [page.percent() >= 85, page.hud('hud-level'), page.overlayUp()], [true, '1', false]);
  }
  if (split) {
    check('a trap pays a very large bonus', paidKill || gained >= 50000,
      'gained ' + gained + ' (paidKill=' + paidKill + ')');
    check('one Qix is gone and one still roams', page.qixCells().length === 1,
      JSON.stringify(page.qixCells()));
    // ...and the one that went out did it on screen: the killed figure collapses,
    // ringing the board with an expanding shockwave as it goes.
    check('the killed figure dies on screen', page.sawDeathRing(), true);
    check('and its shockwave grows as it fades', page.deathRingRadii().length > 1,
      JSON.stringify(page.deathRingRadii()));

    if (clearedOnTrap) {
      // Trap and target on the same stroke: the bonus is still paid, and the recap
      // has to own up to it.
      check('a trap on the winning stroke takes the total over the line',
        page.percent() >= 85 || page.hud('hud-level') !== '1',
        'percent=' + page.percent() + ' level=' + page.hud('hud-level'));
      page.advance(12000); // the recap plays its notices in order, two seconds each
      // The kill is announced either as its own banner at the moment it lands or
      // as a line in the recap; either counts.
      check('and the kill is announced',
        page.sawNotice(/Qwix Killed: |QIX KILLED/), true);
    } else {
      check('the ground under the crushed Qix is taken too',
        taken === null || taken > 0, 'percent ' + percentBeforeTrap + ' -> ' + page.percent());
      // The trap alone must never finish a level - only the 85% rule can.
      check('a trap on its own never ends the level', page.percent() < 85,
        'percent=' + page.percent());
    }
  }
  check('no stroke left the marker off its line', swept.length === 0, JSON.stringify(swept.slice(0, 3)));
}

// --- page 6: the Qix steers, it does not jink ------------------------------
// Sample the figure's centre once per frame and look at how much its heading
// changes between frames. A steering limit means a few hundredths of a radian;
// the old snap-to-a-new-jitter model changed direction by up to a radian.
{
  const page = boot({ immortal: true });
  console.log('\nsmooth movement');
  page.press('ArrowRight');  // start the game moving in a straight line
  page.advance(150);
  page.lift('ArrowRight');
  page.advance(200);         // marker stops; the Qix carries on

  const sample = (frames) => {
    const out = [];
    for (let i = 0; i < frames; i++) {
      page.advance(16);
      const centres = page.qixCentres();
      if (centres.length >= 1) out.push(centres[0]); // the first figure drawn
    }
    return out;
  };

  // Turns away from a wall, and the direction snaps among them. A Qix that spends
  // a whole window bouncing along the frame has no away-from-wall frames at all,
  // so keep sampling until there are enough to judge - a jink in any window still
  // counts against it.
  const countJinks = (path) => {
    let jinks = 0;
    let counted = 0;
    let prev = null;
    for (let i = 1; i < path.length; i++) {
      const dx = path[i].x - path[i - 1].x;
      const dy = path[i].y - path[i - 1].y;
      if (Math.hypot(dx, dy) < 0.02) continue; // not moving this frame
      const dir = Math.atan2(dy, dx);
      if (prev !== null) {
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
    return { counted, jinks };
  };

  const first = sample(240);
  let counted = 0;
  let jinks = 0;
  for (let round = 0; round < 8 && counted < 60; round++) {
    const window = round === 0 ? first : sample(240);
    const found = countJinks(window);
    counted += found.counted;
    jinks += found.jinks;
  }

  check('the figure is drawn every frame', first.length > 200, 'frames=' + first.length);
  check('and away from the walls it never snaps direction',
    counted >= 60 && jinks === 0, 'turns=' + counted + ' jinks=' + jinks);
}

// --- page 7: the two variants are a URL away ------------------------------
// It is a chooser now: the question, one button per version, and a way into the
// help. None of the old help text is on it.
{
  console.log('\nthe opening menu');
  const page = boot();
  same('the menu asks which version', page.overlayBody(),
    'Which version do you want to play? Capture the Qwix or Kill the Qwix');
  same('with a button for each version',
    [page.el('overlay-button').textContent, page.el('overlay-button-2').textContent],
    ['Capture the Qwix', 'Kill the Qwix']);
  same('and one for the help',
    [page.el('overlay-button-3').textContent, page.el('overlay-button-3').hidden],
    ['How to play', false]);
  same('the help text is not on the menu',
    [/Claim 85%/.test(page.overlayBody()), /fuse/.test(page.overlayBody())], [false, false]);

  // The version being played is named in the biggest type on the page: under the
  // header, and above the readout and the board.
  const at = (needle) => PAGE.indexOf(needle);
  same('the page names the version under the header',
    [at('id="mode-label"') >= 0,
      at('id="mode-label"') > at('class="topbar"'),
      at('id="mode-label"') < at('class="hud"'),
      at('id="mode-label"') < at('id="field"')], [true, true, true, true]);
  same('and it says which one is being played', page.hud('mode-label'), 'Capture the Qwix');

  // How to play: the card that has the instructions, and Back returns to the menu.
  page.press('h');
  same('H opens the how-to-play card',
    [page.overlayTitle(), page.overlayUp()], ['HOW TO PLAY', true]);
  same('which holds the help that used to be on the menu',
    [/Claim 85% of the field/.test(page.overlayBody()),
      /Hold Shift for a slow draw/.test(page.overlayBody()),
      /the fuse lights/.test(page.overlayBody())], [true, true, true]);
  // Capture keeps them (so a kill pays nothing); Kill erases one and pays for it.
  same('and says what each version pays',
    [/Kill the Qwix: wall a Qix in/.test(page.overlayBody()),
      /Capture the Qwix: a kill pays nothing/.test(page.overlayBody())], [true, true]);
  same('with a single way back', page.el('overlay-button').textContent, 'Back');
  page.confirm();
  same('Back returns to the menu',
    [page.overlayTitle(), /Which version/.test(page.overlayBody())], ['QWIX', true]);

  // The second button starts the second version, and the first starts the first.
  page.el('overlay-button-2').click();
  page.advance(100);
  same('the second button starts a run', page.overlayUp(), false);
  same('and the name at the top follows the version',
    page.hud('mode-label'), 'Kill the Qwix');
  same('and the board is live', [page.hud('hud-level'), page.percent()], ['1', 0]);
}

// The hidden picker: a number typed on the menu names the level the run starts on.
// Nothing advertises it, so the card is unchanged until a digit is pressed.
{
  console.log('\nthe hidden level picker');
  const page = boot();
  const menuText = 'Which version do you want to play? Capture the Qwix or Kill the Qwix';
  same('the menu says nothing about levels until you type', page.overlayBody(), menuText);

  page.press('2');
  page.press('0');
  same('typing a number names the level', page.overlayBody(), menuText + '\nStarting on level 20.');

  page.press('Backspace');
  same('backspace takes a digit back', page.overlayBody(), menuText + '\nStarting on level 2.');

  page.press('Escape');
  same('escape drops it entirely', page.overlayBody(), menuText);

  // Zero is not a level, and a leading zero is not a number.
  page.press('0');
  same('zero alone is ignored', page.overlayBody(), menuText);

  // Now pick level 20 for real, and start the second version from it.
  page.press('2');
  page.press('0');
  page.el('overlay-button-2').click();
  page.advance(100);
  same('the run starts on the level that was typed',
    [page.hud('hud-level'), page.hud('mode-label')], ['20', 'Kill the Qwix']);
  // There is no bonus multiplier in the readout any more, on any level.
  same('and the readout has no bonus multiplier to show', PAGE.indexOf('hud-mult'), -1);
  same('with a crowd to match the level', page.qixCells().length, 4); // 2 + floor(20/10)

  // ...and it is one-shot: a new game goes back to level 1.
  page.el('overlay-button-2').click();
  const fresh = page.reboot();
  fresh.confirm();
  same('and a later new game starts at the beginning again', fresh.hud('hud-level'), '1');
}

// A fresh board holds the hunt clock: nothing counts until the marker moves, or
// until 45 s have gone by with the player sitting there. Measured in the real
// loop, played immortal so a death cannot interrupt the timeline.
{
  console.log('\nthe opening grace');
  const page = boot({ immortal: true });
  page.confirm(); // start from the menu without touching a direction
  same('the menu starts the game', page.overlayUp(), false);
  page.advance(20000);
  same('twenty seconds without moving leaves them violet', page.sparxColour(), 'violet');
  page.advance(26000); // 46 s: the clock has only just been started
  same('and forty-six seconds does too', page.sparxColour(), 'violet');
  page.advance(15000); // 45 s of grace + 15 s of stillness
  same('at sixty seconds they turn', page.sparxColour(), 'red');
}

// Walking the lines is not activity: only a Stix holds the hunt clock, so a player
// pacing the frame still gets hunted - and pacing claims nothing.
{
  console.log('\npacing the line is not activity');
  const page = boot({ immortal: true });
  page.press('ArrowLeft');
  page.advance(120);
  page.lift('ArrowLeft');
  page.advance(45000); // let the opening grace run out; nothing drawn yet
  same('the grace leaves them violet', page.sparxColour(), 'violet');
  // Sixteen seconds of pacing the top frame, half a second each way.
  for (let i = 0; i < 32; i++) {
    const key = i % 2 ? 'ArrowLeft' : 'ArrowRight';
    page.press(key);
    page.advance(500);
    page.lift(key);
  }
  same('sixteen seconds of walking still turns them red', page.sparxColour(), 'red');
  same('and none of that claimed any ground', page.percent(), 0);
}

// Standing still is what turns them. Played immortal, so the marker cannot die
// and reset the clock mid-test.
{
  console.log('\nthe Sparx losing patience');
  const page = boot({ immortal: true });
  page.press('ArrowLeft'); // start, and keep to the frame: no Stix, no claim
  page.advance(120);
  page.lift('ArrowLeft');
  // Walking the frame does not start the hunt clock, so the opening grace has to
  // run out first; then fifteen seconds of no line at all does the rest.
  page.advance(45000);
  check('the Sparx start out violet', page.sparxColour(), 'violet');
  page.advance(14000); // still inside the fifteen seconds
  check('and stay violet within the allowance', page.sparxColour(), 'violet');
  page.advance(1600); // now past it
  check('fifteen seconds without a line turns them red', page.sparxColour(), 'red');
  const halos = page.sparxHalos();
  same('and a hunting Sparx is ringed by a bright halo',
    [halos.length, page.sparxCells().length], [1, 1]);
  same('which is wider than the cross it sits behind',
    halos.length === 1 && halos[0].r > 10, true);
  // And red is for the rest of the level: taking ground restarts the clock but
  // does not call the hunt off.
  const before = page.percent();
  for (let attempt = 0; attempt < 6 && page.percent() === before; attempt++) {
    page.press('ArrowDown');
    for (let t = 0; t < 1600 && page.percent() === before; t += 100) page.advance(100);
    page.lift('ArrowDown');
    page.advance(200);
  }
  check('claiming ground does not call the hunt off',
    page.percent() > before && page.sparxColour() === 'red',
    'percent ' + before + ' -> ' + page.percent() + ', ' + page.sparxColour());
}

// The readout carries a clock: the same S.levelAge the speed demon par is measured
// against, so what the player reads is what the bonus is judged on. Played
// immortal, because a death pauses the clock and the timing would drift.
{
  console.log('\nthe level clock');
  const page = boot({ immortal: true });
  same('the page has a clock in the readout',
    [/id="hud-time"/.test(PAGE), /id="hud-time">0:00</.test(PAGE)], [true, true]);
  page.press('ArrowLeft');
  page.advance(120);
  page.lift('ArrowLeft');
  same('a fresh level starts it at zero', page.hud('hud-time'), '0:00');
  page.advance(4000);
  same('and it counts the seconds you play', page.hud('hud-time'), '0:04');
  same('and it is not amber inside the par', page.el('hud-time').className, 'stat time');
  // The par is 20 s on every level, so the amber line is pinned from both sides:
  // 19 s must still be calm, 21 s must not be.
  page.advance(15000);
  same('nineteen seconds in it is still inside the par',
    [page.el('hud-time').className, page.hud('hud-time')], ['stat time', '0:19']);
  page.advance(2000);
  same('past the 20-second par it turns amber',
    [page.el('hud-time').className, page.hud('hud-time')], ['stat time over', '0:21']);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
