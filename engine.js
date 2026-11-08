/**
 * Qwix - the pure, DOM-free core of the 1981 territory-claiming arcade game.
 *
 * qwix.js drives this from the page and paints it to a canvas; test/qwix.test.mjs
 * evals this file in Node and checks the geometry. Nothing here touches the DOM,
 * a timer or a random number generator, so every rule below is reproducible.
 *
 * Coordinates are cell indices: x in 0..cols-1, y in 0..rows-1. The outer ring
 * of cells starts out claimed ("the frame"), which gives the marker an edge to
 * ride and guarantees a captured region can never leak out of the playfield.
 *
 * Percentages are always of the *interior* - the frame is scaffolding, not
 * territory, so a fresh level reads 0%.
 */
(function (root) {
  'use strict';

  // Screen coordinates: y grows downward, so RIGHT is +x and DOWN is +y.
  var UP = 0, RIGHT = 1, DOWN = 2, LEFT = 3;
  var VECTORS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  var EMPTY = 0, FILLED = 1;

  /** A playfield with a claimed one-cell frame and an untouched interior. */
  function createField(cols, rows) {
    var cells = new Uint8Array(cols * rows);
    for (var y = 0; y < rows; y++) {
      for (var x = 0; x < cols; x++) {
        if (x === 0 || y === 0 || x === cols - 1 || y === rows - 1) {
          cells[y * cols + x] = FILLED;
        }
      }
    }
    return {
      cols: cols,
      rows: rows,
      cells: cells,
      // Stix lines are remembered after they close, so they stay walkways through
      // the shading that grows around them.
      lines: new Uint8Array(cols * rows),
      claimable: Math.max(0, (cols - 2) * (rows - 2)),
    };
  }

  function index(field, x, y) {
    return y * field.cols + x;
  }

  function inBounds(field, x, y) {
    return x >= 0 && y >= 0 && x < field.cols && y < field.rows;
  }

  /** Outside the playfield behaves like solid ground: nothing may leave it. */
  function isFilled(field, x, y) {
    if (!inBounds(field, x, y)) return true;
    return field.cells[y * field.cols + x] === FILLED;
  }

  function setFilled(field, x, y, value) {
    if (!inBounds(field, x, y)) return;
    field.cells[y * field.cols + x] = value ? FILLED : EMPTY;
  }

  function cellX(field, cell) {
    return cell % field.cols;
  }

  function cellY(field, cell) {
    var x = cell % field.cols;
    return (cell - x) / field.cols;
  }

  function opposite(dir) {
    return (dir + 2) % 4;
  }

  /**
   * Every empty cell reachable from `start` by a 4-connected walk. Returns []
   * when `start` is already claimed. Region sizes are what the scoring and the
   * "is the Qix sealed in?" question both come down to.
   */
  function floodRegion(field, start) {
    var out = [];
    if (start == null || start < 0 || start >= field.cells.length) return out;
    if (field.cells[start] !== EMPTY) return out;

    var seen = new Uint8Array(field.cells.length);
    var stack = [start];
    seen[start] = 1;
    while (stack.length) {
      var cell = stack.pop();
      out.push(cell);
      var x = cellX(field, cell);
      var y = cellY(field, cell);
      for (var d = 0; d < 4; d++) {
        var nx = x + VECTORS[d][0];
        var ny = y + VECTORS[d][1];
        if (!inBounds(field, nx, ny)) continue;
        var next = ny * field.cols + nx;
        if (seen[next] || field.cells[next] !== EMPTY) continue;
        seen[next] = 1;
        stack.push(next);
      }
    }
    return out;
  }

  /** Claimed cells inside the frame (the frame itself does not count). */
  function countClaimed(field) {
    var n = 0;
    for (var y = 1; y < field.rows - 1; y++) {
      for (var x = 1; x < field.cols - 1; x++) {
        if (field.cells[y * field.cols + x] === FILLED) n++;
      }
    }
    return n;
  }

  function percentFilled(field) {
    if (!field.claimable) return 0;
    return (countClaimed(field) / field.claimable) * 100;
  }

  /**
   * Open space. Outside the playfield counts as open, so the frame's own corners
   * - which only ever touch other frame cells - still sit on the outline.
   */
  function isExposed(field, x, y) {
    if (!inBounds(field, x, y)) return true;
    return field.cells[y * field.cols + x] === EMPTY;
  }

  /**
   * A claimed cell that is exposed to open space - the only cells a Sparx may
   * stand on, since they travel the outline of everything you own.
   */
  function isBoundaryCell(field, x, y) {
    if (!isFilled(field, x, y)) return false;
    for (var d = 0; d < 4; d++) {
      if (isExposed(field, x + VECTORS[d][0], y + VECTORS[d][1])) return true;
    }
    return false;
  }

  /**
   * Right-hand rule: from a boundary cell, prefer the turn that keeps the wall
   * on the Sparx's right, then straight, then the left turn, then back. That
   * walks the outline of the claimed area without any pathfinding.
   */
  function nextBoundaryStep(field, x, y, dir) {
    if (dir !== UP && dir !== RIGHT && dir !== DOWN && dir !== LEFT) dir = RIGHT;
    var order = [(dir + 1) % 4, dir, (dir + 3) % 4, (dir + 2) % 4];
    for (var k = 0; k < order.length; k++) {
      var d = order[k];
      var nx = x + VECTORS[d][0];
      var ny = y + VECTORS[d][1];
      if (!inBounds(field, nx, ny)) continue;
      if (!isBoundaryCell(field, nx, ny)) continue;
      return { x: nx, y: ny, dir: d };
    }
    return null;
  }

  /** Closest empty cell to `fromCell`, searching rings outward. -1 if none. */
  function nearestEmpty(field, fromCell, maxRadius) {
    if (field.cells[fromCell] === EMPTY) return fromCell;
    var cx = cellX(field, fromCell);
    var cy = cellY(field, fromCell);
    var reach = maxRadius || 8;
    for (var radius = 1; radius <= reach; radius++) {
      for (var dy = -radius; dy <= radius; dy++) {
        for (var dx = -radius; dx <= radius; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
          var x = cx + dx;
          var y = cy + dy;
          if (!inBounds(field, x, y)) continue;
          var cell = y * field.cols + x;
          if (field.cells[cell] === EMPTY) return cell;
        }
      }
    }
    return -1;
  }

  /**
   * Closest line cell to `fromCell` - where the marker has to be standing. The
   * frame is always a line, so this finds something on any board with a frame.
   */
  function nearestBoundaryCell(field, fromCell, maxRadius) {
    var cx = cellX(field, fromCell);
    var cy = cellY(field, fromCell);
    if (isBoundaryCell(field, cx, cy)) return fromCell;
    var reach = maxRadius || 8;
    for (var radius = 1; radius <= reach; radius++) {
      for (var dy = -radius; dy <= radius; dy++) {
        for (var dx = -radius; dx <= radius; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
          var x = cx + dx;
          var y = cy + dy;
          if (!inBounds(field, x, y)) continue;
          if (!isBoundaryCell(field, x, y)) continue;
          return y * field.cols + x;
        }
      }
    }
    return -1;
  }

  /** Has this cell ever been part of a Stix that closed? */
  function isLine(field, x, y) {
    if (!inBounds(field, x, y)) return false;
    return field.lines[y * field.cols + x] === 1;
  }

  /**
   * Ground the marker may stand on without drawing: the frame, the outline of
   * claimed territory, or an old Stix line running through the middle of it.
   * Open space is not walkable - you step into it and start drawing.
   */
  function isWalkable(field, x, y) {
    if (!isFilled(field, x, y)) return false;
    if (isBoundaryCell(field, x, y)) return true;
    return isLine(field, x, y);
  }

  /** Closest walkable cell to `fromCell`. -1 if the board has none. */
  function nearestWalkableCell(field, fromCell, maxRadius) {
    var cx = cellX(field, fromCell);
    var cy = cellY(field, fromCell);
    if (isWalkable(field, cx, cy)) return fromCell;
    var reach = maxRadius || 8;
    for (var radius = 1; radius <= reach; radius++) {
      for (var dy = -radius; dy <= radius; dy++) {
        for (var dx = -radius; dx <= radius; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
          var x = cx + dx;
          var y = cy + dy;
          if (!inBounds(field, x, y)) continue;
          if (!isWalkable(field, x, y)) continue;
          return y * field.cols + x;
        }
      }
    }
    return -1;
  }

  /**
   * Close a Stix: lay it down as claimed ground, then hand the marker every
   * empty region that does not contain a Qix. That is the whole capture rule -
   * the side(s) the Qix is trapped out of become yours.
   *
   * The exception is a Qix that ends up boxed into a patch smaller than the one
   * another Qix is running in. It has nowhere to go, so the walls holding it are
   * already up and its ground is won like any other - the level carries on,
   * because the roomiest patch is still open.
   *
   * `qixCells` is one cell index per Qix. A Qix standing where the line just
   * landed is nudged to the nearest open cell.
   *
   * Returns:
   *   trailCells    - the Stix, now solid
   *   claimed       - newly won cells, excluding the Stix itself (this is what
   *                   scores: the Stix is scaffolding, the enclosed area is loot)
   *   qixRegionIds  - which region each Qix ended up in (-1 = none left)
   *   qixRegions    - those regions' cells, in the same order
   *   keptRegionId  - the one region left open; every Qix with a different id
   *                   has been crushed (-1 = nothing left open)
   *   split         - every Qix sits alone in its own region (the 2-Qix goal)
   *   percent       - percentage of the interior claimed afterwards
   */
  function resolveClaim(field, trail, qixCells) {
    var trailCells = trail ? trail.slice() : [];
    for (var t = 0; t < trailCells.length; t++) {
      // The line becomes ground, and stays a line: once the shading closes over
      // it there is still somewhere to walk.
      field.cells[trailCells[t]] = FILLED;
      field.lines[trailCells[t]] = 1;
    }

    var regions = [];
    var regionOf = new Map();
    var qixRegionIds = [];
    var cells = qixCells || [];

    for (var q = 0; q < cells.length; q++) {
      var cell = cells[q];
      if (cell == null || cell < 0 || cell >= field.cells.length) {
        qixRegionIds.push(-1);
        continue;
      }
      if (field.cells[cell] === FILLED) {
        cell = nearestEmpty(field, cell, 8);
        if (cell < 0) {
          qixRegionIds.push(-1);
          continue;
        }
      }
      if (regionOf.has(cell)) {
        qixRegionIds.push(regionOf.get(cell));
        continue;
      }
      var region = floodRegion(field, cell);
      var id = regions.length;
      regions.push(region);
      for (var i = 0; i < region.length; i++) regionOf.set(region[i], id);
      qixRegionIds.push(id);
    }

    var homed = qixRegionIds.length > 1;
    var distinct = new Set();
    for (var k = 0; k < qixRegionIds.length; k++) {
      if (qixRegionIds[k] < 0) homed = false;
      distinct.add(qixRegionIds[k]);
    }
    var split = homed && distinct.size === qixRegionIds.length;

    // A Qix only holds ground while it has the roomiest patch to run in. The
    // biggest region is kept; any Qix boxed into a smaller one is crushed and
    // its ground is taken with the rest. With a single Qix, or two sharing one
    // patch, that is the only region there is, so nothing changes for them.
    var keptRegionId = -1;
    var keepSize = -1;
    for (var r = 0; r < regions.length; r++) {
      if (regions[r].length > keepSize) {
        keepSize = regions[r].length;
        keptRegionId = r;
      }
    }

    var claimed = [];
    for (var y = 1; y < field.rows - 1; y++) {
      for (var x = 1; x < field.cols - 1; x++) {
        var pos = y * field.cols + x;
        if (field.cells[pos] !== EMPTY) continue;
        if (keptRegionId >= 0 && regionOf.get(pos) === keptRegionId) continue;
        field.cells[pos] = FILLED;
        claimed.push(pos);
      }
    }

    return {
      trailCells: trailCells,
      claimed: claimed,
      qixRegions: regions,
      qixRegionIds: qixRegionIds,
      keptRegionId: keptRegionId,
      split: split,
      percent: percentFilled(field),
    };
  }

  var api = {
    UP: UP,
    RIGHT: RIGHT,
    DOWN: DOWN,
    LEFT: LEFT,
    VECTORS: VECTORS,
    EMPTY: EMPTY,
    FILLED: FILLED,
    createField: createField,
    index: index,
    inBounds: inBounds,
    isFilled: isFilled,
    setFilled: setFilled,
    cellX: cellX,
    cellY: cellY,
    opposite: opposite,
    floodRegion: floodRegion,
    countClaimed: countClaimed,
    percentFilled: percentFilled,
    isBoundaryCell: isBoundaryCell,
    isExposed: isExposed,
    isLine: isLine,
    isWalkable: isWalkable,
    nextBoundaryStep: nextBoundaryStep,
    nearestEmpty: nearestEmpty,
    nearestBoundaryCell: nearestBoundaryCell,
    nearestWalkableCell: nearestWalkableCell,
    resolveClaim: resolveClaim,
  };

  root.QwixEngine = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

