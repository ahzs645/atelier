# Source audit

What is actually in the two repos, as of the review. Everything here is grounded in the
source; file:line references are to the repos as they stood at `packager@e3a8d80` and
`seamer@523a6f3`.

## 1. Shape of each app

| | **packager** (`packcad-mockup`) | **seamer** |
|---|---|---|
| Framework | React 19 + `@react-three/fiber` 9 | SvelteKit 2 / Svelte 5 |
| three.js | **0.181.2** (`@types/three` 0.184) | **0.170.0** (`@types/three` 0.170) |
| Build | Vite 8, `tsc -b` | Vite 5, `svelte-check` |
| Tests | Vitest — **3 test files** | Vitest (~20 files) + Playwright e2e |
| Source size | ~11.5k LOC TS/TSX | ~33.6k LOC TS + ~9.2k LOC `.svelte` |
| Commits | 48 | 38 |
| Domain | flat dieline → rigid-origami fold → 3D box | 2D parametric pattern → arrange on avatar → XPBD cloth drape |
| Extra deps | `cdt2d`, `lucide-react` | `delaunator`, `n8ao`, `better-auth`, `@webgpu/types`, tailwind/daisyui |

Both are clean-room rebuilds of a prior compiled application, which explains several
structural quirks noted below.

## 2. Layer-by-layer comparison

### 2.1 Document model

- **packager** — `src/model/packaging.ts` (226 LOC). A flat `PackagingProject` record:
  material id, thickness, artwork placement, view/render mode, camera preset, selected panel,
  folding steps, dieline source. Panels are a **fixed enum** of six ids
  (`center`, `left-flap`, `right-flap`, `top-flap`, `bottom-flap`, `artwork`).
  The real geometry lives in a separately-derived `FoldModel` (`model/foldGeometry.ts`).
- **seamer** — `src/lib/types/pattern.ts` (647 LOC). A rich, genuinely parametric model:
  ~45 exported interfaces — `ConstrainablePoint`, `ConstrainablePath` (with bézier handles,
  sliding points, arcs), `Piece`, `Seam`, `Material`/`TextureSlot`, `Layer`, `Body`,
  `GradingProfile`, `AlterationTrack`, `PatternImage`, `PatternText`.

**Read:** seamer's model is a superset in structure and the only one of the two that
generalises. packager's is a config record, not a document.

### 2.2 Command bus, undo, history

- **packager** — **none.** `grep -ri undo src/` returns **0 hits**. Edits are ad-hoc pure
  functions in `model/editorMutations.ts` (210 LOC) and `model/operationPipeline.ts`
  (220 LOC), each `(project, args) => project`. No history, no labels, no transactions.
- **seamer** — a real command layer:
  - `commands/types.ts` — `CommandDef { type, category, summary, inputs, example, mutating,
    label, run(pattern, params, ctx) }`. Every command is a pure reducer.
  - `commands/registry.ts` (527 LOC) — ~75 registered commands across 13 categories
    (`point`, `path`, `piece`, `piecePath`, `seam`, `notch`, `layer`, `material`, `variable`,
    `text`, `element`, `selection`, `pattern`).
  - `commands/execute.ts` — dispatcher, `PatternTransaction` (batch → one undo entry),
    `dryRun`/`preview`, `commandSchema()` for docs/agents, and `installCommandApi()` exposing
    a `window.seamer` automation surface.
  - `stores/pattern.ts` — labeled undo/redo, `HISTORY_LIMIT = 100`, **gesture coalescing**
    (`COALESCE_MS = 800`, so a drag is one undo entry), and IndexedDB persistence of the last
    30 entries per stack, debounced 800 ms.

**Read:** this is the single highest-value asset in either repo, and it is entirely
`Pattern`-typed. Generalising `Pattern` → `Doc<T>` is the main design work of `@atelier/core`.

### 2.3 Geometry kernel

Both hand-roll 2D geometry; **they use different triangulation libraries.**

- **packager** — `cdt2d`. `model/foldGeometry.ts:225 triangulateFace(loop, coords)` does
  constrained Delaunay per face with all boundary segments as constraints, plus
  `faceDiagonals()` (the isometry bars the fold solver needs). Also FOLD-format adjacency:
  `faceVertexLoop`, `faceVertexLoopFromOrientation`, `orientLoopsConsistently`.
- **seamer** — `delaunator`. `geometry/triangulate.ts` (199 LOC): boundary + hole + internal
  constraint points, plus a **grain-aligned Steiner grid** with a spatial-hash clearance test,
  centroid-filtered to the polygon-with-holes, degenerate-pruned, then compacted with
  index remapping back to the input boundary order.

Generic 2D helpers are buried in **`utils/patternGeometry.ts` (1004 LOC)**, which mixes two
concerns: pure geometry (`Vec2`, `cubicAt`, `segmentLength`, `resamplePolyline`,
`reflectAcrossLine`, `polygonCentroid`, `offsetPolygon`, `offsetPolygonVariable`,
`pointInPolygon`, `applyCornerJoins`) and `Pattern`-typed resolution (`pathPolyline`,
`pieceOutline`, `pieceTransform`, `seamGeometry`, `placedPoints`, …).

**Read:** ~40% of `patternGeometry.ts` is framework- and domain-free and lifts directly.
The rest stays app-side. The `cdt2d`/`delaunator` split must be resolved (see ARCHITECTURE D6).

### 2.4 3D viewport

- **packager** — declarative R3F. `render/ThreePreview.tsx` (651 LOC) owns `<Canvas>`, lights,
  camera, and a legacy `<Mockup>` stand-in; `render/FoldScene.tsx` (593) + `foldSceneBuilder.ts`
  (611) build the real mesh. Notable: `SceneEnvironment` uses `PMREMGenerator` +
  `RoomEnvironment` for IBL (`ThreePreview.tsx:275`); `InteractiveCameraControls`
  (`ThreePreview.tsx:86-264`) is ~180 lines of hand-written orbit/pan wiring around
  `OrbitControls`, including a **custom modifier+left-drag pan path** that bypasses
  OrbitControls entirely because "some embedded browser paths report the modifier on keydown
  but omit it from pointerdown" (`ThreePreview.tsx:169`).
- **seamer** — imperative. `scene/scene3d.ts` is a **2556-line `PatternRenderer` class**
  holding renderer, camera, `OrbitControls`, `TransformControls`, cloth meshes, avatar,
  sim loop, seam overlays, measurement overlays, labels, snapshot ghosting, and an
  `EffectComposer` chain (`N8AOPass` → `BokehPass` → `SMAAPass` → `OutputPass`) with a
  documented fallback if composer construction fails. HDRI env via `RGBELoader` + PMREM
  with an `envCache`. ~50 public methods (`setLightingMode`, `setCameraView`, `enterArrangeMode`,
  `setSeamToolState`, `freezeSnapshot`, `exportOBJ`, `captureImage`, `dispose`, …).

**Read:** seamer's is strictly more capable and already imperative — it is the better
starting point for `@atelier/viewport`, but it is one class doing ~10 jobs and must be
decomposed before it can be reused.

### 2.5 2D viewport

The two are **architecturally different**, and this is the biggest divergence in the codebase.

- **packager** — the 2D view is *also three.js*. `render/DielinePreview.tsx` (412 LOC) mounts
  an R3F `<Canvas>` locked top-down orthographic with pan/zoom only, and renders the same
  `<FoldScene>` with `projection: "flat-2d"` instead of `"folded-3d"`
  (`FoldScene.tsx:50,161,315`). **One scene graph, two projections.**
- **seamer** — `components/PatternCanvas2D.svelte` is **3310 lines**, a hand-rolled
  `CanvasRenderingContext2D` renderer: its own `toCanvas`/`toPattern` transforms, `render()`
  at line 716 spanning ~520 lines, hit-testing (`hitTestPlaced`, `hitTestPoint`,
  `hitTestHandle`), plus drawing for silhouettes, warped background images, HPGL overlays,
  frozen snapshots, notches, seam arrows, name chips, and a compass.

**Read:** packager's one-scene-two-projections pattern is the right one and should be the
engine's model. Porting seamer's Canvas2D to it is the single largest migration cost in the
project and is explicitly **out of scope for the initial extraction** (see MIGRATION Phase 6).

### 2.6 I/O

- **packager** — `model/exporters.ts` (615 LOC): `createExportDielineSvg`, `createModelGltf`,
  `buildPanelGeometry`. Import: `model/svgFold.ts` (SVG → crease pattern),
  `model/packcadProject.ts` (489 LOC, PackCAD project import).
- **seamer** — far richer. `utils/exporters.ts` (456) + dedicated modules:
  SVG (two variants), **DXF**, **PDF with tiled printing** (`utils/pdf.ts`, `TILE_OVERLAP_MM = 6`),
  **HPGL** (read *and* write, `utils/hpgl.ts`), PNG, CSV, `.ssp` bundles, cut files for named
  machines (`utils/cutfile.ts`), plus importers for Seamly, RUL, DXF and "simple pattern"
  formats, and body export to JSON/CSV/OBJ/STL.

**Read:** the two overlap only on SVG. Everything else is additive in one direction or the
other — a genuine, low-risk shared win.

### 2.7 Solvers (not shared)

- **packager** — four fold solvers, ~1900 LOC total: `foldSolver.ts` (532, loop-closing, live
  scrubbing), `foldNewtonSolver.ts` (660, rigid-origami Newton/Gauss-Newton, settled fold),
  `foldConstrainedSolver.ts` (609), `foldTimelineSolver.ts` (112), plus `foldingPlayer.ts`
  and a `foldStatusWorker.ts` Web Worker.
- **seamer** — XPBD cloth on WebGPU: `sim/webgpu/shaders.ts` (1148 LOC of WGSL),
  `sim/webgpu/engine.ts` (745), `sim/build.ts` (584), `sim/simulator.ts` (241).
  `subSteps = 40`, graph-colored stretch constraints, bend, seams, body collision with
  Coulomb friction, optional GPU self-collision.
- **seamer only** — the parametric avatar: `model/{assets,avatar,skinnedAvatar,avatarController,
  measurements,measurementDefs,matrix}.ts`, a 12,302-vertex morphable mesh from 17 shape
  coefficients + a 52-bone mixamo skeleton with CPU linear-blend skinning.

**Read:** no meaningful overlap. These stay in the apps as solver plugins.

## 3. Findings that change the design

**F1 — packager's `render/*.ts` "contract" files are audit scaffolding, not an engine layer.**
`cameraControls.ts`, `lightingEnvironment.ts`, `meshMaterialGraph.ts`, `sceneGeometry.ts` and
`raycastInteraction.ts` all export a `*ContractVersion` constant and build plain JSON
descriptors with `serialize*()` helpers and `disposalOrder` arrays. They are parity-audit
artifacts from the clean-room rebuild. The descriptors are only *partially* consumed — e.g.
`ThreePreview.tsx:549` calls `createCameraControlsReport()` purely to read a position, then
ignores the rest and configures `OrbitControls` by hand.

Worst case: **`raycastInteraction.ts` does not raycast.** It hit-tests six hardcoded
normalised rectangles (`raycastInteraction.ts:31-38`) with a priority sort. `DielinePreview.tsx`
imports only `raycastInteractionContractVersion` and `raycastPanelBounds` from it.

*Consequence:* do not carry this pattern into Atelier. The real interaction logic to extract
lives inline in `ThreePreview.tsx:86-264` and in seamer's `PatternRenderer`.

**F2 — packager has no undo.** Confirmed by grep. Any user edit is unrecoverable. Adopting
`@atelier/core` fixes this as a side effect rather than as a feature project.

**F3 — three.js is 11 minor versions apart** (0.170 vs 0.181), and `@types/three` is skewed
against the runtime in packager (types 0.184 vs runtime 0.181). One version must be chosen
before any shared viewport code exists.

**F4 — unit conventions differ.** seamer is strict: **mm** in the document, **meters** in the
scene, converted at exactly one boundary (`geometry/arrangement.ts:45`, `cylinders.ts:153` —
literal `/1000`). packager works in FOLD/design units (`FoldModel.coordinateUnit`) against a
semi-normalised scene with magic scalars (`ThreePreview.tsx:427`:
`const thickness = Math.max(0.035, thicknessMm / 42)`).

**F5 — packager's UI is a 2362-line `App.tsx`**, 20% of the repo in one file. seamer's UI is
distributed across 33 components but includes two more monoliths (`PatternCanvas2D.svelte`
3310, `PropertyPanel.svelte` 1492).

**F6 — seamer contains app-level concerns that must not enter the engine:** SvelteKit server
routes (`routes/api/**`), `better-auth`, an MCP session store and sync API, product analytics,
release notes, review prompts, and pricing/marketing pages.

**F7 — test coverage is lopsided.** packager has 3 test files (`foldThickness`, `foldingPlayer`,
`foldSceneBuilder`); seamer has ~20 plus Playwright e2e. Extracted packages must carry seamer's
tests with them or coverage silently drops.
