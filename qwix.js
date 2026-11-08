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
  var LEVEL_BONUS_PER_PERCENT = 500;
  var TRAP_BONUS = 50000;      // a Qix walled in and taken: the payday
  var LIFE_EVERY_POINTS = 1000000; // a life for the first million...
  var LIFE_LEVEL_STEP = 100000;    // ...and dearer by this much every level after
  var MAX_MULTIPLIER = 9;

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
  var DEATH_MS = 1200;
  var LEVEL_CLEAR_MS = 2000;
  var INVULN_MS = 1400;
  var SUPER_AFTER_MS = 42000;  // Sparx mutate into Super Sparx after this
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

  // One Qix, a second from level 3, and another every forty levels after that.
  var QIX_FROM_LEVEL = 3;
  var QIX_EVERY_LEVELS = 40;
  var QIX_SPREAD = 14;         // how far apart they start, in cells

  // It gets bigger the longer a level lasts: +75% over two minutes, then no more.
  var QIX_GROWTH_MAX = 0.75;
  var QIX_GROWTH_MS = 120000;

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

  var CAPTURE_COLORS = ['#1c7a52', '#2a6f9e', '#6b4fa8', '#a85f2a', '#2a8f95'];

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
    lives: document.getElementById('hud-lives'),
    mult: document.getElementById('hud-mult'),
    best: document.getElementById('hud-best'),
    percent: document.getElementById('hud-percent'),
    fill: document.getElementById('hud-fill'),
  };
  var overlay = {
    root: document.getElementById('overlay'),
    title: document.getElementById('overlay-title'),
    body: document.getElementById('overlay-body'),
    button: document.getElementById('overlay-button'),
    button2: document.getElementById('overlay-button-2'),
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
      player: emptyPlayer(),
      qixes: [],
      sparx: [],
      fuse: { active: false, pos: 0, acc: 0 },
      levelTime: 0,
      levelAge: 0,
      super: false,
      invulnUntil: 0,
      fieldDirty: true,
      clearInfo: null,
      trapDone: false,
      nextLifeAt: LIFE_EVERY_POINTS,
      blocks: [],
      deathSpot: null,
      flash: null,
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
    S.sparx = buildSparxWave();
    S.fuse.active = false;
    S.levelTime = 0;
    S.levelAge = 0; // the Qix's growth clock, which a death does not rewind
    S.super = false;
    S.trapDone = false;
    S.blocks = [];
    S.deathSpot = null;
    S.flash = null;
    S.invulnUntil = S.now + INVULN_MS;
  }

  /**
   * How many Qixes a level runs with: one to begin with, two from level 3, and
   * another every forty levels after that (three from 40, four from 80...).
   */
  function qixCount(level) {
    var at = level === undefined ? S.level : level;
    if (at < QIX_FROM_LEVEL) return 1;
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
   * the outline allows, so they never arrive in a clump.
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
      out.push({ x: best.x, y: best.y, dir: E.RIGHT, acc: 0, super: false });
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
    if (S.score <= S.best) return;
    S.best = S.score;
    try {
      localStorage.setItem('qwix.best', String(S.best));
    } catch (err) {
      /* private mode, no storage: the score simply is not remembered */
    }
  }

  // --- the clock ------------------------------------------------------------

  function update(dt) {
    if (S.state === 'playing') {
      tick(dt);
      return;
    }
    if (S.state === 'dying') {
      S.timer -= dt;
      if (S.timer <= 0) afterDeath();
      return;
    }
    if (S.state === 'levelclear') {
      S.timer -= dt;
      if (S.timer <= 0) {
        S.level += 1;
        S.clearInfo = null;
        resetBoard();
        S.state = 'playing';
        syncOverlay();
      }
    }
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
    var dir = input.dir();
    var moved = false;
    if (dir >= 0) {
      var stepMs = stepMsFor(p);
      p.acc += dt;
      var guard = 0;
      while (p.acc >= stepMs && guard < 4) {
        guard += 1;
        p.acc -= stepMs;
        if (!playerStep(dir)) {
          p.acc = 0;
          break;
        }
        moved = true;
        if (S.state !== 'playing') return;
      }
    } else {
      p.acc = 0;
    }
    // How long the marker has been unable (or unwilling) to move. The fuse
    // measures this rather than the key state, so holding a direction into a
    // wall is not a way to stand still safely.
    p.still = moved ? 0 : p.still + dt;
  }

  /**
   * One cell of movement. With no Stix out the marker can only walk the line it
   * is standing on - the frame, or the outline of claimed ground - and stepping
   * into open space starts a Stix. Stepping back onto claimed ground from a
   * Stix closes it, which is the only way to win anything.
   */
  function playerStep(dir) {
    var p = S.player;
    var v = E.VECTORS[dir];
    var nx = p.x + v[0];
    var ny = p.y + v[1];
    if (!E.inBounds(S.field, nx, ny)) return false;
    var cell = E.index(S.field, nx, ny);

    if (p.drawing) {
      if (dir === E.opposite(p.dir)) return false; // no backtracking
      if (p.trailMask[cell]) return false;         // no crossing your own Stix
      p.dir = dir;
      p.x = nx;
      p.y = ny;
      if (E.isFilled(S.field, nx, ny)) {
        closeClaim();
        return true;
      }
      addTrail(cell);
      return true;
    }

    if (E.isFilled(S.field, nx, ny)) {
      // Shaded ground is solid, except along the old Stix lines drawn through
      // it: the marker rides the frame, the outline of what it owns, and every
      // line it has closed an area with.
      if (!E.isWalkable(S.field, nx, ny)) return false;
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
    addTrail(cell);
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
      if (!keeps) crushed += 1;
      return keeps;
    });

    // A split (each Qix alone in its own patch) is the big score: it pays out
    // once, and raising the multiplier is the reward for the cut that made it.
    // A Qix buried where there is no open cell left is just as trapped, and it
    // can happen on the stroke that also wins the round, so the bonus is paid
    // before the level is allowed to finish and is carried onto that card.
    var trapBonus = crushed > 0 ? awardTrap(crushed) : 0;

    // A Qix left standing on ground that just became ours has nowhere to live.
    ensureQixesLegal();
    // ...and the closing cell can end up buried inside the new shading, which
    // would strand the marker off the lines entirely.
    snapMarkerToLine();

    if (S.percent >= TARGET_PERCENT) finishLevel(trapBonus);

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
    flash('EXTRA ' + (gained > 1 ? gained + ' LIVES' : 'LIFE') + '   lives ' + S.lives, 2200);
  }

  /**
   * A Qix has been walled in and taken, so its ground is ours. That can only
   * happen once a level (the survivors end up sharing one patch), so it is paid
   * once and the amount is returned for the level card to quote.
   */
  function awardTrap(crushed) {
    if (S.trapDone) return 0;
    S.trapDone = true;
    var bonus = TRAP_BONUS * S.multiplier;
    S.score += bonus;
    if (S.multiplier < MAX_MULTIPLIER) S.multiplier += 1;
    saveBest();
    flash(
      (crushed > 1 ? 'QIXES' : 'QIX') + ' TRAPPED  +' + bonus + '   bonus x' + S.multiplier,
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
    S.flash = { text: text, until: S.now + ms, ms: ms };
  }

  function finishLevel(trapBonus) {
    var over = Math.max(0, S.percent - TARGET_PERCENT);
    var bonus = Math.round(over * LEVEL_BONUS_PER_PERCENT * S.multiplier);
    S.score += bonus;
    saveBest();
    S.clearInfo = {
      bonus: bonus,
      percent: S.percent,
      trapBonus: trapBonus || 0,
      faster: speedAtLevel(S.level + 1) > speedAtLevel(S.level),
    };
    S.state = 'levelclear';
    S.timer = LEVEL_CLEAR_MS;
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
    S.sparx = buildSparxWave();
    S.super = false;
    S.levelTime = 0;
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
   * Sparx ride the outline of everything claimed. Super Sparx may also run up
   * an unfinished Stix, which is what makes long slow draws a gamble.
   */
  function sparxStep(s) {
    var p = S.player;
    if (s.super && p.drawing) {
      var here = E.index(S.field, s.x, s.y);
      if (p.trailMask[here]) {
        stepTrailTowardPlayer(s, here);
        return;
      }
      if (Math.random() < 0.18) {
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
    s.dir = E.opposite(s.dir);
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
   */
  function updateFuse(dt) {
    var p = S.player;
    var f = S.fuse;
    if (!p.drawing || p.still < FUSE_GRACE_MS) {
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

  // --- what kills you -------------------------------------------------------

  /**
   * Animate the spines. Drawing and hit detection both call this on the same
   * clock, so the figure you can see is exactly the figure that can hit you.
   */
  function flexQix(q) {
    var scale = q.scale || 1;
    for (var i = 0; i < q.segs.length; i++) {
      var seg = q.segs[i];
      seg.angle = seg.a + Math.sin(S.now * 0.0035 + seg.phase) * 0.8;
      seg.reach = seg.len * (0.65 + 0.35 * Math.sin(S.now * 0.005 + seg.phase * 1.7))
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
   * The only thing that happens inside a level is the Sparx turning super. How
   * many Sparx there are is a property of the level itself (see sparxCount), so
   * there is nothing to release here.
   */
  function updateLevelClock(dt) {
    S.levelTime += dt;
    S.levelAge += dt; // survives deaths, so the figure keeps what it has grown
    var superAt = Math.max(12000, SUPER_AFTER_MS - (S.level - 1) * 5000);
    if (!S.super && S.levelTime >= superAt) {
      S.super = true;
      for (var i = 0; i < S.sparx.length; i++) S.sparx[i].super = true;
    }
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
    c.fillStyle = CAPTURE_COLORS[(S.level - 1) % CAPTURE_COLORS.length];
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
    drawSparx();
    drawMarker();
    drawFlash();
    syncHud();
  }

  /** The one banner in the game: a split just paid out. */
  function drawFlash() {
    var f = S.flash;
    if (!f || S.now > f.until) return;
    var left = (f.until - S.now) / (f.ms || 1);
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
      ctx.rotate(S.now * 0.006 + i);
      ctx.strokeStyle = s.super ? '#ff4d6d' : '#c9a0ff';
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
    ctx.rotate(S.now * 0.004);
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
    setText(hud.score, String(S.score));
    setText(hud.level, String(S.level));
    setText(hud.lives, S.lives > 0 ? new Array(S.lives + 1).join('\u25C6') : '\u2014');
    setText(hud.mult, 'x' + S.multiplier);
    setText(hud.best, String(Math.max(S.best, S.score)));
    setText(hud.percent, Math.floor(S.percent) + '%');
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

  /** One card, one title, one or two buttons. */
  function showCard(title, body, primary, secondary) {
    var o = overlay;
    o.title.textContent = title;
    o.body.textContent = body;
    o.button.textContent = primary;
    o.button.hidden = false;
    if (secondary) {
      o.button2.textContent = secondary;
      o.button2.hidden = false;
    } else {
      o.button2.hidden = true;
    }
    o.root.hidden = false;
  }

  function syncOverlay() {
    var o = overlay;
    var visible =
      S.state === 'title' || S.state === 'paused' ||
      S.state === 'levelclear' || S.state === 'gameover';
    if (!visible) {
      o.root.hidden = true;
      return;
    }

    if (S.state === 'title') {
      showCard('QWIX', [
        'Claim ' + TARGET_PERCENT + '% of the field to clear a level.',
        'Draw a Stix into open space, then close it: every region the Qix is not in becomes yours.',
        'The marker rides the lines - the frame, the outline of your ground, and every line you have drawn.',
        'Arrows or WASD to move. Hold Shift for a slow draw - an area drawn entirely slow scores double.',
        'A life every ' + bigNumber(LIFE_EVERY_POINTS) + ' points, and dearer as the levels climb.',
        'Do not stand still mid-draw (the fuse lights) and do not let the Qix touch your Stix.',
      ].join('\n'), 'Start');
      return;
    }

    if (S.state === 'paused') {
      showCard('PAUSED', [
        'Score ' + S.score + ' - level ' + S.level + ', ' + S.lives + ' lives left.',
        'Next life at ' + bigNumber(S.nextLifeAt) + ' (' + bigNumber(lifeCost()) + ' from here).',
      ].join('\n'), 'Resume');
      return;
    }

    if (S.state === 'levelclear') {
      var info = S.clearInfo || { bonus: 0, percent: S.percent, faster: false, trapBonus: 0 };
      showCard('LEVEL ' + S.level + ' CLEAR', [
        Math.floor(info.percent) + '% claimed - bonus ' + info.bonus + ' points.',
        info.trapBonus ? 'Qix trapped on the way out: +' + info.trapBonus + ' points, bonus x' + S.multiplier + '.' : null,
        info.faster ? 'The Qix is quicker from here on.' : null,
      ].filter(Boolean).join('\n'), 'Continue');
      return;
    }

    showCard('GAME OVER', [
      'Score ' + S.score + ' on level ' + S.level + '. Best ' + S.best + '.',
      'Continue retries level ' + S.level + ' with a fresh field and ' + START_LIVES + ' lives, keeping your score.',
    ].join('\n'), 'Continue level ' + S.level, 'New game');
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
    dir: function () {
      return held.length ? held[held.length - 1] : -1;
    },
    get slow() {
      return this.forceSlow || touchSlow;
    },
    forceSlow: false,
  };

  function hold(dir) {
    // Starting from the title card must not eat the keypress that started it,
    // so the game boots first and the direction is held afterwards.
    if (S.state === 'title') startGame();
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
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      confirmAction();
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
      startGame();
    } else if (S.state === 'paused') {
      togglePause();
    } else if (S.state === 'gameover') {
      continueGame();
    }
  }

  /**
   * Back into the level the run ended on: same score, same multiplier, a fresh
   * field and a full set of lives.
   */
  function continueGame() {
    S.lives = START_LIVES;
    S.state = 'playing';
    resetBoard();
    syncOverlay();
  }

  /** Wipe the slate: level 1, no score, no multiplier, no score milestones. */
  function newRun() {
    S.level = 1;
    S.score = 0;
    S.lives = START_LIVES;
    S.multiplier = 1;
    S.nextLifeAt = LIFE_EVERY_POINTS;
    startGame();
  }

  overlay.button.addEventListener('click', confirmAction);
  overlay.button2.addEventListener('click', function () {
    if (S.state === 'gameover') newRun();
  });

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

