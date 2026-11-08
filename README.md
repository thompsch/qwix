# Qwix

The 1981 Taito arcade game **Qix**, in the browser: claim 85% of the field by
drawing lines into open space without letting the Qix or the Sparx touch you.
Plain `<script>` tags, a canvas and no dependencies at all.

```sh
npm start     # http://localhost:3333   (PORT=8080 npm start to move it)
npm test      # the rules and a headless playthrough, no browser needed
```

Opening `index.html` straight off disk works too — nothing is fetched, so
there is no origin to trip over.

## How it plays

- **Claim 85% of the field** to clear a level. Draw a *Stix* out into open space
  and close it back onto claimed ground: every region the Qix is **not** trapped
  in becomes yours. You are paid for the area enclosed, not the length of line,
  and **each block you win gets its share of the field written inside it**, so the
  board itself records what every capture was worth.
- **Arrows / WASD** to move, **hold Shift** for a slow draw (an area drawn
  entirely slow scores double), **P** pauses, **Space/Enter** confirms a card.
  Touch devices get an on-screen pad.
- **The marker rides the lines.** With no Stix out it can only travel the frame,
  the outline of its own territory, and any Stix line it has already closed an
  area with — those lines stay drawn through the shading, so they become
  walkways across ground you own. Everything else shaded is solid.
- **The Qix** is harmless while the marker rides claimed ground, but touching it
  — or letting it touch the Stix — while a line is out costs a life. **Every part
  of it counts**: its body is a disc, and each spine is lethal along its whole
  length, out to whatever it is currently drawn at. The hit test and the drawing
  read the same geometry (`flexQix`), so what you can see is exactly what can hit
  you.
- **It moves fast, but smoothly.** A heading wanders on its own every second or
  two, a continuous weave curls the path around it, and a steering limit decides
  how fast the figure may turn — it curves and doubles back, it never jinks. Now
  and then it lunges at 1.8× speed, and it keeps its body clear of the shading so
  it bounces off what you own rather than clipping into it.
- **It also grows as a level drags on**: +75% over two minutes, then no more. A
  big figure is a big hitbox: the body disc and every spine scale with it.
- **Every ten levels it gets faster**: 9 cells/second at level 1, +2 at each step
  (11 from level 11, 13 from 21, and so on), capped at 22. The level-clear card
  tells you when the next level is a step up.
- **An extra life every million points — and dearer the deeper you go.** The
  first costs 1,000,000; each one after that costs another 100,000 per level you
  have reached (2,000,000 at level 11, 5,000,000 at level 41), so lives stop being
  something you can grind. The pause card tells you what the next one will cost.
- **Game over offers two ways out**: continue on the level you died on (fresh
  field, a full set of lives, score and multiplier kept) or start a new run from
  level 1. `Continue` is the loud button and what Space/Enter does.
- **Sparx** patrol the outline of everything you own. A level runs with one,
  **plus another every twenty levels** — two from level 20, three from 40, capped
  at four — and they start spread as far from you and from each other as the
  outline allows. They also creep quicker with the level: a millisecond off every
  step per level, twenty at most, so a level-21 Sparx is noticeably but not
  alarmingly faster than a level-1 one. After roughly a minute they become
  **Super Sparx** and will chase you up an unfinished Stix.
- **The fuse** lights when the marker stops mid-draw and burns back down the
  Stix towards you. Standing still is only safe for about 400 ms.
- **Dying on a line puts you back where that line began** — not at the top edge —
  so a long draw is a real commitment: dying near the end of one costs you the
  whole trip back to the start.
- **A second Qix arrives at level 3, and another every forty levels after that**
  (three from 40, four from 80). **A Qix only holds ground while it has the
  roomiest patch to run in.** Cut the board so each one is alone in its own patch
  and the ones in the *smaller* patches are crushed: their ground is taken with
  the rest and they are gone from the board, for a huge one-off bonus (50,000 ×
  your multiplier) and a step up the multiplier ladder (to x9). The survivor keeps
  its patch, so the level carries on. A Qix left with no open cell to stand in
  counts as trapped in the same way.
- **The trap bonus is paid first**, whatever else the stroke does. If the same
  cut also takes you past 85%, the clearance card lists the trap bonus next to
  the area bonus, so it is never silently swallowed by the level ending.

## Layout

- `engine.js` — the rules: playfield, flood fill, the capture test, the Sparx
  outline walk. No DOM, no clock, no randomness, so it is directly testable.
- `qwix.js` — the game: input, motion, Qix/Sparx/Fuse, scoring and the canvas.
  Loaded after `engine.js`.
- `index.html`, `qwix.css` — the page.
- `server.js` — a dependency-free static server (`npm start`).
- `test/qwix.test.mjs` — unit tests for `engine.js`: the frame/interior model,
  flood fill, boundary detection, the outline walk, capture sizes and
  percentages, split detection, walkable lines, and the odd edge cases.
- `test/qwix.hits.mjs` — unit tests for the Qix's hit geometry: the body disc,
  and spines that are lethal along their whole length rather than just near the
  core. Boots the real `qwix.js` with one line added to hand out `hitsQix`.
- `test/qwix.progress.mjs` — unit tests for the progression rules: a life every
  half million (including a stroke that crosses several milestones at once), and
  the two buttons on the game-over card.
- `test/qwix.smoke.mjs` — boots the real `qwix.js` against a stub DOM, a stub
  canvas and a hand-cranked clock, then plays it: start, claim a region, die to
  the fuse, pause and resume, clear a level at 85%, split two Qixes, and survive
  a simulated minute of frantic input. The stub canvas also records what gets
  painted, so every frame is checked against the rule that the marker only ever
  stands on open space or a line.

## Coordinates, if you are reading the code

The playfield is a grid of cells (`80 x 60`, drawn at `10px` each). The outer
ring of cells starts out claimed — "the frame" — which gives the marker an edge
to ride and guarantees a captured region can never leak out of the board. All
percentages are of the *interior*, so a fresh level reads 0%.

A closed Stix splits the open space into regions. The roomiest region a Qix is
running in is kept, and every other empty cell is handed to the player — which
includes a patch holding a Qix that has just been boxed into somewhere smaller.
That Qix is crushed along with its ground, so no region is ever dead space, while
the survivor keeps running in the biggest patch and the level goes on.

The Stix itself is remembered in `field.lines`, which is what makes old lines
walkable once the shading closes over them: `isWalkable` is "the frame, the
outline of claimed ground, *or* an old line". Sparx still only patrol the
outline (`nextBoundaryStep`), so a line through the middle of your territory is
a shortcut for the marker alone.
