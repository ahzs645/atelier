# Task: implement `@atelier/geometry`

You are implementing the first real package of a new engine, `atelier`, which extracts shared
CAD-editor infrastructure out of two existing apps.

## Working directory & boundaries

- Repo root for this task: `/Users/ahmadjalil/github/Engine`
- **You may WRITE only inside `atelier/packages/geometry/`.**
- **Do NOT modify** any file in `atelier/` outside that directory (the root `package.json`,
  `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`, `docs/` are already correct — leave them).
- **Do NOT modify** `packager/` or `seamer/` at all. They are READ-ONLY reference sources.

## Read these first

- `atelier/docs/ARCHITECTURE.md` — especially §4.1 (the exact public API you must implement),
  §2 decisions D2 and D6, and §5.1 (coordinate spaces).
- `atelier/docs/AUDIT.md` §2.3 — what exists in the two source repos.
- `atelier/docs/MIGRATION.md` Phase 1 and risk R2.

## What to build

Implement `atelier/packages/geometry/src/` to match **ARCHITECTURE.md §4.1** exactly. That
section is the contract: same names, same signatures. If you must deviate, say so in your report
with the reason.

Port — do not rewrite from scratch — from these sources:

**From `seamer/src/lib/`:**
- `utils/patternGeometry.ts` (1004 LOC) — take ONLY the domain-free parts:
  `Vec2`, `Transform`, `CubicSegment`, `cubicAt`, `segmentLength`, `resamplePolyline`,
  `reflectAcrossLine`, `polygonCentroid`, `offsetPolygon`, `offsetPolygonVariable`,
  `pointInPolygon`, `applyCornerJoins`/`CornerJoin`.
  **LEAVE BEHIND** everything typed against `Pattern`, `Piece`, `PiecePath`, `Seam`, `Path`
  (e.g. `pathPolyline`, `pieceOutline`, `pieceTransform`, `seamGeometry`, `placedPoints`,
  `indexPoints`). Those stay in the app.
- `geometry/triangulate.ts` (199 LOC) — port whole. Rename per §4.1:
  `particleDistanceMm` → `spacing`, `grain` → `grid`, `ClothMesh` → `TriMesh`.
  `spacing` undefined or 0 must mean "no Steiner grid, boundary/constraints only".
- `utils/arcGeometry.ts`, `utils/arcParametric.ts` — arcs (`arcToPolyline`, `threePointArc`).
- `utils/hull.ts` — `convexHull`.
- `utils/nestCore.ts`, `utils/markerLayout.ts` — the generic packing core behind `nest()`.
  If `markerLayout.ts` is too coupled to pattern types, port only `nestCore.ts` and say so.
- `utils/thinPlateSpline.ts` — port as-is (it is already generic).

**From `packager/src/model/foldGeometry.ts`:**
- `faceVertexLoop` (line ~124), `faceVertexLoopFromOrientation` (~164),
  `loopEdgeDirection` (~176), `orientLoopsConsistently` (~192) →
  `faceVertexLoop` / `buildEdgeTopology` / `orientFacesConsistently` per §4.1.
- `triangulateFace` (~225) and `faceDiagonals` (~246). **These currently use `cdt2d`.**
  See "Decision D6" below.

**Bring the existing tests with the code.** `seamer/src/lib/utils/arcParametric.test.ts`,
`thinPlateSpline.test.ts`, `nestCore.test.ts` and any other test covering ported code must be
adapted and pass inside the package. Add tests for anything ported that had none.

## Decision D6 — the risky bit, read carefully

packager uses `cdt2d`; seamer uses `delaunator`. The engine standardises on **`delaunator`**
(already a dependency of this package). You must reimplement packager's constrained
face triangulation on delaunator.

packager's case is the easy one: a **single face loop, no holes, no interior points**.
`triangulateFace(loop, coords)` returns triangles in ORIGINAL global vertex indices.
`faceDiagonals(loop, coords)` returns the non-boundary edges of that triangulation — these are
the **isometry bars** that keep facets rigid in the fold solver, so getting this wrong silently
changes fold output.

Expose both through the §4.1 API (`triangulate` for the general case, `meshDiagonals` for the
diagonals). Also export a convenience `triangulateFace(loop, coords)` that preserves packager's
exact signature and index semantics, so the app migration is mechanical.

**If you cannot make delaunator reproduce correct constrained triangulations for non-convex
face loops** — delaunator is unconstrained Delaunay, so a non-convex polygon needs
centroid-in-polygon filtering, which is what seamer's `triangulate.ts` already does — then say
so explicitly in your report rather than shipping something subtly wrong. A documented fallback
(keeping a second CDT path) is an acceptable outcome; a silently wrong triangulation is not.

Write a test that triangulates several **non-convex** polygons (an L-shape, a U-shape, a
polygon with a deep notch, a polygon with a hole) and asserts:
- every returned triangle's centroid is inside the polygon and outside all holes,
- the union of triangle areas equals the polygon area within 1e-6 relative,
- no duplicate or degenerate triangles,
- boundary index mapping round-trips.

## Hard constraints

- **TypeScript strict. Never use `any`.** Use `unknown` + narrowing, or a real type. The lint
  config has `@typescript-eslint/no-explicit-any: error` and it will fail the build.
- **No `three` import, no DOM API, no framework import.** This package must run headless in
  Node. Lint enforces this (decision D2).
- Use `import type` for type-only imports (`consistent-type-imports` is an error).
- `verbatimModuleSyntax` is on — all relative imports need explicit `.js` extensions? No:
  `moduleResolution: bundler` is set, so extensionless relative imports are fine. Match whatever
  makes `pnpm typecheck` pass.
- Keep the source comments that explain *why* (tolerances, epsilon choices, workarounds). They
  are more valuable than tidier code.
- Concise, simple solutions. Do not over-engineer. No speculative abstraction.
- `src/index.ts` is the ONLY public surface — re-export everything from there.
- Organise into focused modules (e.g. `vec2.ts`, `curves.ts`, `polygon.ts`, `triangulate.ts`,
  `topology.ts`, `nest.ts`), not one giant file.

## Commands to run (from `/Users/ahmadjalil/github/Engine/atelier`)

```
pnpm --filter @atelier/geometry exec tsc -b --pretty
pnpm exec vitest run packages/geometry
pnpm exec eslint packages/geometry
```

All three must pass before you finish. Do **not** run dev servers. Do not run a bundler build.

## Report format

End with a report containing:
1. **Files created**, one line each with its purpose.
2. **API deviations** from ARCHITECTURE.md §4.1, with justification. "None" if none.
3. **D6 outcome** — did delaunator reproduce constrained triangulation correctly? What did the
   non-convex tests show? Did you need a fallback?
4. **Tests**: how many, what they cover, and the final pass/fail counts.
5. **Anything you had to leave behind** and why (e.g. a util too coupled to `Pattern` to port).
6. **Command output** for typecheck, test, and lint (final lines).
