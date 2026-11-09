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

## Two versions, and the menu that asks

The game opens on a chooser:

> **Which version do you want to play? Capture the Qwix or Kill the Qwix**

| button | rules | what pays |
|---|---|---|
| **Capture the Qwix** (the default; Enter/Space) | `survivors` | you win by keeping them: a kill pays nothing, and clearing the board pays 50,000 × multiplier for **every Qix still alive beyond the first** |
| **Kill the Qwix** | `traps` | a Qix is erased from the board and pays 50,000 × multiplier on the spot, and the kill is the loud one: a white-hot core, three staggered shockwaves and sixteen pieces of shrapnel as the figure collapses over 900 ms. **A level is not over until every Qix but one is gone** — kill mode clears on 85% *and* one left standing |
| **How to play** (or `H`) | — | the instructions, on their own card; `Back`, Enter or Escape returns to the menu |

The version only changes the payout: crushing a Qix is a consequence of the
capture rule either way, so under Capture the Qwix cutting them apart actually
*costs* you money — every Qix you lose is a share of the end-of-level pot gone.
The game-over card has a **Menu** button, so you can switch versions without
reloading the page.

There is also a hidden way to pick your starting level: type a number on the menu
and the version you then click begins at that level (the card grows a
`Starting on level 20.` line so you can see it took). `Backspace` unpicks a digit,
`Escape` drops the lot, and it is one-shot — the next new game starts at level 1
again. Nothing in the game mentions it.

Both run through the same tests; `npm test` covers the default, and both
versions' numbers are pinned in `test/qwix.progress.mjs`.

## How it plays

- **Claim 85% of the field** to clear a level. Draw a *Stix* out into open space
  and close it back onto claimed ground: every region the Qix is **not** trapped
  in becomes yours. You are paid for the area enclosed, not the length of line,
  and **each block you win gets its share of the field written inside it**, so the
  board itself records what every capture was worth. The clearance card **stays
  until you dismiss it** — Space/Enter, or the button — so you can read what the
  level paid.
- **Arrows / WASD** to move, **hold Shift** for a slow draw (an area drawn
  entirely slow scores double), **P** pauses, **Space/Enter** confirms a card,
  **H** opens the help. Touch devices get an on-screen pad. **Hold two
  directions** while riding a line and the marker keeps its heading until the new
  one is available, then takes it — so corners can be cut without stopping. While
  drawing a Stix only the newest key counts.
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
  alarmingly faster than a level-1 one. **Go 15 seconds without drawing a line and
  they turn hostile** — the 15 is the same on every level, and *drawing* is the only
  thing that keeps them calm: walking the outline, however busy that looks, does not
  reset the clock. That is when they
  stop patrolling and start hunting: a
  hunting Sparx follows the shortest walkable route to you, and steps straight
  onto your Stix if one is out. A new line restarts the clock, but it does not call
  off a hunt already in progress; **a
  death calms them**, and so does clearing the level, and either way you get the
  full allowance back. **A fresh board starts with the clock switched off**: it is
  not running until you draw your first line, or until 45 seconds have gone
  by with you doing nothing — so you can read the board, and a respawn is never a
  countdown, but camping is not a strategy either. You are faster than they are
  (45 cells/second against ~15),
  so a chase is survivable, but they will not wander off on their own. If a claim
  closes over the cell a Sparx is standing on — most likely one climbing your Stix
  — it is put back on the nearest piece of outline rather than left stranded in
  the shading with nowhere to walk.
- **Red is red, on every level.** Claimed ground cycles through five cool shades —
  green, blue, purple, navy, teal — and none of them is warm, so a hunting Sparx's
  red never has to compete with an orange or a red board (level 4 used to be an
  orange that swallowed it). A **hunting** Sparx also gains a bright yellow ring
  around it, glowing, so "one of them has turned" is visible without reading the
  colour of a 7-pixel cross. A patrolling one has no ring at all.
- **The fuse** lights when the marker stops mid-draw and burns back down the
  Stix towards you. Standing still is only safe for about 400 ms — but a short
  line is spared a little longer, because the spark only has a cell or two to
  cross: anything under 50 px gets 120 ms extra for every cell it is short, so a
  one-cell dab gives you 900 ms instead of 420.
- **Dying on a line puts you back where that line began** — not at the top edge —
  so a long draw is a real commitment: dying near the end of one costs you the
  whole trip back to the start.
- **Two Qix from the very first level, and another every ten levels after that**
  (three from 10, four from 20, twelve by 100). **A Qix only holds ground while it has the
  roomiest patch to run in.** Cut the board so each one is alone in its own patch
  and the ones in the *smaller* patches are crushed: their ground is taken with
  the rest and they are gone from the board. The survivor keeps its patch, so the
  level carries on. A Qix left with no open cell to stand in counts as trapped in
  the same way. What a kill is *worth* depends on the variant above — 50,000 ×
  multiplier under `traps`, a lost share of the pot under `survivors`.

The bonus multiplier is applied to every payout but **never shown**: no stat in the
**At the end of a level every line of the recap is on the board at once** — a stack
rather than a queue, each line fading in as the one above it finishes. Five lines
take about three seconds, not ten, and nothing needs dismissing: the next level
follows the stack.

readout, no `3x bonus!` on a notice, no `bonus x3` on the kill banner. It still
climbs one step every ten levels, to x9.
- **Under Kill the Qwix the kill bonus is paid first**, whatever else the stroke
  does. If the same cut also takes you past 85%, the clearance card lists the kill
  bonus next to the area bonus, so it is never silently swallowed by the level
  ending. The Capture pot is handled the same way.
- **Clearing a level pays two more bonuses, both on the clearance card.**
  *Over achiever*: every point claimed past 85% pays 2,000 (so a clean 100%
  adds 30,000, times your multiplier). *Speed demon bonus*: the par is 20 seconds — the
  same 20 on every level — and every whole second finished inside it pays 10,000:
  a clear in 12 s is 8 seconds under and pays 80,000, and par itself pays nothing.
  It does not stretch as the levels get harder, so the pot is only on offer to a
  genuinely quick clear. Both are multiplied, both
  are itemised on the card, and the card totals them at the end.

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
  million (and dearer with the level), a stroke that crosses several milestones at
  once, the two buttons on the game-over card, the survivors pot, par and the
  speed demon bonus, the version named at the top of the page, the Sparx turning hostile
  after a spell of standing still, the fuse giving a short Stix a longer grace, and a Sparx
  stranded by a claim being put back on the outline instead of freezing.
- `test/qwix.smoke.mjs` — boots the real `qwix.js` against a stub DOM, a stub
  canvas and a hand-cranked clock, then plays it: start, claim a region, die to
  the fuse, pause and resume, clear a level at 85%, split two Qix, and survive
  a simulated minute of frantic input. The stub canvas also records what gets
  painted, so every frame is checked against the rule that the marker only ever
  stands on open space or a line — and every Sparx is checked to be on the
  outline, still walking, after a claim.

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
