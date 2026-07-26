# Task: close seamer-studio's command + de-duplication gaps

`seamer-studio` was ported onto the `atelier` engine but adoption is shallow in places, and a
comparison against a capture of the ORIGINAL production app (seamscape.com) found missing
commands. Close both.

## Working directory & boundaries

- Repo root: `/Users/ahmadjalil/github/Engine`
- **You may WRITE only inside `/Users/ahmadjalil/github/Engine/seamer-studio/`.**
- **Do NOT modify** `atelier/`, `packager/`, `seamer/`, or `packcad/`.
- Another agent is concurrently migrating `seamer-studio/src/lib/scene/` and
  `src/lib/components/PatternScene3D.svelte` to the engine viewport.
  **Do not touch `src/lib/scene/**` or `PatternScene3D.svelte`.**

## Reference: the original app

A capture of the real production app is at
`/Users/ahmadjalil/Downloads/seamscape.com/seamscape.com/`. Its command registry is inside
`_app/immutable/chunks/Ci4M-S45.js` (minified). Command definitions look like:

```js
"element.updateLabel":ce({type:"element.updateLabel",category:"element",
  summary:"Set or clear a free-text label on a resolvable element.",
  inputs:["elementId","label?"],example:{...},replayable:!0,mutating:!0})
```

You can grep that file directly for each command's exact `summary`, `inputs` and `example`.

## Part 1 — five missing commands

The original registers 79 commands; `seamer-studio` has 75, of which 74 match. Add these five
to `packages/pattern-model/src/commands/`, registered in the existing registry:

| Command | Category | What the original says |
|---|---|---|
| `element.updateLabel` | element | "Set or clear a free-text label on a resolvable element." `inputs:["elementId","label?"]` |
| `grading.applyPointShifts` | grading | "Apply labeled point-shift grading to true piece-boundary points…" |
| `grading.clearProfile` | grading | "Clear Freeform Parametrics grading state after restoring a base…" |
| `handle.update` | handle | "Update handle mirror constraints." |
| `transaction.commit` | transaction | "Internal compatibility command emitted when committing a live…" |

**Grep the capture for each one's full summary/inputs/example and match them exactly** — the
command schema is a public surface (`window.seamer`, the command palette, agent tooling), so
drift matters.

Notes:
- `grading.*` needs the `GradingProfile` / `AlterationTrack` types already in
  `packages/pattern-model/src/pattern.ts`.
- `handle.update` operates on `BezierHandle` mirror constraints (see `ConstrainablePath`).
- `transaction.commit` is a compatibility no-op shim: the engine's `Editor.transaction()` is
  the real mechanism. Register it as a command that returns the content unchanged so external
  replay scripts that emit it do not error. Give it `mutating: false` if your `CommandDef`
  supports it.

The original's `CommandDef` also carries a **`replayable`** boolean (73 of 79 have it) that
`@atelier/core`'s `CommandDef` does not. Do **not** modify the engine. Carry it app-side if
`pattern-model` needs it (e.g. a local `SeamerCommandDef = CommandDef<Pattern> & { replayable?: boolean }`)
and report whether you think it belongs in the engine.

Add tests asserting all 79 command types are registered.

## Part 2 — remove duplication the engine already provides

### 2a. Two copies of the same file inside seamer-studio (fix first — this is a live bug)

These exist in BOTH places and will drift apart:
- `src/lib/utils/patternGeometry.ts` **and** `packages/pattern-model/src/utils/patternGeometry.ts`
- `src/lib/utils/arcGeometry.ts` **and** `packages/pattern-model/src/utils/arcGeometry.ts`

Keep the `packages/pattern-model/` copy as canonical, delete the `src/lib/utils/` copy, and
repoint every importer at `@seamer/pattern-model`. Verify the two copies are actually
equivalent before deleting — if they have diverged, reconcile and say so in your report.

### 2b. Geometry functions still defined locally that `@atelier/geometry` exports

These are all still hand-defined in `seamer-studio` despite the engine exporting them:

```
pointInPolygon  polygonCentroid  offsetPolygon  offsetPolygonVariable  resamplePolyline
reflectAcrossLine  cubicAt  segmentLength  applyCornerJoins  convexHull
```

Delete the local definitions and import from `@atelier/geometry`. Also fold these whole files
into engine imports where the engine already covers them:
`src/lib/utils/{thinPlateSpline,hull}.ts`, and the generic packing core behind
`src/lib/utils/nestCore.ts`.

**Be careful:** keep anything `Pattern`-typed. `patternGeometry.ts` is ~1000 LOC of which only
the domain-free part moved to the engine — the resolvers (`pathPolyline`, `pieceOutline`,
`pieceTransform`, `seamGeometry`, `placedPoints`, `indexPoints`, …) MUST stay app-side.
`markerLayout.ts` is mostly Pattern-specific; only its packing core is engine work.

If a local implementation differs behaviourally from the engine's, **do not silently swap it** —
report the difference and keep the local one with a comment explaining why.

### 2c. Exporters → `@atelier/io`

`src/lib/utils/{exporters,pdf,hpgl,cutfile}.ts` (~970 LOC) duplicate `@atelier/io`. Only
`toSVG` and `toGLTF` are currently used from the engine.

Migrate DXF, PDF (including tiled printing), HPGL, CSV, PNG and cut-file generation to
`@atelier/io`, via the app's existing `Pattern → Drawing` flattener (see
`src/lib/utils/exporters.ts`). Keep app-side: the flattener itself, SSP project serialization,
marker/piece-label printing, and anything needing `Pattern` identity (the engine's `Drawing`
deliberately has no piece identity).

**Every export format the app exposes today must still work and produce equivalent output.**
Where the engine's output differs from the local one, report it rather than quietly accepting it.

## Hard constraints

- **TypeScript strict. Never use `any`.**
- pnpm. Svelte 5 runes. SSR-safe: no DOM globals at module scope.
- Preserve source comments that explain *why*.
- Concise, simple. This is deletion and rewiring, not redesign.
- Do not weaken or delete existing tests to make things pass.

## Commands to run (from `/Users/ahmadjalil/github/Engine/seamer-studio`)

```
pnpm install
pnpm check
pnpm test:unit
pnpm lint
```

All must pass with **0 errors and 0 warnings** from `pnpm check` (it is at 0/0 right now — do
not regress it). Do not run dev servers or builds.

## Report format

1. **Commands added** — the five, and confirmation their schema matches the capture.
2. **`replayable`** — your recommendation on whether it belongs in `@atelier/core`.
3. **Duplication removed** — LOC deleted per file, and what you deliberately kept app-side.
4. **Behavioural differences found** between local implementations and the engine's, and how
   you resolved each. This is the important part — do not gloss over any.
5. **Export formats** — a table of before/after, confirming each still works.
6. **Command output** for check, test, lint (final lines).
