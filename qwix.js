/**
 * Qwix - the game: the clock, the player, and the things that want them dead.
 *
 * The rules of the playfield (flood fill, the capture test, the Sparx outline
 * walk) live in engine.js. This file adds input, motion, timing, scoring and a
 * canvas. Load order in index.html: engine.js, then this.
 */
(function () {
  'use strict';

  var E = window.QwixEngine;

  // --- the board ------------------------------------------------------------
  var COLS = 80;
  var ROWS = 60;
  var CELL = 10;
  var W = COLS * CELL; // 800
  var H = ROWS * CELL; // 600

  // --- the rules of the 1981 machine ---------------------------------------
  var TARGET_PERCENT = 85;     // claim this much of the interior to clear a level
  var START_LIVES = 3;
  var SCORE_PER_CELL = 6;
  var SLOW_BONUS = 2;          // an area drawn entirely slow scores double
  var OVER_TARGET_PER_PERCENT = 2000; // each point claimed past the target pays
  var TRAP_BONUS = 50000;      // a Qix walled in and taken: the payday
  var SPEED_BONUS_PER_SECOND = 10000; // ...and 10,000 for every second under par
  var FAST_WIN_PAR_MS = 20000; // the par is 20 seconds for 85% of the board,
                               // on every level - it does not grow with the level
  var SURVIVOR_BONUS = 50000;  // ...or, in the other variant, per Qix left alive
  var LIFE_EVERY_POINTS = 1000000; // a life for the first million...
  var LIFE_LEVEL_STEP = 100000;    // ...and dearer by this much every level after
  var MAX_MULTIPLIER = 9;
  var MULTIPLIER_EVERY_LEVELS = 10; // the bonus multiplier steps up this often

  // --- two ways to score the same game --------------------------------------
  // `traps` is the original: wall a Qix in and it pays 50,000 then and there.
  // `survivors` pays nothing for a kill, and instead hands over a bonus at the
  // end of the level for every Qix still alive beyond the first. Pick with
  // ?variant=survivors on the URL; ?variant=traps is the default.
  // --- the two versions, and what the menu calls them -------------------------
  // "Capture" is the one where you keep them: a kill pays nothing and every Qix
  // still alive at the clear is worth a share. "Kill" is the one where a Qix is
  // erased from the board and pays for it. The labels live here with the rules.
  var VARIANTS = {
    survivors: {
      name: 'survivors', label: 'Capture the Qwix',
      trapBonus: false, survivorBonus: true, requireLastQix: false,
    },
    traps: {
      name: 'traps', label: 'Kill the Qwix',
      trapBonus: true, survivorBonus: false, requireLastQix: true,
    },
  };

  // A run starts on the first of the two - the menu's loud button, which is
  // "Capture the Qwix".
  var RULES = VARIANTS.survivors;

  /**
   * Start a run on one of the two versions. The menu's buttons land here; the
   * rules are swapped before the board is built, so everything downstream - the
   * trap payout, the survivors pot, the help - reads the version that was chosen.
   * A version always starts a fresh run: level 1, no score.
   */
  function playVersion(name) {
    RULES = VARIANTS[name] || VARIANTS.survivors;
    newRun();
  }

  // --- speeds, in milliseconds per cell ------------------------------------
  var MOVE_MS = 22;
  var DRAW_FAST_MS = 30;
  var DRAW_SLOW_MS = 56;
  var SPARX_MS = 88;
  var SUPER_SPARX_MS = 62;
  var SPARX_STEP_CUT_MS = 1;      // each level takes a millisecond off a step...
  var SPARX_STEP_MAX_CUT_MS = 20; // ...up to this much, which is level 21

  // --- timers ---------------------------------------------------------------
  var FUSE_GRACE_MS = 420;     // how long you may stand still before it lights
  var FUSE_STEP_MS = 90;
  // A short Stix is dangerous out of proportion to its length: the spark only has
  // to cross a cell or two, so it reaches the marker almost the instant it lights
  // - a one-cell line kills 90 ms after the fuse appears. Anything shorter than
  // 50 px (five cells) is therefore given extra grace, one burn step's worth for
  // every cell it is short, so a dab of a line is no deadlier than a long one.
  var FUSE_SHORT_PX = 50;
  var FUSE_SHORT_GRACE_MS = 120;
  var DEATH_MS = 1200;
  var INVULN_MS = 1400;
  // Sparx turn hostile - and hunt - once the marker has stood still for this long:
  // 15 seconds, on every level. Moving resets it, so a player who keeps moving is
  // never hunted; a hunt that has started lasts until you die or clear the level.
  var SPARX_IDLE_MS = 15000;
  // A board starts with the hunt clock switched off: it starts when the marker
  // first moves, or after this long if the player simply sits there, so nobody
  // is hunted while they are still reading the board.
  var OPENING_GRACE_MS = 45000;
  var NOTICE_MS = 2000;       // how long a live notice (a kill, a hunting wave) stays
  // The end-of-level recap is a stack, not a queue: every line is on the board at
  // once, each fading in a beat after the one above it.
  var RECAP_FADE_MS = 340;    // how long one line takes to appear
  // Each line starts only once the one above it is fully in, so the stack builds
  // line by line rather than all at once.
  var RECAP_STAGGER_MS = RECAP_FADE_MS;
  var RECAP_HOLD_MS = 1500;   // the whole stack, once the last line is in
  var RECAP_FADE_OUT_MS = 320;
  // One Sparx, plus another every twenty levels: two from level 20, three from
  // 40, and that is as busy as the board gets.
  var SPARX_EVERY_LEVELS = 20;
  var MAX_SPARX = 4;

  // --- the Qix ---------------------------------------------------------------
  // The figure is drawn QIX_SIZE times larger than it started, grows as a level
  // drags on, and every part of it counts: the body is a disc, the spines are
  // lethal along their whole length, and both are drawn from the same numbers
  // the hit test uses. It also keeps its body clear of claimed ground, so the
  // figure stays in open space.
  var QIX_SIZE = 3;
  var QIX_BODY = 2;            // cells of clearance the figure keeps from walls
  var QIX_TOUCH = 3;           // radius of the body, in cells, before growth
  var QIX_HIT_WIDTH = 0.55;    // half-thickness of a spine against marker or stix
  var QIX_DEATH_MS = 900;      // how long a killed figure takes to explode
  var QIX_DEATH_RINGS = 3;     // staggered shockwaves
  var QIX_DEATH_SHARDS = 16;   // flying pieces of the figure

  // Two Qix on every level, and another every ten levels after that (three from
  // 10, four from 20) - a board starts with a crowd, not with one figure.
  var QIX_EVERY_LEVELS = 10;
  var QIX_SPREAD = 14;         // how far apart they start, in cells

  // It gets bigger the longer a level lasts: +75% over two minutes, then no more.
  // Growth is slow on purpose: a level used to be over long before the figure
  // got big, and with two Qix from level 1 a level lasts twice as long, so the
  // old schedule had level 1 running at 1.75x its base size. Five minutes and
  // a ceiling of +50% keeps the early game at the size it always had.
  var QIX_GROWTH_MAX = 0.5;
  var QIX_GROWTH_MS = 300000;

  // Speed steps up every QIX_SPEED_EVERY levels, then tops out. It starts fast
  // and moves in bursts, but never quite faster than the marker can run the
  // border.
  var QIX_BASE_SPEED = 9;      // cells per second on level 1
  var QIX_SPEED_STEP = 2;      // added at each step
  var QIX_SPEED_EVERY = 10;    // levels between steps
  var QIX_MAX_SPEED = 22;

  // It never snaps to a new heading. A heading that wanders on its own, a
  // continuous weave around it, and a steering limit on how fast the figure may
  // turn: that combination curls the path instead of jinking it.
  var QIX_DRIFT_MIN_MS = 900;  // how long a heading lasts...
  var QIX_DRIFT_VAR_MS = 1400; // ...plus up to this much
  var QIX_DRIFT_TURN = 1.1;    // radians the heading swings each time
  var QIX_REVERSE_CHANCE = 0.12;
  var QIX_WEAVE = 0.85;        // radians of continuous weave around the heading
  var QIX_WEAVE_RATE = 0.0016; // radians per millisecond of clock
  var QIX_TURN_RATE = 3.0;     // radians per second the figure may turn
  var QIX_DASH_CHANCE = 0.15;
  var QIX_DASH_MS = 240;
  var QIX_DASH_FACTOR = 1.8;
  var QIX_DASH_GAP_MS = 700;   // how often it considers a lunge

  // Claimed ground, one shade per level. Deliberately all cool: a hunting Sparx
  // is red, so no level may paint its ground orange or red, or the figure would
  // vanish into it (level 4 used to be an orange that swallowed it).
  var CAPTURE_COLORS = ['#1c7a52', '#2a6f9e', '#6b4fa8', '#41547a', '#2a8f95'];
  var SPARX_CALM = '#c9a0ff'; // patrolling
  var SPARX_HUNT = '#ff4d6d'; // hunting - always red, whatever the ground is

  /** The claimed-ground colour for a level. */
  function captureColor(level) {
    var at = Math.max(1, level === undefined ? S.level : level);
    return CAPTURE_COLORS[(at - 1) % CAPTURE_COLORS.length];
  }

  var canvas = document.getElementById('field');
  var ctx = canvas.getContext('2d');
  // The field is repainted only when something is actually claimed, so the
  // frame loop can blit it instead of filling thousands of rectangles.
  var fieldCanvas = document.createElement('canvas');
  fieldCanvas.width = W;
  fieldCanvas.height = H;
  var fieldCtx = fieldCanvas.getContext('2d');

  var hud = {
    score: document.getElementById('hud-score'),
    level: document.getElementById('hud-level'),
    time: document.getElementById('hud-time'),
    lives: document.getElementById('hud-lives'),
    best: document.getElementById('hud-best'),
    percent: document.getElementById('hud-percent'),
    fill: document.getElementById('hud-fill'),
  };
  // The version being played, in the biggest type on the page.
  var modeLabel = document.getElementById('mode-label');
  var overlay = {
    root: document.getElementById('overlay'),
    title: document.getElementById('overlay-title'),
    body: document.getElementById('overlay-body'),
    button: document.getElementById('overlay-button'),
    button2: document.getElementById('overlay-button-2'),
    button3: document.getElementById('overlay-button-3'),
  };

  var S = null;

  // --- state ----------------------------------------------------------------

  function emptyPlayer() {
    return {
      x: Math.floor(COLS / 2),
      y: 0,
      dir: E.LEFT,
      drawing: false,
      trail: [],
      trailMask: new Uint8Array(COLS * ROWS),
      slow: false,
      allSlow: true,
      acc: 0,
      still: 0,
      lineStart: null,
    };
  }

  function newGame() {
    S = {
      state: 'title',
      timer: 0,
      now: 0,
      field: E.createField(COLS, ROWS),
      percent: 0,
      score: 0,
      lives: START_LIVES,
      level: 1,
      multiplier: 1,
      best: readBest(),
      ranked: true,         // false when the run began above level 1 (the picker)
      player: emptyPlayer(),
      qixes: [],
      sparx: [],
      fuse: { active: false, pos: 0, acc: 0 },
      levelAge: 0,
      anim: 0,              // board animation time: runs until a pause or a card
      sinceBoard: 0,        // ms this board has been in front of the player
      awaitingFirstLine: true, // the hunt clock is held until the first Stix
      sinceLine: 0,         // ms since a Stix was last being drawn
      super: false,
      invulnUntil: 0,
      fieldDirty: true,
      clearInfo: null,
      trapDone: false,
      toldNeedKills: false, // the "Qix to go" banner: once a level
      nextLifeAt: LIFE_EVERY_POINTS,
      blocks: [],
      deathSpot: null,
      deaths: [],           // killed figures, still collapsing on screen
      flash: null,
      flashQueue: [],
      recap: null,          // the end-of-level stack: { lines, age }
    };
    resetBoard();
    syncOverlay();
  }

  /** Fresh playfield, fresh enemies, the player back on the top edge. */
  function resetBoard() {
    var p = S.player;
    S.field = E.createField(COLS, ROWS);
    S.percent = 0;
    S.fieldDirty = true;
    p.x = Math.floor(COLS / 2);
    p.y = 0;
    p.dir = E.LEFT;
    clearTrail();
    S.qixes = buildQixes();
    // A new level starts calm, and with the hunt clock held off until the player
    // draws their first line (or has sat there for OPENING_GRACE_MS).
    S.super = false;
    S.sinceBoard = 0;
    S.awaitingFirstLine = true;
    S.sinceLine = 0;
    S.sparx = buildSparxWave();
    S.fuse.active = false;
    S.levelAge = 0; // the level's play clock: the Qix's growth, and the win time
    S.multiplier = bonusMultiplier(); // x1, and one more every ten levels
    S.trapDone = false;
    S.toldNeedKills = false;
    S.blocks = [];
    S.deaths.length = 0;
    S.deathSpot = null;
    S.flash = null;
    S.flashQueue.length = 0;
    S.recap = null;
    S.invulnUntil = S.now + INVULN_MS;
  }

  /**
   * The bonus multiplier for a level: x1 to begin with, one higher every ten
   * levels, capped at 9. Every payout in the game is multiplied by it, so it is
   * the level's own measure of how deep you are - not something a kill moves.
   */
  function bonusMultiplier(level) {
    var at = Math.max(1, level === undefined ? S.level : level);
    return Math.min(MAX_MULTIPLIER, 1 + Math.floor(at / MULTIPLIER_EVERY_LEVELS));
  }

  /**
   * How many Qix a level runs with: two from the very first level, and another
   * every ten levels after that (three from 10, four from 20...).
   */
  function qixCount(level) {
    var at = level === undefined ? S.level : level;
    return 2 + Math.floor(at / QIX_EVERY_LEVELS);
  }

  function buildQixes() {
    var count = qixCount();
    var out = [];
    for (var i = 0; i < count; i++) {
      // Clear of the shading, and clear of the others: a bigger crowd should
      // still read as separate figures.
      var spot = randomEmpty(function (r) {
        if (bodyBlocked(r.x, r.y, QIX_BODY)) return true;
        for (var k = 0; k < out.length; k++) {
          if (Math.abs(r.x - out[k].x) + Math.abs(r.y - out[k].y) < QIX_SPREAD) return true;
        }
        return false;
      });
      var heading = Math.random() * Math.PI * 2;
      out.push({
        x: spot.x,
        y: spot.y,
        heading: heading,
        angle: heading,
        speed: qixSpeed(),
        weave: Math.random() * Math.PI * 2,
        scale: 1,
        driftT: 0,
        dash: 0,
        dashWait: QIX_DASH_GAP_MS,
        hue: Math.random() * 360,
        segs: buildSegments(),
      });
    }
    return out;
  }

  /** Cells per second: a step up every QIX_SPEED_EVERY levels, then a cap. */
  function speedAtLevel(level) {
    var steps = Math.floor((Math.max(1, level) - 1) / QIX_SPEED_EVERY);
    return Math.min(QIX_BASE_SPEED + steps * QIX_SPEED_STEP, QIX_MAX_SPEED);
  }

  function qixSpeed() {
    return speedAtLevel(S.level);
  }

  function buildSegments() {
    var segs = [];
    var base = Math.random() * Math.PI * 2;
    for (var i = 0; i < 6; i++) {
      var len = 0.6 + Math.random() * 1.5;
      segs.push({
        a: base + (i / 6) * Math.PI * 2 + Math.random() * 0.5,
        len: len,
        phase: Math.random() * Math.PI * 2,
        // Filled in every frame by flexQix(); seeded so the very first hit test
        // has something sane to look at.
        angle: base,
        reach: len * QIX_SIZE,
      });
    }
    return segs;
  }

  /**
   * A random open cell, as a point in cell units (integers are cell corners).
   * `avoid` can veto a candidate - the Qix uses it to keep its body clear of
   * the shading when it picks a new home.
   */
  function randomEmpty(avoid) {
    var fallback = null;
    for (var i = 0; i < 400; i++) {
      var x = 1 + Math.floor(Math.random() * (COLS - 2));
      var y = 1 + Math.floor(Math.random() * (ROWS - 2));
      if (E.isFilled(S.field, x, y)) continue;
      var spot = { x: x + 0.5, y: y + 0.5 };
      if (avoid && avoid(spot)) {
        fallback = fallback || spot;
        continue;
      }
      return spot;
    }
    return fallback || { x: COLS / 2, y: ROWS / 2 };
  }

  /** Sparx a level runs with: one, plus another every SPARX_EVERY_LEVELS. */
  function sparxCount(level) {
    var at = level === undefined ? S.level : level;
    return Math.min(MAX_SPARX, 1 + Math.floor(at / SPARX_EVERY_LEVELS));
  }

  /**
   * How long a Sparx takes per cell. It creeps up with the level - a millisecond
   * per level, to a maximum of twenty - so it is always getting quicker without
   * ever becoming a blur.
   */
  function sparxStepMs(s) {
    var cut = Math.min(SPARX_STEP_MAX_CUT_MS, Math.max(0, S.level - 1) * SPARX_STEP_CUT_MS);
    return (s.super ? SUPER_SPARX_MS : SPARX_MS) - cut;
  }

  /**
   * The level's Sparx, spread as far from the marker - and from each other - as
   * the outline allows, so they never arrive in a clump. A new wave takes the
   * mode the level is in: if the level has already turned red, the replacements
   * come back red.
   */
  function buildSparxWave() {
    var out = [];
    var want = sparxCount();
    for (var n = 0; n < want; n++) {
      var best = null;
      var bestScore = -1;
      for (var i = 0; i < 240; i++) {
        var x = Math.floor(Math.random() * COLS);
        var y = Math.floor(Math.random() * ROWS);
        if (!E.isBoundaryCell(S.field, x, y)) continue;
        var score = Math.abs(x - S.player.x) + Math.abs(y - S.player.y);
        for (var k = 0; k < out.length; k++) {
          var apart = Math.abs(x - out[k].x) + Math.abs(y - out[k].y);
          if (apart < score) score = apart;
        }
        if (score > bestScore) {
          bestScore = score;
          best = { x: x, y: y };
        }
      }
      if (!best) break;
      out.push({ x: best.x, y: best.y, dir: E.RIGHT, acc: 0, super: S.super });
    }
    return out;
  }

  function readBest() {
    try {
      return Number(localStorage.getItem('qwix.best')) || 0;
    } catch (err) {
      return 0;
    }
  }

  function saveBest() {
    if (!S.ranked) return; // started above level 1: score does not count
    if (S.score <= S.best) return;
    S.best = S.score;
    try {
      localStorage.setItem('qwix.best', String(S.best));
    } catch (err) {
      /* private mode, no storage: the score simply is not remembered */
    }
  }

  // --- the clock ------------------------------------------------------------

  /**
   * Only the death pause runs on its own. The level-clear card waits for the
   * player, because it is the one moment in the game worth reading.
   */
  function update(dt) {
    updateFlash(dt); // the notices run in every state, including a clear
    // The figures animate off this clock. It runs while the game is live and on
    // through the end-of-level recap, so a cleared level leaves the Qix alive
    // behind the notices; only a pause or a card stops it.
    if (S.state === 'playing' || S.state === 'levelclear') {
      S.anim += dt;
      updateRecap(dt);
      updateDeaths(dt); // a kill landing on the winning stroke still plays out
    }
    if (S.state === 'playing') {
      tick(dt);
      return;
    }
    if (S.state === 'dying') {
      S.timer -= dt;
      if (S.timer <= 0) afterDeath();
    }
    if (S.state === 'levelclear') {
      // No card to dismiss any more: the recap plays out and the next level
      // follows it. Enter/skip still works - see confirmAction.
      S.timer -= dt;
      if (S.timer <= 0 && !S.flash && !S.flashQueue.length && !S.recap) nextLevel();
    }
  }

  /** Off the clearance card and into the next level. */
  function nextLevel() {
    if (S.state !== 'levelclear') return;
    S.level += 1;
    S.clearInfo = null;
    resetBoard();
    S.state = 'playing';
    syncOverlay();
  }

  function tick(dt) {
    S.player.slow = input.slow;
    updatePlayer(dt);
    if (S.state !== 'playing') return;
    updateQix(dt);
    updateSparx(dt);
    if (S.state !== 'playing') return;
    updateFuse(dt);
    if (S.state !== 'playing') return;
    updateLevelClock(dt);
    checkHits();
  }

  // --- the marker and its Stix ---------------------------------------------

  function stepMsFor(player) {
    if (!player.drawing) return MOVE_MS;
    return player.slow ? DRAW_SLOW_MS : DRAW_FAST_MS;
  }

  function updatePlayer(dt) {
    var p = S.player;
    var moved = false;
    if (chooseDir() >= 0) {
      var stepMs = stepMsFor(p);
      p.acc += dt;
      var guard = 0;
      while (p.acc >= stepMs && guard < 4) {
        guard += 1;
        p.acc -= stepMs;
        // Re-ask each step: a turn that was blocked a moment ago may have opened
        // up now the marker has moved a cell closer to it.
        var dir = chooseDir();
        if (dir < 0 || !playerStep(dir)) {
          p.acc = 0;
          break;
        }
        moved = true;
        if (S.state !== 'playing') return;
      }
    } else {
      p.acc = 0;
    }
    // How long the marker has been unable (or unwilling) to move. This is the
    // fuse's clock - it measures stillness, not the key state, so holding a
    // direction into a wall is not a way to stand still safely. The Sparx
    // hunt reads a different clock: how long it has been since a line was
    // drawn (see updateLevelClock).
    p.still = moved ? 0 : p.still + dt;
  }

  /**
   * Which way to step this frame. The newest key held is what the player asked
   * for; with two keys down they have asked for a *turn* while they keep going,
   * so on an existing line the marker holds its heading until the turn is
   * actually available and takes it the moment it is. While drawing a Stix only
   * the newest key counts - a line is a commitment, and the fuse is the price of
   * dithering over it.
   */
  function chooseDir() {
    if (!held.length) return -1;
    var want = held[held.length - 1];
    if (canStep(want)) return want;
    var p = S.player;
    if (p.drawing) return want; // blocked: the marker waits, as it always has
    // Keep the heading, if that key is still down and the way is still clear...
    if (held.indexOf(p.dir) >= 0 && canStep(p.dir)) return p.dir;
    // ...or any other direction still being held, newest first.
    for (var i = held.length - 2; i >= 0; i--) {
      if (canStep(held[i])) return held[i];
    }
    return want;
  }

  /**
   * Would a step in this direction work from where the marker stands? Pure - no
   * moving, no claiming - so a direction can be tried without side effects.
   */
  function canStep(dir) {
    var p = S.player;
    var v = E.VECTORS[dir];
    var nx = p.x + v[0];
    var ny = p.y + v[1];
    if (!E.inBounds(S.field, nx, ny)) return false;
    if (p.drawing) {
      if (dir === E.opposite(p.dir)) return false;            // no backtracking
      return !p.trailMask[E.index(S.field, nx, ny)];           // no crossing your Stix
    }
    // Open space is fine - it starts a Stix. Shaded ground only if it is a line.
    return !E.isFilled(S.field, nx, ny) || E.isWalkable(S.field, nx, ny);
  }

  /**
   * One cell of movement. With no Stix out the marker can only walk the line it
   * is standing on - the frame, or the outline of claimed ground - and stepping
   * into open space starts a Stix. Stepping back onto claimed ground from a
   * Stix closes it, which is the only way to win anything.
   */
  function playerStep(dir) {
    if (!canStep(dir)) return false;
    var p = S.player;
    var v = E.VECTORS[dir];
    var nx = p.x + v[0];
    var ny = p.y + v[1];

    if (p.drawing) {
      p.dir = dir;
      p.x = nx;
      p.y = ny;
      if (E.isFilled(S.field, nx, ny)) {
        closeClaim();
        return true;
      }
      addTrail(E.index(S.field, nx, ny));
      return true;
    }

    if (E.isFilled(S.field, nx, ny)) {
      // Shaded ground is solid, except along the old Stix lines drawn through
      // it: the marker rides the frame, the outline of what it owns, and every
      // line it has closed an area with. canStep has already checked that this
      // one is walkable.
      p.x = nx;
      p.y = ny;
      p.dir = dir;
      return true;
    }

    p.drawing = true;
    p.dir = dir;
    p.allSlow = p.slow;
    p.lineStart = { x: p.x, y: p.y }; // where this line began, for respawning
    p.x = nx;
    p.y = ny;
    addTrail(E.index(S.field, nx, ny));
    return true;
  }

  function addTrail(cell) {
    var p = S.player;
    p.trail.push(cell);
    p.trailMask[cell] = 1;
    if (!p.slow) p.allSlow = false;
    S.fuse.active = false;
  }

  function clearTrail() {
    var p = S.player;
    p.trail.length = 0;
    p.trailMask.fill(0);
    p.drawing = false;
    p.allSlow = true;
    p.acc = 0;
    p.still = 0;
  }

  /**
   * The capture itself. Everything the Qix is not trapped in becomes the
   * player's; an area drawn entirely in slow draw scores double.
   */
  function closeClaim() {
    var p = S.player;
    var slow = p.allSlow;
    var qixCells = S.qixes.map(qixCell);
    var res = E.resolveClaim(S.field, p.trail, qixCells);

    clearTrail();
    S.percent = res.percent;
    S.fieldDirty = true;
    S.fuse.active = false;

    // Every block won gets its share of the field written inside it.
    addBlockLabel(res.claimed);

    var points = Math.round(
      res.claimed.length * SCORE_PER_CELL * (slow ? SLOW_BONUS : 1) * S.multiplier
    );
    S.score += points;
    saveBest();

    // A Qix boxed into a patch smaller than the one its neighbour is running in
    // is crushed: its ground is ours now, and it is gone from the board. The
    // level carries on in the roomiest patch.
    var crushed = 0;
    S.qixes = S.qixes.filter(function (q, i) {
      var keeps = res.qixRegionIds[i] === res.keptRegionId;
      if (!keeps) {
        crushed += 1;
        startQixDeath(q); // it keeps collapsing for a moment, on screen
      }
      return keeps;
    });

    // A split (each Qix alone in its own patch) is the big score in the `traps`
    // rules: it pays out once, and raising the multiplier is the reward for the
    // cut that made it. A Qix buried where there is no open cell left is just as
    // trapped, and it can happen on the stroke that also wins the round, so the
    // bonus is paid before the level is allowed to finish and is carried onto
    // that card. Under the `survivors` rules a kill pays nothing - it only costs
    // you a share of the end-of-level pot - so it just says so.
    var trapBonus = 0;
    if (crushed > 0) {
      if (RULES.trapBonus) {
        trapBonus = awardTrap(crushed);
      } else {
        flash(crushed + ' QIX KILLED: ' + S.qixes.length + ' still out there', 2000);
      }
    }

    // A Qix left standing on ground that just became ours has nowhere to live.
    ensureQixesLegal();
    // The same goes for a Sparx that was standing on ground that just became
    // ours - most likely on the Stix this claim has just closed.
    for (var si = 0; si < S.sparx.length; si++) homeSparx(S.sparx[si]);
    // ...and the closing cell can end up buried inside the new shading, which
    // would strand the marker off the lines entirely.
    snapMarkerToLine();

    if (levelComplete()) {
      finishLevel(trapBonus);
    } else if (S.percent >= TARGET_PERCENT && !S.toldNeedKills) {
      // Full enough, but Kill the Qwix wants the crowd down to one first: say so
      // once, rather than ending the level and leaving the player puzzled.
      S.toldNeedKills = true;
      flash(S.qixes.length + ' QIX TO GO. There can only be one left!', 2600);
    }

    // Whatever the stroke paid - area, trap, level bonus - it might have bought
    // a life on the way.
    checkLifeMilestones();
  }

  /**
   * What the next life costs, right now. A million on level 1, and another
   * hundred thousand for every level above it - so the deeper you get, the more
   * a life is worth having and the harder it is to buy.
   */
  function lifeCost() {
    return LIFE_EVERY_POINTS + LIFE_LEVEL_STEP * Math.max(0, S.level - 1);
  }

  /**
   * An extra life every time the score passes the going rate. One stroke can
   * cross more than one threshold (a trap pays 50,000 a piece, a level bonus can
   * be huge), so this counts them all rather than granting one per stroke.
   */
  function checkLifeMilestones() {
    var gained = 0;
    while (S.score >= S.nextLifeAt) {
      S.lives += 1;
      S.nextLifeAt += lifeCost(); // the price of the next one, at this level
      gained += 1;
    }
    if (!gained) return;
    flashNow('EXTRA ' + (gained > 1 ? gained + ' LIVES' : 'LIFE') + '   lives ' + S.lives, 2200);
  }

  /**
   * A Qix has been walled in and taken, so its ground is ours. That can only
   * happen once a level (the survivors end up sharing one patch), so it is paid
   * once and the amount is returned for the level card to quote.
   */
  function awardTrap(crushed) {
    if (!RULES.trapBonus) return 0; // this variant pays at the clear instead
    if (S.trapDone) return 0;
    S.trapDone = true;
    var bonus = TRAP_BONUS * S.multiplier;
    S.score += bonus;
    saveBest();
    flash(
      crushed + ' QIX KILLED  +' + bonus,
      2600
    );
    return bonus;
  }

  /**
   * What each block was worth, written in the block itself: its share of the
   * whole field, placed on the won cell nearest the block's average, so the
   * number lands on the ground rather than in a hollow middle.
   */
  function addBlockLabel(cells) {
    if (!cells.length) return;
    var sx = 0;
    var sy = 0;
    var i;
    for (i = 0; i < cells.length; i++) {
      sx += E.cellX(S.field, cells[i]);
      sy += E.cellY(S.field, cells[i]);
    }
    var cx = sx / cells.length;
    var cy = sy / cells.length;
    var best = cells[0];
    var bestDist = Infinity;
    for (i = 0; i < cells.length; i++) {
      var dx = E.cellX(S.field, cells[i]) - cx;
      var dy = E.cellY(S.field, cells[i]) - cy;
      var dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        best = cells[i];
      }
    }
    var share = (cells.length / S.field.claimable) * 100;
    S.blocks.push({
      x: E.cellX(S.field, best),
      y: E.cellY(S.field, best),
      text: (share >= 10 ? Math.round(share) : share.toFixed(1)) + '%',
    });
  }

  /** A short banner across the field, for the one moment worth shouting about. */
  function flash(text, ms) {
    S.flashQueue.push({ text: text, ms: ms || 2000 });
  }

  /**
   * A notice that will not wait its turn: the head of the queue, and whatever is
   * on screen is wrapped up quickly so it cannot be long behind. The extra life
   * uses this - it is news at the moment it happens, not a footnote to a recap.
   */
  function flashNow(text, ms) {
    var left = ms || NOTICE_MS;
    if (S.flash && S.flash.left > 500) S.flash.left = 500;
    S.flashQueue.unshift({ text: text, ms: left });
  }

  /**
   * Play the notices one after another: the head of the queue becomes the
   * banner for its own duration, then the next one takes over. This is what the
   * level-clear recap is made of, so it has to be a queue rather than a single
   * slot.
   */
  function updateFlash(dt) {
    if (S.flash) {
      S.flash.left -= dt;
      if (S.flash.left > 0) return;
      S.flash = null;
    }
    if (!S.flashQueue.length) return;
    var next = S.flashQueue.shift();
    S.flash = { text: next.text, left: next.ms, ms: next.ms };
  }

  /**
   * Under the `survivors` rules, every Qix still on the board beyond the first
   * is worth a bonus when the level is cleared - so the reward is for keeping
   * the crowd alive, not for killing it off.
   */
  function survivorBonusFor(alive, multiplier) {
    return Math.max(0, alive - 1) * SURVIVOR_BONUS * multiplier;
  }

  /**
   * The par: 20 seconds, the same on every level. It does not grow with the
   * level - the speed demon bonus is for a fast clear, full stop - so a deep level
   * with three Qix and a red wave is simply harder to win it on.
   */
  function parMs() {
    return FAST_WIN_PAR_MS;
  }

  /**
   * The speed demon bonus: the full bonus for a level taken instantly, falling in a
   * straight line to nothing at par, and nothing at all beyond it.
   */
  /**
   * The speed bonus: 10,000 a second for every whole second finished inside the
   * par, multiplied like everything else. Clear in 12 s of a 20 s par and it pays
   * eight seconds' worth; clear on the par and it pays nothing.
   */
  function fastWinBonus(ms, multiplier) {
    var par = parMs();
    var spent = Math.max(0, ms || 0);
    var under = Math.max(0, Math.floor((par - spent) / 1000));
    return under * SPEED_BONUS_PER_SECOND * multiplier;
  }

  /** 72345 -> "1:12", for the clearance card. */
  function duration(ms) {
    var total = Math.max(0, Math.round((ms || 0) / 1000));
    var mins = Math.floor(total / 60);
    var secs = total % 60;
    return mins + ':' + (secs < 10 ? '0' + secs : secs);
  }

  /**
   * Is the level done? Both versions want `TARGET_PERCENT` of the field. Kill the
   * Qwix adds a second condition: every Qix but one has to be gone, so filling the
   * board alone never ends a level while a crowd is still on it.
   */
  function levelComplete() {
    if (S.percent < TARGET_PERCENT) return false;
    return !RULES.requireLastQix || S.qixes.length <= 1;
  }

  function finishLevel(trapBonus) {
    // The survivors pot is paid first, like the trap bonus it replaces, so the
    // multiplier step it earns counts for the area bonus below it. Only the ones
    // beyond the first pay, but the card reports the whole crowd.
    var alive = S.qixes.length;
    var survivors = 0;
    var extra = 0;
    if (RULES.survivorBonus) {
      extra = Math.max(0, alive - 1);
      if (extra > 0) {
        survivors = survivorBonusFor(alive, S.multiplier);
        S.score += survivors;
      }
    }

    // Two bonuses for a job well done: the ground you took past the target, and
    // the clock - a level can be won on the last stroke of the fuse or at a
    // sprint, and the sprint is worth something.
    // Whole points past the target only: 85.4% is on the number, not over it.
    var over = Math.max(0, Math.floor(S.percent) - TARGET_PERCENT);
    var overBonus = Math.round(over * OVER_TARGET_PER_PERCENT * S.multiplier);
    var winBonus = fastWinBonus(S.levelAge, S.multiplier);
    S.score += overBonus + winBonus;
    saveBest();
    S.clearInfo = {
      bonus: overBonus,
      winBonus: winBonus,
      over: over,
      levelMs: S.levelAge,
      parMs: parMs(),
      percent: S.percent,
      trapBonus: trapBonus || 0,
      survivors: survivors,
      extraQixes: extra,
      qixesAlive: RULES.survivorBonus ? alive : 0,
      faster: speedAtLevel(S.level + 1) > speedAtLevel(S.level),
    };

    // The end of a round is announced the way everything else in the game is
    // announced: queued notices across the board, one after another. No card,
    // and nothing to dismiss - the next level follows the last notice.
    var notes = ['LEVEL ' + S.level + ' CLEAR'];
    if (trapBonus) notes.push('Qwix Killed: ' + bigNumber(trapBonus));
    if (survivors) notes.push('Qwix Captured: ' + bigNumber(survivors));
    if (winBonus) notes.push('Speed bonus: ' + bigNumber(winBonus));
    if (overBonus) notes.push('Over achiever: ' + bigNumber(overBonus));
    if (S.clearInfo.faster) notes.push('The Qix is quicker from here on.');
    S.recap = { lines: notes, age: 0 };
    S.timer = recapTotalMs(notes.length);
    S.state = 'levelclear';
    syncOverlay();
  }

  // --- dying ----------------------------------------------------------------

  function killPlayer() {
    if (S.state !== 'playing') return;
    if (S.now < S.invulnUntil) return;
    // If a Stix was out, remember where it started before the trail goes: that
    // is where the marker comes back.
    S.deathSpot = S.player.drawing && S.player.lineStart ? S.player.lineStart : null;
    S.lives -= 1;
    clearTrail();
    S.fuse.active = false;
    S.state = 'dying';
    S.timer = DEATH_MS;
    syncOverlay();
  }

  function afterDeath() {
    if (S.lives <= 0) {
      S.state = 'gameover';
      saveBest();
      syncOverlay();
      return;
    }
    var p = S.player;
    clearTrail();

    // Back to the start of the Stix they died on, if there was one and that
    // square is still a legal place to stand; otherwise the usual top edge.
    var spot = S.deathSpot;
    S.deathSpot = null;
    if (spot && E.isWalkable(S.field, spot.x, spot.y)) {
      p.x = spot.x;
      p.y = spot.y;
    } else {
      p.x = Math.floor(COLS / 2);
      p.y = 0;
      p.dir = E.LEFT;
    }

    for (var i = 0; i < S.qixes.length; i++) relocateQix(S.qixes[i]);
    // A death calms the wave: red was for the run you just lost. The hunt clock is
    // held off again too, so the marker gets the same opening grace it had on a
    // fresh board.
    S.super = false;
    S.sinceBoard = 0;
    S.awaitingFirstLine = true;
    S.sinceLine = 0;
    S.sparx = buildSparxWave();
    S.invulnUntil = S.now + INVULN_MS;
    S.state = 'playing';
    syncOverlay();
  }

  function qixCell(q) {
    var x = Math.max(0, Math.min(COLS - 1, Math.round(q.x - 0.5)));
    var y = Math.max(0, Math.min(ROWS - 1, Math.round(q.y - 0.5)));
    return E.index(S.field, x, y);
  }

  function relocateQix(q) {
    var spot = randomEmpty(r => bodyBlocked(r.x, r.y, QIX_BODY));
    q.x = spot.x;
    q.y = spot.y;
    q.heading = Math.random() * Math.PI * 2;
    q.angle = q.heading;
    q.weave = Math.random() * Math.PI * 2;
    q.driftT = 0;
    q.dash = 0;
    q.dashWait = QIX_DASH_GAP_MS;
  }

  function ensureQixesLegal() {
    for (var i = 0; i < S.qixes.length; i++) {
      var q = S.qixes[i];
      if (E.isFilled(S.field, Math.round(q.x - 0.5), Math.round(q.y - 0.5))) {
        relocateQix(q);
      }
    }
  }

  /**
   * The marker may only ever stand on a line. A claim can shade the cell it is
   * on, so put it back on the nearest walkable one afterwards - the outline of
   * the new ground, or one of the Stix lines running through it.
   */
  function snapMarkerToLine() {
    var p = S.player;
    if (E.isWalkable(S.field, p.x, p.y)) return;
    var cell = E.nearestWalkableCell(S.field, E.index(S.field, p.x, p.y), 16);
    if (cell >= 0) {
      p.x = E.cellX(S.field, cell);
      p.y = E.cellY(S.field, cell);
      return;
    }
    // Nothing close by? The frame is always a line, so fall back to the nearest
    // edge rather than leaving the marker stranded inside the shading.
    var left = p.x;
    var right = COLS - 1 - p.x;
    var top = p.y;
    var bottom = ROWS - 1 - p.y;
    var edge = Math.min(left, right, top, bottom);
    if (edge === left) p.x = 0;
    else if (edge === right) p.x = COLS - 1;
    else if (edge === top) p.y = 0;
    else p.y = ROWS - 1;
  }

  // --- the Qix --------------------------------------------------------------

  /** The cell a point sits in, solid or not. */
  function solidAt(x, y) {
    return E.isFilled(S.field, Math.round(x - 0.5), Math.round(y - 0.5));
  }

  /**
   * Would a disc of radius `r` centred here overlap claimed ground? The Qix is
   * big, so it bounces off the shading before its body clips into it.
   */
  function bodyBlocked(x, y, r) {
    var cx = Math.round(x - 0.5);
    var cy = Math.round(y - 0.5);
    for (var dy = -r; dy <= r; dy++) {
      for (var dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        if (E.isFilled(S.field, cx + dx, cy + dy)) return true;
      }
    }
    return false;
  }

  /**
   * Which axes are blocked. The full body has to stay out of the shading, but a
   * gap narrower than the body is squeezed through on a smaller one rather than
   * freezing the Qix in place; as a last resort only the cell itself matters.
   */
  function qixBlockedAxes(q, sx, sy) {
    var bx, by;
    for (var r = QIX_BODY; r >= 1; r--) {
      bx = bodyBlocked(q.x + sx, q.y, r);
      by = bodyBlocked(q.x, q.y + sy, r);
      if (!bx || !by) break;
    }
    if (bx && by) {
      bx = solidAt(q.x + sx, q.y);
      by = solidAt(q.x, q.y + sy);
    }
    return { x: bx, y: by };
  }

  /** Fold an angle back into -PI..PI. */
  function wrapAngle(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }

  /** How much bigger the figure has grown on this level so far. */
  function qixScale() {
    return 1 + Math.min(QIX_GROWTH_MAX, S.levelAge / QIX_GROWTH_MS);
  }

  function updateQix(dt) {
    var seconds = dt / 1000;
    var scale = qixScale();
    for (var i = 0; i < S.qixes.length; i++) {
      var q = S.qixes[i];

      // A heading, reconsidered every second or two...
      q.driftT -= dt;
      if (q.driftT <= 0) {
        q.heading += (Math.random() - 0.5) * 2 * QIX_DRIFT_TURN;
        if (Math.random() < QIX_REVERSE_CHANCE) q.heading += Math.PI;
        q.driftT = QIX_DRIFT_MIN_MS + Math.random() * QIX_DRIFT_VAR_MS;
      }

      // ...a weave around it that never jumps, however fast the clock runs...
      var want = q.heading + Math.sin(S.now * QIX_WEAVE_RATE + q.weave) * QIX_WEAVE;

      // ...and a steering limit, so the figure can only ever turn so fast. The
      // path curves; nothing snaps.
      var turn = wrapAngle(want - q.angle);
      var limit = QIX_TURN_RATE * seconds;
      if (turn > limit) turn = limit;
      else if (turn < -limit) turn = -limit;
      q.angle = wrapAngle(q.angle + turn);

      // Now and then a lunge: a change of pace, not of direction.
      q.dash -= dt;
      q.dashWait -= dt;
      if (q.dash <= 0 && q.dashWait <= 0) {
        q.dashWait = QIX_DASH_GAP_MS;
        if (Math.random() < QIX_DASH_CHANCE) q.dash = QIX_DASH_MS;
      }
      var speed = q.speed * (q.dash > 0 ? QIX_DASH_FACTOR : 1) * (q.scale || 1);
      var sx = Math.cos(q.angle) * speed * seconds;
      var sy = Math.sin(q.angle) * speed * seconds;
      var blocked = qixBlockedAxes(q, sx, sy);

      // A bounce turns the direction of travel, and the heading with it, so the
      // weave carries on around the new course.
      if (blocked.x) {
        q.angle = wrapAngle(Math.PI - q.angle);
        q.heading = Math.PI - q.heading;
      } else {
        q.x += sx;
      }
      if (blocked.y) {
        q.angle = wrapAngle(-q.angle);
        q.heading = -q.heading;
      } else {
        q.y += sy;
      }
      if (blocked.x && blocked.y) {
        q.angle = wrapAngle(q.angle + (Math.random() - 0.5) * 1.2);
        q.heading += (Math.random() - 0.5) * 1.2;
      }

      q.hue = (q.hue + dt * 0.09) % 360;
      q.scale = scale;      // read by the drawing and by the hit test
      flexQix(q);
    }
  }

  // --- the Sparx ------------------------------------------------------------

  /** Where a hunting Sparx may travel: the outline, and the old Stix lines. */
  function sparxCanStand(x, y) {
    return E.isBoundaryCell(S.field, x, y) || E.isLine(S.field, x, y);
  }

  // Distance from every standable cell to the marker, rebuilt at most once a
  // frame. Reused buffers, because this runs while the game is drawing.
  var chaseDist = new Int32Array(COLS * ROWS);
  var chaseQueue = new Int32Array(COLS * ROWS);
  var chaseAt = -1;

  /**
   * Breadth-first from the marker - or from the Stix, while one is out, since a
   * hunting Sparx may run that too - across everything a Sparx can stand on. The
   * result is a distance field the red ones can follow as a gradient, which is
   * what turns "it noticed you" into "it is coming".
   */
  function chaseField() {
    if (chaseAt === S.now) return chaseDist;
    chaseAt = S.now;

    var p = S.player;
    chaseDist.fill(-1);
    var tail = 0;

    if (p.drawing && p.trail.length) {
      for (var t = 0; t < p.trail.length; t++) {
        chaseDist[p.trail[t]] = 0;
        chaseQueue[tail++] = p.trail[t];
      }
    } else {
      var start = E.index(S.field, p.x, p.y);
      chaseDist[start] = 0;
      chaseQueue[tail++] = start;
    }

    for (var head = 0; head < tail; head++) {
      var cell = chaseQueue[head];
      var cx = E.cellX(S.field, cell);
      var cy = E.cellY(S.field, cell);
      for (var d = 0; d < 4; d++) {
        var nx = cx + E.VECTORS[d][0];
        var ny = cy + E.VECTORS[d][1];
        if (!E.inBounds(S.field, nx, ny)) continue;
        var next = E.index(S.field, nx, ny);
        if (chaseDist[next] !== -1) continue;
        if (!sparxCanStand(nx, ny)) continue;
        chaseDist[next] = chaseDist[cell] + 1;
        chaseQueue[tail++] = next;
      }
    }
    return chaseDist;
  }

  /** One step down the gradient toward the marker. False if there is no route. */
  function chaseStep(s) {
    var dist = chaseField();
    var here = dist[E.index(S.field, s.x, s.y)];
    if (here <= 0) return false; // no route, or already on the marker

    // Continue the way it is facing when two steps are as good as each other.
    var order = [s.dir, (s.dir + 1) % 4, (s.dir + 3) % 4, E.opposite(s.dir)];
    var best = null;
    var bestDist = here;
    for (var i = 0; i < 4; i++) {
      var d = order[i];
      var nx = s.x + E.VECTORS[d][0];
      var ny = s.y + E.VECTORS[d][1];
      if (!E.inBounds(S.field, nx, ny)) continue;
      var nd = dist[E.index(S.field, nx, ny)];
      if (nd < 0 || nd >= bestDist) continue;
      bestDist = nd;
      best = { x: nx, y: ny, dir: d };
    }
    if (!best) return false;
    s.x = best.x;
    s.y = best.y;
    s.dir = best.dir;
    return true;
  }

  function updateSparx(dt) {
    for (var i = 0; i < S.sparx.length; i++) {
      var s = S.sparx[i];
      s.acc += dt;
      var stepMs = sparxStepMs(s);
      var guard = 0;
      while (s.acc >= stepMs && guard < 6) {
        guard += 1;
        s.acc -= stepMs;
        sparxStep(s);
        if (S.state !== 'playing') return;
      }
    }
  }

  /**
   * A red Sparx hunts: it follows the distance field to the marker, and steps
   * onto the Stix the moment it is alongside one. Only when there is no route at
   * all does it fall back to patrolling the outline.
   */
  function sparxStep(s) {
    var p = S.player;
    if (s.super) {
      if (chaseStep(s)) return;
      if (p.drawing) {
        var here = E.index(S.field, s.x, s.y);
        if (p.trailMask[here]) {
          stepTrailTowardPlayer(s, here);
          return;
        }
        var target = adjacentTrailCell(s);
        if (target >= 0) {
          setSparxCell(s, target);
          return;
        }
      }
    }

    var next = E.nextBoundaryStep(S.field, s.x, s.y, s.dir);
    if (next) {
      s.x = next.x;
      s.y = next.y;
      s.dir = next.dir;
      return;
    }
    // Nowhere to walk: this cell has no boundary neighbour at all. That means the
    // outline has closed over it, so put it back on the outline rather than let
    // it sit here flipping its heading for the rest of the level.
    if (!homeSparx(s)) s.dir = E.opposite(s.dir);
  }

  /**
   * A claim can shade the cell a Sparx stands on right out of the outline - most
   * easily a red one, which is allowed to climb the Stix that has just closed,
   * but also a patrolling one on a sliver of outline that the new ground
   * swallows. It is stranded there: `nextBoundaryStep` has nowhere to go from a
   * cell with no boundary neighbour. Send it to the nearest piece of outline.
   */
  function homeSparx(s) {
    if (E.isBoundaryCell(S.field, s.x, s.y)) return false;
    var cell = E.nearestBoundaryCell(S.field, E.index(S.field, s.x, s.y), COLS + ROWS);
    if (cell < 0) return false;
    s.x = E.cellX(S.field, cell);
    s.y = E.cellY(S.field, cell);
    s.acc = 0;
    return true;
  }

  function stepTrailTowardPlayer(s, fromCell) {
    var trail = S.player.trail;
    var i = trail.indexOf(fromCell);
    if (i < 0) return;
    var next = i + 1 < trail.length ? trail[i + 1] : i > 0 ? trail[i - 1] : -1;
    if (next >= 0) setSparxCell(s, next);
  }

  function adjacentTrailCell(s) {
    var best = -1;
    var bestDist = Infinity;
    for (var d = 0; d < 4; d++) {
      var nx = s.x + E.VECTORS[d][0];
      var ny = s.y + E.VECTORS[d][1];
      if (!E.inBounds(S.field, nx, ny)) continue;
      var cell = E.index(S.field, nx, ny);
      if (!S.player.trailMask[cell]) continue;
      var dist = Math.abs(nx - S.player.x) + Math.abs(ny - S.player.y);
      if (dist < bestDist) {
        bestDist = dist;
        best = cell;
      }
    }
    return best;
  }

  function setSparxCell(s, cell) {
    var x = E.cellX(S.field, cell);
    s.x = x;
    s.y = E.cellY(S.field, cell);
  }

  // --- the fuse -------------------------------------------------------------

  /**
   * Stand still halfway through a Stix and a fuse lights at the far end and
   * burns back towards the marker. Moving again puts it out - and so does
   * anything that resets the trail, which is why this is measured off the
   * marker's own stillness rather than the keys.
   *
   * How long "stand still" means depends on the Stix: see fuseGrace.
   */
  function updateFuse(dt) {
    var p = S.player;
    var f = S.fuse;
    if (!p.drawing || p.still < fuseGrace()) {
      f.active = false;
      f.acc = 0;
      return;
    }
    if (!f.active) {
      f.active = true;
      f.pos = 0;
      f.acc = 0;
    }
    f.acc += dt;
    var guard = 0;
    while (f.acc >= FUSE_STEP_MS && guard < 4) {
      guard += 1;
      f.acc -= FUSE_STEP_MS;
      f.pos += 1;
      if (f.pos >= p.trail.length - 1) {
        killPlayer();
        return;
      }
    }
  }

  /**
   * How long the marker may stand still mid-draw before the fuse lights: 420 ms,
   * plus 120 ms for every cell the Stix is short of 50 px. A long line is
   * unchanged; a one-cell dab gets 900 ms, which is the difference between a
   * reflex test the player cannot pass and a mistake they can recover from.
   */
  function fuseGrace() {
    var shortCells = Math.round(FUSE_SHORT_PX / CELL);
    var under = Math.max(0, shortCells - S.player.trail.length);
    return FUSE_GRACE_MS + under * FUSE_SHORT_GRACE_MS;
  }

  // --- what kills you -------------------------------------------------------

  /**
   * Animate the spines. Drawing and hit detection both call this on the same
   * clock, so the figure you can see is exactly the figure that can hit you.
   */
  function flexQix(q) {
    var scale = q.scale || 1;
    for (var i = 0; i < q.segs.length; i++) {
      var seg = q.segs[i];
      seg.angle = seg.a + Math.sin(S.anim * 0.0035 + seg.phase) * 0.8;
      seg.reach = seg.len * (0.65 + 0.35 * Math.sin(S.anim * 0.005 + seg.phase * 1.7))
        * QIX_SIZE * scale;
    }
  }

  /** Squared distance from a point to a segment, in cell units. */
  function segmentDistance2(px, py, ax, ay, bx, by) {
    var vx = bx - ax;
    var vy = by - ay;
    var len2 = vx * vx + vy * vy;
    var t = len2 > 0 ? ((px - ax) * vx + (py - ay) * vy) / len2 : 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    var dx = px - (ax + vx * t);
    var dy = py - (ay + vy * t);
    return dx * dx + dy * dy;
  }

  /**
   * Does any part of the figure touch this cell? The body is a disc, and each
   * spine is lethal along its whole length - not just at the tip, and not just
   * the core.
   */
  function hitsQix(q, cx, cy) {
    var px = cx + 0.5;
    var py = cy + 0.5;
    var dx = q.x - px;
    var dy = q.y - py;
    var dist2 = dx * dx + dy * dy;
    var body = QIX_TOUCH * (q.scale || 1);
    if (dist2 <= body * body) return true; // the body

    // Cheap reject first: nothing can reach further than the longest spine.
    var furthest = body;
    for (var i = 0; i < q.segs.length; i++) {
      if (q.segs[i].reach > furthest) furthest = q.segs[i].reach;
    }
    var reach = furthest + QIX_HIT_WIDTH;
    if (dist2 > reach * reach) return false;

    for (var s = 0; s < q.segs.length; s++) {
      var seg = q.segs[s];
      var ex = q.x + Math.cos(seg.angle) * seg.reach;
      var ey = q.y + Math.sin(seg.angle) * seg.reach;
      if (segmentDistance2(px, py, q.x, q.y, ex, ey) <= QIX_HIT_WIDTH * QIX_HIT_WIDTH) return true;
    }
    return false;
  }

  function checkHits() {
    if (S.now < S.invulnUntil) return;
    var p = S.player;
    for (var i = 0; i < S.sparx.length; i++) {
      if (S.sparx[i].x === p.x && S.sparx[i].y === p.y) {
        killPlayer();
        return;
      }
    }
    // The Qix ignores the marker on claimed ground, but anything it touches
    // once a Stix is out costs a life.
    if (!p.drawing) return;
    for (var j = 0; j < S.qixes.length; j++) {
      var q = S.qixes[j];
      if (hitsQix(q, p.x, p.y)) {
        killPlayer();
        return;
      }
      for (var k = 0; k < p.trail.length; k++) {
        var cell = p.trail[k];
        if (hitsQix(q, E.cellX(S.field, cell), E.cellY(S.field, cell))) {
          killPlayer();
          return;
        }
      }
    }
  }

  // --- level pacing ---------------------------------------------------------

  /**
   * Two things happen inside a level: the Qix grows (on `S.levelAge`) and the
   * Sparx lose patience. How many Sparx there are is a property of the level
   * itself (see sparxCount), so there is nothing to release here.
   *
   * The patience clock is the marker's own stillness - `S.player.still`, which
   * `updatePlayer` clears on every step it takes. So a player who keeps moving is
   * never hunted, however long they go without claiming anything: the wave only
   * turns on someone who has parked.
   */
  function updateLevelClock(dt) {
    S.levelAge += dt; // survives deaths, so the figure keeps what it has grown

    // The opening grace: nothing is counted until the player starts their first
    // line, or OPENING_GRACE_MS goes by with them doing nothing at all. Its own
    // timer, not levelAge, because levelAge survives a death and would skip the
    // grace on a respawn.
    if (S.awaitingFirstLine) {
      S.sinceBoard += dt;
      if (S.player.drawing || S.sinceBoard >= OPENING_GRACE_MS) {
        S.awaitingFirstLine = false;
      }
    }

    // Inactivity means *not drawing*. A Stix is activity and holds the clock at
    // zero; walking the lines - however busy it looks - is not, so pacing the
    // outline does not keep the wave calm. Only taking ground does.
    if (S.awaitingFirstLine || S.player.drawing) {
      S.sinceLine = 0;
    } else {
      S.sinceLine += dt;
    }

    if (!S.super && S.sinceLine >= sparxIdleAllowance()) setHunting(true);
  }

  /**
   * How long the marker may stand still before the Sparx turn: 15 seconds, the
   * same on every level. It used to tighten with the level, which meant a deep
   * level could turn a wave hostile almost immediately.
   */
  function sparxIdleAllowance() {
    return SPARX_IDLE_MS;
  }

  /**
   * Turn the whole wave red: they hunt, they step quicker, and they may climb an
   * open Stix. This is a one-way door inside a level - nothing calls this with
   * `false` once a level is under way, because red lasts until the board is
   * cleared and the next level builds a new, violet wave.
   */
  function setHunting(on) {
    if (S.super === on) return;
    S.super = on;
    for (var i = 0; i < S.sparx.length; i++) S.sparx[i].super = on;
    if (on) flash('SPARX HUNTING', 2600);
  }


  // --- painting -------------------------------------------------------------

  function px(cell) {
    return (cell + 0.5) * CELL;
  }

  function paintField() {
    var c = fieldCtx;
    c.fillStyle = '#06070a';
    c.fillRect(0, 0, W, H);

    // A faint lattice so open space reads as territory to be taken.
    c.strokeStyle = 'rgba(255, 255, 255, 0.035)';
    c.lineWidth = 1;
    c.beginPath();
    for (var gx = 0; gx <= COLS; gx += 4) {
      c.moveTo(gx * CELL + 0.5, 0);
      c.lineTo(gx * CELL + 0.5, H);
    }
    for (var gy = 0; gy <= ROWS; gy += 4) {
      c.moveTo(0, gy * CELL + 0.5);
      c.lineTo(W, gy * CELL + 0.5);
    }
    c.stroke();

    // Claimed area, painted as horizontal runs rather than 4800 rectangles.
    c.fillStyle = captureColor();
    var cells = S.field.cells;
    for (var y = 1; y < ROWS - 1; y++) {
      var runStart = -1;
      for (var x = 1; x <= COLS - 1; x++) {
        var filled = x < COLS - 1 && cells[y * COLS + x] === E.FILLED;
        if (filled && runStart < 0) runStart = x;
        if (!filled && runStart >= 0) {
          c.fillRect(runStart * CELL, y * CELL, (x - runStart) * CELL, CELL);
          runStart = -1;
        }
      }
    }

    // Old Stix lines stay visible, because they are still walkable: pale
    // threads through the shading, and the way across your own territory.
    c.fillStyle = 'rgba(255, 255, 255, 0.14)';
    var lines = S.field.lines;
    for (var ly = 1; ly < ROWS - 1; ly++) {
      for (var lx = 1; lx < COLS - 1; lx++) {
        if (lines[ly * COLS + lx] === 1) c.fillRect(lx * CELL, ly * CELL, CELL, CELL);
      }
    }

    // What each block was worth, written inside it.
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = 'bold 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    for (var b = 0; b < S.blocks.length; b++) {
      var block = S.blocks[b];
      var bx = block.x * CELL + CELL / 2;
      var by = block.y * CELL + CELL / 2;
      c.fillStyle = 'rgba(3, 10, 7, 0.7)';
      c.fillText(block.text, bx + 0.7, by + 1.2);
      c.fillStyle = 'rgba(255, 255, 255, 0.85)';
      c.fillText(block.text, bx, by);
    }

    // The frame the marker rides on.
    c.strokeStyle = '#3f4a58';
    c.lineWidth = CELL;
    c.strokeRect(CELL / 2, CELL / 2, W - CELL, H - CELL);
  }

  function render() {
    if (S.fieldDirty) {
      paintField();
      S.fieldDirty = false;
    }
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(fieldCanvas, 0, 0);
    drawStix();
    drawFuse();
    drawQix();
    drawDeaths();
    drawSparx();
    drawMarker();
    drawFlash();
    syncHud();
  }

  /** The one banner in the game: a split just paid out. */
  /** How long a recap of `count` lines lives, end to end. */
  function recapTotalMs(count) {
    return RECAP_STAGGER_MS * Math.max(0, count - 1) + RECAP_FADE_MS + RECAP_HOLD_MS +
      RECAP_FADE_OUT_MS;
  }

  /** Advance the recap stack, and retire it once it has played out. */
  function updateRecap(dt) {
    if (!S.recap) return;
    S.recap.age += dt;
    // Retiring it here is what lets the next level start: the level-clear state
    // waits for the stack to be gone.
    if (S.recap.age >= recapTotalMs(S.recap.lines.length)) S.recap = null;
  }

  /**
   * The end-of-level stack: every line on the board at once, the headline in the
   * middle-upper third, each line below it fading in a stagger behind the one
   * above. The whole block then fades out together.
   */
  function drawRecap() {
    var r = S.recap;
    if (!r || !r.lines.length) return;
    var total = recapTotalMs(r.lines.length);
    var outAt = total - RECAP_FADE_OUT_MS;
    var fadeOut = r.age <= outAt ? 1 : Math.max(0, 1 - (r.age - outAt) / RECAP_FADE_OUT_MS);
    if (fadeOut <= 0) return;

    var headline = 26;
    var line = 19;
    var gap = 12;
    var height = headline + gap;
    for (var i = 1; i < r.lines.length; i++) height += line + gap;
    var y = H * 0.30 - height / 2;

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (var n = 0; n < r.lines.length; n++) {
      var size = n === 0 ? headline : line;
      var shown = Math.min(1, Math.max(0, (r.age - n * RECAP_STAGGER_MS) / RECAP_FADE_MS));
      if (shown > 0) {
        ctx.globalAlpha = shown * fadeOut;
        ctx.font = 'bold ' + size + 'px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
        ctx.fillStyle = n === 0 ? '#ffe066' : '#e8fff5';
        ctx.shadowColor = n === 0 ? '#ff9f1a' : '#7ef7c8';
        ctx.shadowBlur = n === 0 ? 18 : 10;
        ctx.fillText(r.lines[n], W / 2, y + size / 2);
      }
      y += size + gap;
    }
    ctx.restore();
  }

  function drawFlash() {
    if (S.recap) {
      drawRecap();
      return;
    }
    var f = S.flash;
    if (!f || f.left <= 0) return;
    var left = f.left / (f.ms || 1);
    ctx.save();
    ctx.globalAlpha = Math.min(1, Math.max(0, left * 2.5));
    ctx.font = 'bold 26px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffe066';
    ctx.shadowColor = '#ff9f1a';
    ctx.shadowBlur = 18;
    ctx.fillText(f.text, W / 2, H * 0.22);
    ctx.restore();
  }

  function drawStix() {
    var p = S.player;
    if (!p.trail.length) return;
    ctx.save();
    ctx.lineWidth = CELL * 0.8;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = p.slow ? '#ff7a45' : '#4ea8ff';
    ctx.shadowColor = ctx.strokeStyle;
    ctx.shadowBlur = 12;
    ctx.beginPath();
    for (var i = 0; i < p.trail.length; i++) {
      var cell = p.trail[i];
      var x = px(E.cellX(S.field, cell));
      var y = px(E.cellY(S.field, cell));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineTo(px(p.x), px(p.y));
    ctx.stroke();
    ctx.restore();
  }

  function drawFuse() {
    if (!S.fuse.active) return;
    var trail = S.player.trail;
    var at = Math.min(S.fuse.pos, trail.length - 1);
    if (at < 0) return;
    var cell = trail[at];
    ctx.save();
    ctx.fillStyle = '#fff3b0';
    ctx.shadowColor = '#ffcc00';
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.arc(px(E.cellX(S.field, cell)), px(E.cellY(S.field, cell)), CELL * 0.65, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // --- a killed figure collapsing ------------------------------------------
  // A Qix that loses its patch is gone from the board, but not instantly: a
  // snapshot of the figure is played out as an implosion, so the player sees the
  // kill rather than a figure blinking out of existence. Pure decoration -
  // nothing here is in the hit test.

  /** Snapshot the figure and queue it for the death animation. */
  function startQixDeath(q) {
    flexQix(q); // settle its spines so the snapshot matches what was on screen
    var segs = [];
    for (var i = 0; i < q.segs.length; i++) {
      segs.push({ angle: q.segs[i].angle, reach: q.segs[i].reach });
    }
    S.deaths.push({
      x: q.x, y: q.y, hue: q.hue, segs: segs, scale: q.scale || 1, age: 0,
      // Deterministic, so the burst looks the same in a test as on screen.
      seed: ((q.x * 7 + q.y * 13) % 360) * Math.PI / 180,
    });
    while (S.deaths.length > 4) S.deaths.shift(); // nothing old is worth keeping
  }

  function updateDeaths(dt) {
    for (var i = S.deaths.length - 1; i >= 0; i--) {
      S.deaths[i].age += dt;
      if (S.deaths[i].age >= QIX_DEATH_MS) S.deaths.splice(i, 1);
    }
  }

  function drawDeaths() {
    for (var d = 0; d < S.deaths.length; d++) {
      var death = S.deaths[d];
      var age = death.age;
      var t = Math.min(1, age / QIX_DEATH_MS);
      if (t >= 1) continue;
      var fade = 1 - t;
      var cx = death.x * CELL;
      var cy = death.y * CELL;
      var scale = death.scale;

      // 1. A white-hot core for the first fifth: the instant of the kill. Drawn
      //    translucent rather than solid white, which the renderer uses for the
      //    marker itself.
      var flare = Math.max(0, 1 - age / (QIX_DEATH_MS * 0.22));
      if (flare > 0) {
        ctx.save();
        ctx.fillStyle = 'rgba(255, 255, 255, ' + (0.85 * flare).toFixed(3) + ')';
        ctx.shadowColor = 'hsl(' + death.hue + ', 100%, 70%)';
        ctx.shadowBlur = 26;
        ctx.beginPath();
        ctx.arc(cx, cy, (3 + 13 * t) * scale, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // 2. Three shockwaves, each a little later, wider and fainter than the last.
      for (var r = 0; r < QIX_DEATH_RINGS; r++) {
        var delay = r * 110;
        if (age < delay) continue;
        var rt = Math.min(1, (age - delay) / (QIX_DEATH_MS - delay));
        var ringFade = (1 - rt) * (1 - rt);
        ctx.save();
        ctx.strokeStyle = 'hsla(' + ((death.hue + r * 40) % 360) + ', 100%, ' +
          (74 - r * 6) + '%, ' + (0.7 * ringFade).toFixed(3) + ')';
        ctx.lineWidth = 1 + 3.5 * ringFade;
        ctx.beginPath();
        ctx.arc(cx, cy, (5 + (34 + r * 16) * rt) * scale, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // 3. Shrapnel: the figure breaking into pieces that fly out, slow down and
      //    fade, the hue cycling as they cool. Position is a function of age, so
      //    there is no particle state to keep.
      ctx.save();
      ctx.lineCap = 'round';
      for (var i = 0; i < QIX_DEATH_SHARDS; i++) {
        var angle = death.seed + (i / QIX_DEATH_SHARDS) * Math.PI * 2 + (i % 3 - 1) * 0.16;
        var own = (age - (i % 5) * 22) / QIX_DEATH_MS;
        if (own <= 0) continue;
        var at = Math.min(1, own);
        var dist = (8 + 74 * Math.sqrt(at)) * scale; // fast out of the gate, then dragging
        var len = (4 + 10 * (1 - at)) * scale;
        var alpha = Math.max(0, 1 - at) * 0.9;
        ctx.strokeStyle = 'hsla(' + ((death.hue + i * 23 + at * 150) % 360) + ', 100%, 72%, ' +
          alpha.toFixed(3) + ')';
        ctx.lineWidth = 1 + 2 * (1 - at);
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(angle) * dist, cy + Math.sin(angle) * dist);
        ctx.lineTo(cx + Math.cos(angle) * (dist + len), cy + Math.sin(angle) * (dist + len));
        ctx.stroke();
      }
      ctx.restore();

      // 4. What is left of the figure itself: the spines whirl inwards, shrink and
      //    go out, in its own colours, so it reads as the one that was killed.
      ctx.save();
      ctx.globalAlpha = Math.max(0, fade);
      ctx.lineCap = 'round';
      ctx.lineWidth = 2.5;
      for (var s = 0; s < death.segs.length; s++) {
        var seg = death.segs[s];
        var spin = seg.angle + t * (2.6 + s * 0.4); // every spine whirls, none alike
        var reach = seg.reach * Math.pow(1 - t, 1.6) * scale;
        ctx.strokeStyle = 'hsla(' + ((death.hue + s * 47) % 360) + ', 100%, 62%, ' +
          Math.max(0, fade).toFixed(3) + ')';
        ctx.shadowColor = ctx.strokeStyle;
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(spin) * reach * CELL, cy + Math.sin(spin) * reach * CELL);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  function drawQix() {
    for (var i = 0; i < S.qixes.length; i++) {
      var q = S.qixes[i];
      var cx = q.x * CELL;
      var cy = q.y * CELL;

      // The same call that sets the hit geometry: body disc plus the spines.
      flexQix(q);

      // A faint disc for the body, so the reach that kills is the reach you see.
      ctx.save();
      ctx.fillStyle = 'hsla(' + q.hue + ', 100%, 62%, 0.10)';
      ctx.beginPath();
      ctx.arc(cx, cy, QIX_TOUCH * (q.scale || 1) * CELL, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineWidth = 2.5;
      for (var s = 0; s < q.segs.length; s++) {
        var seg = q.segs[s];
        ctx.strokeStyle = 'hsl(' + ((q.hue + s * 47) % 360) + ', 100%, 62%)';
        ctx.shadowColor = ctx.strokeStyle;
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(seg.angle) * seg.reach * CELL, cy + Math.sin(seg.angle) * seg.reach * CELL);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  function drawSparx() {
    for (var i = 0; i < S.sparx.length; i++) {
      var s = S.sparx[i];
      var r = CELL * 0.7;
      ctx.save();
      ctx.translate(px(s.x), px(s.y));

      // The halo is the hunting tell, so only a hunting Sparx has one: a bright
      // yellow ring with a glow behind the red cross. A patrolling one is just the
      // violet cross on the board.
      if (s.super) {
        ctx.fillStyle = 'rgba(255, 224, 102, 0.26)';
        ctx.strokeStyle = 'rgba(255, 224, 102, 0.95)';
        ctx.shadowColor = '#ffe066';
        ctx.shadowBlur = 16;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, CELL * 1.15, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }

      ctx.rotate(S.anim * 0.006 + i);
      ctx.strokeStyle = s.super ? SPARX_HUNT : SPARX_CALM;
      ctx.shadowColor = ctx.strokeStyle;
      ctx.shadowBlur = 10;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-r, 0); ctx.lineTo(r, 0);
      ctx.moveTo(0, -r); ctx.lineTo(0, r);
      ctx.stroke();
      ctx.rotate(Math.PI / 4);
      ctx.beginPath();
      ctx.moveTo(-r * 0.6, 0); ctx.lineTo(r * 0.6, 0);
      ctx.moveTo(0, -r * 0.6); ctx.lineTo(0, r * 0.6);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawMarker() {
    if (S.state === 'dying' || S.state === 'gameover') return;
    // Blink while invulnerable so the free second reads as a free second.
    if (S.now < S.invulnUntil && Math.floor(S.now / 90) % 2 === 0) return;
    var p = S.player;
    var r = CELL * 0.85;
    ctx.save();
    ctx.translate(px(p.x), px(p.y));
    ctx.rotate(S.anim * 0.004);
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = '#7ef7c8';
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.lineTo(r, 0);
    ctx.lineTo(0, r);
    ctx.lineTo(-r, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }


  // --- the readout ----------------------------------------------------------

  var shown = {};

  function setText(el, text) {
    if (!el || shown[el.id] === text) return;
    shown[el.id] = text;
    el.textContent = text;
  }

  function syncHud() {
    setText(modeLabel, RULES.label); // 'Capture the Qwix' / 'Kill the Qwix'
    setText(hud.score, String(S.score));
    setText(hud.level, String(S.level));
    setText(hud.lives, S.lives > 0 ? new Array(S.lives + 1).join('\u25C6') : '\u2014');
    setText(hud.best, String(S.ranked ? Math.max(S.best, S.score) : S.best));
    setText(hud.percent, Math.floor(S.percent) + '%');

    // The level clock: the same S.levelAge the speed demon par is measured against,
    // so what the player reads is exactly what the bonus is judged on. It turns
    // amber once the par has gone.
    setText(hud.time, duration(S.levelAge));
    var overPar = S.levelAge >= parMs();
    if (hud.time && shown.timeOver !== overPar) {
      shown.timeOver = overPar;
      hud.time.className = overPar ? 'stat time over' : 'stat time';
    }

    var width = Math.min(100, Math.max(0, S.percent)).toFixed(1) + '%';
    if (shown.fill !== width) {
      shown.fill = width;
      hud.fill.style.width = width;
    }
  }

  /** 1000000 -> "1 million", 500000 -> "500,000", for prose in the cards. */
  function bigNumber(n) {
    if (n >= 1000000 && n % 1000000 === 0) return (n / 1000000) + ' million';
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /** 1000000 -> "1 million", 500000 -> "500,000", for prose in the cards. */
  function bigNumber(n) {
    if (n >= 1000000 && n % 1000000 === 0) return (n / 1000000) + ' million';
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /**
   * The over-target line: the ground claimed past the target, which pays by the
   * point. Silent when the level was won exactly on the number.
   */
  function overTargetLine(info) {
    if (!info.bonus) return null;
    var over = info.over || 0;
    return 'Over the ' + TARGET_PERCENT + '% target by ' + (Math.round(over * 10) / 10) +
      '%: +' + bigNumber(info.bonus) + ' points.';
  }

  /** The speed demon line: what beating the par by that much was worth. */
  function winLine(info) {
    if (!info.winBonus) return null;
    var par = info.parMs || parMs();
    return 'Speed demon bonus: in ' + duration(info.levelMs) + ', ' +
      duration(par - info.levelMs) + ' inside the ' + duration(par) + ' par - +' +
      bigNumber(info.winBonus) + ' points.';
  }

  /** Everything the level paid on top of the area score, in one figure. */
  function bonusTotalLine(info) {
    var total = (info.bonus || 0) + (info.winBonus || 0) +
      (info.trapBonus || 0) + (info.survivors || 0);
    if (!total) return null;
    return 'Bonuses this level: +' + bigNumber(total) + ' points.';
  }

  /** One card, one title, up to three buttons. */
  function showCard(title, body, primary, secondary, tertiary) {
    var o = overlay;
    o.title.textContent = title;
    o.body.textContent = body;
    o.button.textContent = primary;
    o.button.hidden = false;
    setThirdButton(o.button2, secondary);
    setThirdButton(o.button3, tertiary);
    o.root.hidden = false;
  }

  /** A card button, shown only when the card actually has one to offer. */
  function setThirdButton(el, label) {
    if (!el) return;
    if (label) {
      el.textContent = label;
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }

  /**
   * Everything the menu used to say, moved off the menu and onto its own card.
   * The two scoring lines name the versions the menu offers, so picking one is
   * not a guess.
   */
  function helpText() {
    return [
      RULES.requireLastQix
        ? 'Claim ' + TARGET_PERCENT + '% of the field and kill every Qix but one to clear a level.'
        : 'Claim ' + TARGET_PERCENT + '% of the field to clear a level.',
      'Draw a Stix into open space, then close it: every region the Qix is not in becomes yours.',
      'The marker rides the lines - the frame, the outline of your ground, and every line you have drawn.',
      'Arrows or WASD to move. Hold Shift for a slow draw - an area drawn entirely slow scores double.',
      'Every point claimed past ' + TARGET_PERCENT + '% pays ' + bigNumber(OVER_TARGET_PER_PERCENT) +
        ', and a level cleared inside its par pays ' + bigNumber(SPEED_BONUS_PER_SECOND) +
          ' a second for every second it is under.',
      'A life every ' + bigNumber(LIFE_EVERY_POINTS) + ' points, and dearer as the levels climb.',
      VARIANTS.traps.label + ': wall a Qix in and it pays ' + bigNumber(TRAP_BONUS) +
        ' then and there.',
      VARIANTS.survivors.label + ': a kill pays nothing, and every Qix still alive when you ' +
        'clear a level pays ' + bigNumber(SURVIVOR_BONUS) + ' beyond the first.',
      'Do not stand still mid-draw (the fuse lights) and do not let the Qix touch your Stix.',
      'Stop moving and the Sparx start hunting you, and they keep hunting until you die or clear the level.',
      'Press H for this card, P or Escape to pause.',
    ].join('\n');
  }

  /** The version menu. */
  function openHelp() {
    if (S.state !== 'title') return;
    S.state = 'help';
    syncOverlay();
  }

  function closeHelp() {
    if (S.state !== 'help') return;
    S.state = 'title';
    syncOverlay();
  }

  // --- a hidden start-level picker ------------------------------------------
  // Type a number on the menu and the version you then pick begins at that
  // level. Nothing advertises it: the card only grows a line once you have typed
  // something, so a player who never tries it never sees it.
  var TYPED_MAX_DIGITS = 3;
  var typedLevel = ''; // digits typed at the menu; '' means none

  function typedLevelNumber() {
    return typedLevel ? Math.max(1, Number(typedLevel)) : 0;
  }

  function typeDigit(d) {
    if (S.state !== 'title' || typedLevel.length >= TYPED_MAX_DIGITS) return false;
    if (!typedLevel && d === '0') return false; // 0 is not a level, and no leading zeros
    typedLevel += d;
    syncOverlay();
    return true;
  }

  function backspaceDigit() {
    if (S.state !== 'title' || !typedLevel) return false;
    typedLevel = typedLevel.slice(0, -1);
    syncOverlay();
    return true;
  }

  function clearTypedLevel() {
    if (!typedLevel) return false;
    typedLevel = '';
    syncOverlay();
    return true;
  }

  function syncOverlay() {
    var o = overlay;
    // 'levelclear' is deliberately absent: the end of a round is announced with
    // notices across the board, not with a card.
    var visible =
      S.state === 'title' || S.state === 'help' || S.state === 'paused' ||
      S.state === 'gameover';
    if (!visible) {
      o.root.hidden = true;
      return;
    }

    if (S.state === 'title') {
      showCard('QWIX',
        'Which version do you want to play? Capture the Qwix or Kill the Qwix' +
          (typedLevelNumber() ? '\nStarting on level ' + typedLevelNumber() + '.' : ''),
        VARIANTS.survivors.label, VARIANTS.traps.label, 'How to play');
      return;
    }

    if (S.state === 'help') {
      showCard('HOW TO PLAY', helpText(), 'Back');
      return;
    }

    if (S.state === 'paused') {
      showCard('PAUSED', [
        'Score ' + S.score + ' - level ' + S.level + ', ' + S.lives + ' lives left.',
        'Next life at ' + bigNumber(S.nextLifeAt) + ' (' + bigNumber(lifeCost()) + ' from here).',
      ].join('\n'), 'Resume');
      return;
    }


    showCard('GAME OVER', [
      'Score ' + S.score + ' on level ' + S.level + '. Best ' + S.best + '.',
      'Continue retries level ' + S.level + ' with a fresh field and ' + START_LIVES + ' lives, keeping your score.',
    ].join('\n'), 'Continue level ' + S.level, 'New game', 'Menu');
  }

  /** Back to the version menu, so the other version is reachable without a reload. */
  function backToMenu() {
    S.state = 'title';
    syncOverlay();
  }


  // --- input ----------------------------------------------------------------

  var KEY_DIRS = {
    ArrowUp: E.UP, ArrowRight: E.RIGHT, ArrowDown: E.DOWN, ArrowLeft: E.LEFT,
    w: E.UP, d: E.RIGHT, s: E.DOWN, a: E.LEFT,
    W: E.UP, D: E.RIGHT, S: E.DOWN, A: E.LEFT,
  };
  var held = [];
  var touchSlow = false;

  var input = {
    get slow() {
      return this.forceSlow || touchSlow;
    },
    forceSlow: false,
  };

  function hold(dir) {
    // Starting from the title card must not eat the keypress that started it,
    // so the game boots first and the direction is held afterwards. A direction
    // starts a fresh run on whichever version the menu last used.
    if (S.state === 'title') newRun();
    if (held.indexOf(dir) < 0) held.push(dir);
  }

  function release(dir) {
    var i = held.lastIndexOf(dir);
    if (i >= 0) held.splice(i, 1);
  }

  document.addEventListener('keydown', function (e) {
    if (Object.prototype.hasOwnProperty.call(KEY_DIRS, e.key)) {
      e.preventDefault();
      hold(KEY_DIRS[e.key]);
      return;
    }
    if (e.key === 'Shift') {
      input.forceSlow = true;
      return;
    }
    if (S.state === 'title') {
      // The hidden picker: digits name the level to start on, Backspace unpicks
      // them, Escape throws the lot away.
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        typeDigit(e.key);
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        backspaceDigit();
        return;
      }
      if (e.key === 'Escape') {
        clearTypedLevel();
        return;
      }
    }
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      confirmAction();
      return;
    }
    if (e.key === 'h' || e.key === 'H') {
      openHelp(); // only meaningful on the menu; a no-op anywhere else
      return;
    }
    if (S.state === 'help' && e.key === 'Escape') {
      closeHelp();
      return;
    }
    if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') togglePause();
  });

  document.addEventListener('keyup', function (e) {
    if (Object.prototype.hasOwnProperty.call(KEY_DIRS, e.key)) release(KEY_DIRS[e.key]);
    if (e.key === 'Shift') input.forceSlow = false;
  });

  // Keys must not stay "held" when the tab loses focus, or the marker keeps
  // walking while the player is looking at something else.
  window.addEventListener('blur', function () {
    held.length = 0;
    input.forceSlow = false;
    touchSlow = false;
    if (S.state === 'playing') togglePause();
  });

  // Touch: an on-screen pad that CSS shows only on coarse pointers.
  Array.prototype.forEach.call(document.querySelectorAll('[data-dir]'), function (button) {
    var dir = Number(button.getAttribute('data-dir'));
    var press = function (e) {
      e.preventDefault();
      hold(dir);
    };
    var lift = function (e) {
      e.preventDefault();
      release(dir);
    };
    button.addEventListener('pointerdown', press);
    button.addEventListener('pointerup', lift);
    button.addEventListener('pointercancel', lift);
    button.addEventListener('pointerleave', lift);
  });

  var slowButton = document.getElementById('pad-slow');
  if (slowButton) {
    slowButton.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      touchSlow = !touchSlow;
      slowButton.classList.toggle('on', touchSlow);
    });
  }

  // --- flow -----------------------------------------------------------------

  function startGame() {
    S.state = 'playing';
    held.length = 0;
    resetBoard();
    syncOverlay();
  }

  function togglePause() {
    if (S.state === 'playing') {
      S.state = 'paused';
      held.length = 0;
    } else if (S.state === 'paused') {
      S.state = 'playing';
    } else {
      return;
    }
    syncOverlay();
  }

  function confirmAction() {
    if (S.state === 'title') {
      // The loud button: the first of the two versions.
      playVersion(VARIANTS.survivors.name);
    } else if (S.state === 'help') {
      closeHelp();
    } else if (S.state === 'paused') {
      togglePause();
    } else if (S.state === 'levelclear') {
      nextLevel();
    } else if (S.state === 'gameover') {
      continueGame();
    }
  }

  /**
   * Back into the level the run ended on: same score, same multiplier, a fresh
   * field and a full set of lives.
   */
  function continueGame() {
    // A continue is a fresh attempt at the level: the score starts again from
    // zero, though the level you reached is kept.
    S.score = 0;
    S.lives = START_LIVES;
    S.state = 'playing';
    resetBoard();
    syncOverlay();
  }

  /** Wipe the slate: level 1, no score, no multiplier, no score milestones. */
  function newRun() {
    // The hidden picker is one-shot: the level you typed, or 1 - and the next new
    // game starts at 1 again unless you go back to the menu and type another.
    S.level = typedLevelNumber() || 1;
    typedLevel = '';
    // A run that begins anywhere but level 1 is not a high-score attempt: it has
    // skipped the levels that would have earned the score.
    S.ranked = S.level === 1;
    S.score = 0;
    S.lives = START_LIVES;
    S.multiplier = 1;
    S.nextLifeAt = LIFE_EVERY_POINTS;
    startGame();
  }

  overlay.button.addEventListener('click', confirmAction);
  overlay.button2.addEventListener('click', function () {
    if (S.state === 'gameover') {
      newRun();
      return;
    }
    // The second version, from the menu.
    if (S.state === 'title') playVersion(VARIANTS.traps.name);
  });
  if (overlay.button3) {
    overlay.button3.addEventListener('click', function () {
      if (S.state === 'title') {
        openHelp();
      } else if (S.state === 'gameover') {
        backToMenu();
      }
    });
  }

  // --- go -------------------------------------------------------------------

  var previous = 0;

  function frame(now) {
    var dt = previous ? Math.min(now - previous, 64) : 0;
    previous = now;
    S.now = now;
    update(dt);
    render();
    requestAnimationFrame(frame);
  }

  newGame();
  render();
  requestAnimationFrame(frame);
})();

