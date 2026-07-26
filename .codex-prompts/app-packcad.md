# Task: create the `packcad` app repo and its plugin packages

You are creating a NEW application repo that consumes the `atelier` engine, replacing the
architecture of an existing app (`packager`) without losing its domain logic.

## Working directory & boundaries

- Repo root: `/Users/ahmadjalil/github/Engine`
- **You may WRITE only inside `/Users/ahmadjalil/github/Engine/packcad/`** (create it).
- **Do NOT modify** `atelier/`, `packager/`, or `seamer/`. All three are READ-ONLY here.
  `packager/` is the source you are porting FROM; it must keep working untouched.

## Read these first

- `atelier/docs/ARCHITECTURE.md` §1 (what belongs in the engine vs the app), §3, §5.
- `atelier/docs/MIGRATION.md` §2 (consumption model — `file:` links + `three` dedupe, risk R3).
- `atelier/docs/AUDIT.md` §2 and finding **F1** and **F2**.
- The engine's real public APIs — read the actual source, not just the docs:
  `atelier/packages/{geometry,core,viewport,io,sim,react}/src/index.ts`

## What `packcad` is

packager's domain: import a flat packaging **dieline** (crease pattern), fold it with a rigid-
origami solver, render the 3D mockup, material/texture it, export SVG + glTF.

The engine now owns: document/commands/undo, 2D geometry, the three.js viewport, and I/O.
The app owns: the fold solvers, the PackCAD/FOLD file format, the material catalog, and the UI.

## Target structure

```
packcad/
  package.json              # pnpm workspace root, private
  pnpm-workspace.yaml
  tsconfig.base.json
  tsconfig.json
  eslint.config.js
  vite.config.ts
  index.html
  .gitignore
  README.md
  packages/
    fold-solver/            # PLUGIN: the rigid-origami solvers
    packcad-format/         # PLUGIN: PackCAD/FOLD import + dieline parsing
  src/                      # the React app
```

Use **pnpm** (not npm/yarn/bun). Engine deps are consumed as workspace-external `file:` links:

```jsonc
"dependencies": {
  "@atelier/core":     "file:../atelier/packages/core",
  "@atelier/geometry": "file:../atelier/packages/geometry",
  "@atelier/viewport": "file:../atelier/packages/viewport",
  "@atelier/io":       "file:../atelier/packages/io",
  "@atelier/react":    "file:../atelier/packages/react"
}
```

**Risk R3 — duplicate `three` instances silently break `instanceof`.** Add
`resolve: { dedupe: ['three'] }` to `vite.config.ts`, and pin `three` to the same version the
engine's viewport targets (0.181.x).

## Plugin 1 — `@packcad/fold-solver`

Port, verbatim where possible, from `packager/src/model/`:
- `foldSolver.ts` (532) — loop-closing solver for live scrubbing
- `foldNewtonSolver.ts` (660) — rigid-origami Newton / Gauss-Newton settled fold
- `foldConstrainedSolver.ts` (609) — development-seeded Gauss-Newton
- `foldTimelineSolver.ts` (112), `foldBranch.ts`, `foldPlaybackConstraints.ts`
- `foldingPlayer.ts` (334) + its test `foldingPlayer.test.ts`
- `foldThickness.ts` + `foldThickness.test.ts`
- `foldStatusWorker.ts` — the off-thread solve-status Web Worker

Expose it through the engine's solver-plugin shape (`SolverPlugin` / `SolverHandle` from
`@atelier/sim`) **if that fits cleanly**. If the fold solver's synchronous scrub-then-settle
model does not fit `SolverHandle`'s async `step()`, do NOT contort it — export a plain API and
say so in your report. The engine serving one solver badly is worse than two honest shapes.

**Constraint substitution:** these solvers currently call `triangulateFace` / `faceDiagonals`
from `packager/src/model/foldGeometry.ts`, which use `cdt2d`. The engine now provides these via
`@atelier/geometry` on `delaunator` (decision D6). Use the engine's. **Then verify the fold
output did not change** — this is migration risk R2, the highest-risk item in the project:
1. Add a golden test that runs the Newton solver over `packager/src/model/fixtures/
   mailerBox.packcad.json` (copy the fixture into the plugin) and snapshots final vertex
   positions.
2. Compare against the same fixture solved by the ORIGINAL `packager` code. You can run the
   original in place with `cd /Users/ahmadjalil/github/Engine/packager && npx vitest run` or by
   writing a scratch script there — **but do not leave any file behind in `packager/`.**
3. If positions differ beyond solver tolerance, **say so loudly in your report** and keep the
   golden snapshot recording the actual new values. Do not paper over it.

## Plugin 2 — `@packcad/format`

Port from `packager/src/model/`:
- `packcadProject.ts` (489) — PackCAD project/operation-pipeline import
- `foldGeometry.ts` (429) — FOLD model construction. **Replace** its local
  `faceVertexLoop`/`orientLoopsConsistently`/`triangulateFace`/`faceDiagonals` with the
  `@atelier/geometry` equivalents; keep the PackCAD-specific parts (keyframes, transforms,
  thickness modifier, UUID↔index mapping).
- `svgFold.ts` (409) — SVG dieline → crease pattern. Use `@atelier/io`'s `fromSVG` for the raw
  path parsing if it fits; keep the crease-assignment logic here.
- `materialCatalog.ts` (105) — the corrugated-flute taxonomy. App data, stays app-side.
- `packaging.ts` (226) — the project model. This becomes the app's `TContent` type for
  `Doc<T>` from `@atelier/core`.

## The app — `packcad/src/`

Port from `packager/src/`, restructured onto the engine:

1. **Document + commands.** `packaging.ts`'s `PackagingProject` becomes the `Doc<T>` content.
   Convert `model/operationPipeline.ts` (10 mutators) and `model/editorMutations.ts` into
   `CommandDef<PackagingProject>[]` registered on a `CommandRegistry`. Their signatures are
   already `(project, args) => project`, so this is mechanical.
   **This gives packager undo for the first time — it currently has none (AUDIT F2). Wire
   Cmd+Z / Cmd+Shift+Z and make sure they work.**
2. **Viewport.** Replace `render/ThreePreview.tsx` + `render/FoldScene.tsx` with the engine's
   `Viewport` via `@atelier/react`'s `ViewportCanvas`. The app builds the folded mesh and
   registers it with `PickService`; camera/lighting/post/picking all come from the engine.
   Keep `render/foldSceneBuilder.ts`'s mesh-building logic (app domain), drop the R3F wrapper.
   **Delete, do not port:** `render/{cameraControls,lightingEnvironment,meshMaterialGraph,
   sceneGeometry,raycastInteraction}.ts` — AUDIT F1 explains why (they are audit scaffolding;
   `raycastInteraction.ts` does not even raycast).
3. **2D view.** packager already renders 2D as the same scene under a flat projection
   (`FoldScene` `projection: 'flat-2d'`). Use the engine's `projection: '2d'` (decision D8).
4. **Export.** `model/exporters.ts` → `@atelier/io` (`toSVG`) and `@atelier/io/three` (`toGLTF`).
   packager also **gains** DXF, HPGL, tiled PDF and PNG for free — expose them in the UI.
5. **UI.** `packager/src/App.tsx` is a 2362-line monolith (AUDIT F5). Split it into focused
   components (toolbar, inspector, operation pipeline panel, material panel, viewport pane).
   Keep the existing look and behaviour; this is a restructure, not a redesign.

## Scope control — read this carefully

This is a large port. **Prioritise a working vertical slice over breadth:**

- **Must work end to end:** load the bundled `mailerBox` sample → fold it → see it in 3D →
  orbit/pick a face → undo/redo an edit → export SVG and glTF.
- Features beyond that slice may be stubbed **only if** each stub is listed in the README's
  "Not yet ported" section with the source file it must come from.
- **Do not leave silent gaps.** A missing feature that is documented is fine; one that looks
  implemented but isn't is not.

## Hard constraints

- **TypeScript strict. Never use `any`.** If genuinely untypable, leave a `// TODO` with the
  reason and report it.
- pnpm only. React 19. Vite. Keep the existing styling approach (plain CSS) — do not introduce
  Tailwind into this app; it is a port, not a redesign.
- No `console.*` noise left in shipped code paths.
- Concise, simple solutions. Prefer the simplest thing that works.
- Preserve source comments that explain *why*.

## Commands to run (from `/Users/ahmadjalil/github/Engine/packcad`)

```
pnpm install
pnpm typecheck
pnpm test
pnpm lint
```

Typecheck, test and lint must pass. **Do not run `pnpm dev` or any dev server. Do not run a
production build.**

## Report format

1. **Structure created** — the tree, with one line per package/dir explaining its role.
2. **R2 result (critical)** — did swapping `cdt2d` → `@atelier/geometry`'s delaunator-based
   triangulation change the fold output? Give the actual numeric comparison. If you could not
   run the original for comparison, say that explicitly rather than assuming it is fine.
3. **Solver plugin shape** — did the fold solver fit `@atelier/sim`'s `SolverPlugin`? If not, why?
4. **Engine API gaps** — anything the app needed that the engine should have provided but
   didn't, or engine APIs that were awkward in real use. This is the most valuable part of your
   report: the engine has only two consumers and this is its first real integration test.
5. **The vertical slice** — confirm each step of it works, or state which failed.
6. **Not yet ported** — the list that goes in the README, with source files.
7. **Command output** for install, typecheck, test, lint (final lines).
