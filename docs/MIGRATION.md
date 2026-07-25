# Atelier — migration plan

How the two existing apps adopt the engine. Companion to [`ARCHITECTURE.md`](ARCHITECTURE.md).

**Governing constraint:** packager and seamer stay shippable at every point. No phase is
allowed to leave either app broken. Each phase is independently revertible.

---

## 1. Ground rules

1. **Extraction, not rewriting.** Code moves with its tests and its comments. seamer's source
   comments explain *why* things are the way they are (embedded-browser modifier quirks,
   composer fallbacks, coalescing windows) — that context is worth more than tidier code.
2. **One behavioural change per phase, at most.** If a phase both moves code and changes
   behaviour, split it.
3. **The old code is deleted in the same PR that adopts the new package.** No parallel
   implementations left "just in case" — that is how the two repos diverged originally.
4. **Every extracted module keeps or gains a test.** seamer has ~20 test files, packager has 3
   (AUDIT F7). Extraction is the moment to close that gap, not later.

---

## 2. Consumption model

Atelier is a **separate repo, consumed as a dependency**. Three stages:

**Stage A — local link (Phases 0–3).** Fast iteration, no publish cycle:

```jsonc
// packager/package.json, seamer/package.json
"dependencies": {
  "@atelier/core":     "file:../atelier/packages/core",
  "@atelier/geometry": "file:../atelier/packages/geometry",
  "@atelier/viewport": "file:../atelier/packages/viewport"
}
```

Both apps sit beside `atelier/` under `~/github/Engine/`, so relative paths work today.
Add a `pnpm dev:link` script that runs `tsc --watch` across the workspace and re-emits `dist/`
on save. Vite picks up the change through the file: link with no extra config.

> **Known cost of Stage A:** duplicate `three` instances if the apps and the engine each
> resolve their own copy — this breaks `instanceof` checks silently and is genuinely
> hard to debug. Mitigation: `three` is a **peerDependency** of `@atelier/viewport`, never a
> dependency, plus a Vite `resolve.dedupe: ['three']` in both apps. Verify with
> `pnpm why three` before Phase 3 ships.

**Stage B — versioned tarballs (Phase 4+).** Once the API stops moving weekly, publish to a
private registry or GitHub Packages and pin real semver. Apps upgrade deliberately.

**Stage C — public (optional).** Only if the engine gets a third consumer. The `@atelier`
npm scope is unclaimed as of writing but should be verified before it matters.

---

## 3. Phases

### Phase 0 — Foundation

*Nothing is extracted. This phase only makes extraction possible.*

**Do:**
- Scaffold the pnpm workspace, `tsconfig.base.json`, shared eslint + vitest config.
- Add the dependency-rule lint (`no-restricted-imports`): `core`/`geometry` cannot import
  `three` or touch DOM globals. Wire it into CI so ARCHITECTURE §3 is enforced, not aspirational.
- **Reconcile three.js** (see §4). Pick one version, upgrade the lagging app, fix fallout,
  ship it in that app's own repo before Atelier depends on it.
- Create empty `packages/*` with `index.ts` exporting nothing, so the graph is real.

**Exit criteria:** both apps build and test green on the reconciled three version. Workspace
`pnpm build && pnpm test` passes on empty packages. CI enforces the import rules.

**Risk:** low. **Touches:** neither app's source, except the three upgrade.

---

### Phase 1 — `@atelier/geometry`

*Purely additive. Nothing in either app changes behaviour.*

**Do:**
- Lift the domain-free ~40% of seamer's `utils/patternGeometry.ts` (1004 LOC): `Vec2`,
  `cubicAt`, `segmentLength`, `resamplePolyline`, `reflectAcrossLine`, `polygonCentroid`,
  `offsetPolygon`, `offsetPolygonVariable`, `pointInPolygon`, `applyCornerJoins`.
  **Leave behind** everything typed against `Pattern`/`Piece`/`PiecePath`.
- Lift `geometry/triangulate.ts` whole → `triangulate()` + `TriMesh` (generalise
  `particleDistanceMm`→`spacing`, `grain`→`grid`).
- Lift `utils/{arcGeometry,arcParametric,hull,thinPlateSpline}.ts` and their existing tests.
- Lift `utils/{nestCore,markerLayout}.ts` → `nest()`.
- Lift packager's face-loop topology from `model/foldGeometry.ts:124-216`
  (`faceVertexLoop`, `faceVertexLoopFromOrientation`, `orientLoopsConsistently`) →
  `buildEdgeTopology` / `orientFacesConsistently`.
- **Resolve D6:** reimplement packager's `triangulateFace` + `faceDiagonals` on `delaunator`.
  See R2 below — this is gated work, not a checkbox.
- Both apps re-export from the package and delete their copies.

**Exit criteria:** seamer's existing geometry tests pass unchanged from inside the package.
packager's fold output is **byte-identical** on all bundled fixtures (see R2). `cdt2d` is
removed from packager's `package.json`.

**Risk:** medium, concentrated entirely in the triangulation swap.
**Touches:** seamer `utils/patternGeometry.ts`, `geometry/*`; packager `model/foldGeometry.ts`.

---

### Phase 2 — `@atelier/core`

*The highest-value phase. packager gains undo (AUDIT F2).*

**Do:**
- Build `Doc<T>`, `Selection`, `CommandRegistry<T>`, `Editor<T>`, `Transaction<T>`,
  `History<T>`, `installAutomationApi` per ARCHITECTURE §4.2.
- Port seamer's `stores/localDB.ts` history functions → `IndexedDbHistoryPersistence`;
  port `persisted<T>()` → `@atelier/core/persist`, keeping the SSR guards.
- **seamer:** re-type its ~75 command defs against `CommandDef<Pattern>` — mechanical, the
  reducer shape already matches. Replace `stores/pattern.ts`'s undo/redo internals with
  `History<Pattern>`; replace the five parallel `Set<string>` selection stores with one
  `Selection`. `window.seamer` keeps its exact shape via `installAutomationApi(editor, 'seamer')`.
- **packager:** convert `model/operationPipeline.ts` (10 mutators) and `model/editorMutations.ts`
  into `CommandDef<PackagingContent>[]`. Wire `Editor` into `App.tsx`. **Ship Cmd+Z.**

**Exit criteria:** seamer's `commands.test.ts` and `create.test.ts` pass against the new bus.
Undo/redo/coalescing behaviour is unchanged in seamer (verified by the Playwright e2e suite).
packager has working labeled undo/redo with history persistence.

**Risk:** medium for seamer (touches the store layer every component reads), low for packager
(purely additive).
**Touches:** seamer `commands/*`, `stores/pattern.ts`, `stores/localDB.ts`, and every component
that imports a selection store; packager `App.tsx`, `model/{operationPipeline,editorMutations}.ts`.

> **Sequencing note.** The seamer selection-store change ripples through ~30 components.
> Consider splitting: **2a** = command bus + history (isolated), **2b** = selection unification
> (broad). If 2b looks expensive when you get there, defer it — `Editor` can hold a `Selection`
> while seamer's components keep reading their old stores through a shim.

---

### Phase 3 — `@atelier/viewport`

*The biggest single phase. Decompose seamer's 2556-line `PatternRenderer` (D7).*

**Do, in this order:**
1. `ResourceScope`, `docToWorld`/`worldToDoc`, `Viewport` shell with on-demand rAF.
2. `CameraRig` — merge seamer's `setCameraView`/`setCameraFov`/`zoomTo` with packager's
   `InteractiveCameraControls` (`ThreePreview.tsx:86-264`). **Carry the embedded-browser
   modifier+left-drag pan workaround verbatim** (`ThreePreview.tsx:169`); it exists because of
   a real bug and its comment explains why.
3. `LightingRig` — seamer's HDRI/PMREM path + `envCache`, plus packager's `RoomEnvironment`
   preset. Delete packager's `lightingEnvironment.ts` descriptor (AUDIT F1).
4. `PostFX` — seamer's composer chain with its guarded-fallback behaviour intact.
5. `PickService` — **new code**, replacing packager's fake `raycastInteraction.ts` and
   seamer's inline picking. Include the `lineThreshold: 0.03` crease-vs-face behaviour
   (`ThreePreview.tsx:584`).
6. `OverlayLayer` + `GizmoService` — from seamer's LineSegments2 overlays and `TransformControls`.
7. `createSurfaceMaterial` — from seamer's `scene/materials.ts` (the generic PBR part;
   the label-badge shader injection stays seamer-side for now).
8. **seamer:** `PatternRenderer` becomes a thin app-level orchestrator over the subsystems.
9. **packager:** `ThreePreview`/`FoldScene` port off R3F onto `Viewport`. Delete
   `render/{cameraControls,lightingEnvironment,meshMaterialGraph,sceneGeometry,raycastInteraction}.ts`.

**Exit criteria:** seamer's 3D pane is visually unchanged (compare `captureImage()` output
against pre-migration references). packager's fold view is visually unchanged and its
`data-*` diagnostic attributes — which `DielinePreview`/`FoldScene` write for external audits
(`FoldScene.tsx:417-420`) — still resolve, or are consciously retired.

**Risk:** **high.** Largest surface, hardest to test, most likely to produce subtle visual
regressions.
**Mitigation:** land subsystems one at a time behind the old code path; each of steps 1–7 is
its own PR with a screenshot diff. Do not do 8 and 9 until 1–7 are all merged and used.

---

### Phase 4 — `@atelier/io`

*Low risk, high mutual benefit. Both apps gain formats they don't have.*

**Do:**
- Define the neutral `Drawing` intermediate. Each app writes one flattener
  (`Pattern → Drawing`, `PackagingProject → Drawing`).
- Lift seamer's `utils/{exporters,pdf,hpgl,cutfile}.ts` and its importers
  (`patternImport`, `cutImport`, `rulImport`, `seamlyImport`) onto `Drawing`.
- Lift packager's `createExportDielineSvg` / `createModelGltf` (`model/exporters.ts`).
- `@atelier/io/three` for glTF/OBJ/STL (three-dependent entry point, ARCHITECTURE §4.4).

**What each app gains:** packager gets DXF, HPGL, tiled PDF, PNG, cut files. seamer gets glTF.

**Exit criteria:** seamer's `export-formats.test.ts` and `cutfile.test.ts` pass from inside the
package; both apps' export menus produce byte-identical output to pre-migration for every
format they already had.

**Risk:** low. Pure functions, existing tests, easily diffable output.

---

### Phase 5 — `@atelier/sim` *(optional)*

Only worth doing if a third consumer appears or packager's fold solver moves to GPU. The
value is `requestDevice`/`isWebGPUAvailable`/`SolverRunner` — maybe 200 LOC of genuinely
shared code. The WGSL and the fold solvers stay app-side regardless.

**Recommendation:** defer. Revisit after Phase 4 ships.

---

### Phase 6 — Unified 2D viewport *(optional, expensive)*

Port seamer's 3310-line `PatternCanvas2D.svelte` onto the engine's `projection: '2d'` (D8),
as packager already does.

**Honest assessment:** this is the largest single body of work in the entire plan and the
payoff is architectural consistency, not new capability. seamer's Canvas2D works and is
feature-rich (silhouettes, warped background images, HPGL overlays, frozen snapshots, notch
rendering, seam arrows). There is a real argument it should stay Canvas2D forever — a 2D
drafting canvas is a legitimate use for `CanvasRenderingContext2D`, and WebGL buys little at
that scale.

**Recommendation:** do not commit to this. Re-evaluate only if seamer needs 2D features that
Canvas2D makes hard (e.g. very large patterns where GPU rendering wins).

---

## 4. three.js reconciliation

packager is on **0.181.2**, seamer on **0.170.0** — 11 minor versions (AUDIT F3). Shared
viewport code cannot exist until this is resolved.

**Recommendation: upgrade seamer to 0.181.x**, in seamer's own repo, during Phase 0.

*Rationale.* Moving forward is normal maintenance; pinning packager back to 0.170 means
carrying a knowingly stale dependency in a new project from day one.

*Expected fallout, in likely order of pain:*

| Area | Why it's at risk |
|---|---|
| `EffectComposer` chain (`N8AOPass`, `BokehPass`, `SMAAPass`, `OutputPass`) | Post-processing addons track core closely; `n8ao` 1.10 must be checked against 0.181 |
| Color management / tone mapping | Defaults have shifted repeatedly; expect visual diffs in the garment/skin PBR |
| `LineMaterial` / `LineSegments2` | Moved and changed signature across this range |
| `TransformControls` | API changed (notably `.getHelper()` in recent versions) |
| WebGPU types | seamer pins `@webgpu/types` 0.1.70 independently; check for conflict |

*Also fix in Phase 0:* packager's `@types/three` (0.184) is ahead of its runtime (0.181).
Pin them together.

*Contingency.* If the seamer upgrade turns out to be a multi-week project, pin **both** to
0.170 for Phases 0–2 (which are three-free anyway — D2) and do the upgrade as a prerequisite
to Phase 3 only. This is a legitimate fallback, not a failure.

---

## 5. Risks

**R1 — The engine becomes a dumping ground.**
Two consumers is the minimum viable number for finding the right abstraction, and it is easy
to promote something that is really app-specific.
*Mitigation:* the "may not import" table (ARCHITECTURE §3) is CI-enforced. Rule of thumb:
if a signature mentions a domain noun (piece, panel, seam, crease, avatar), it does not belong
in a package.

**R2 — `cdt2d` → `delaunator` changes packager's fold output. [highest risk]**
`faceDiagonals()` feeds the isometry bars that keep facets rigid in the Newton solver. A
different triangulation gives a different constraint set, which can change the converged fold —
subtly, and possibly only on some inputs.
*Mitigation, do this before writing any replacement:*
1. Add a golden-output test to packager **now**, on `cdt2d`, over every bundled fixture
   (`model/fixtures/mailerBox.packcad.json` and the PackCAD samples): serialize final vertex
   positions from `foldNewtonSolver` to a snapshot.
2. Swap the library. Require the snapshots to match within solver tolerance.
3. If they don't: keep `cdt2d` in `@atelier/geometry` as a second `triangulateFaceCDT` entry
   point. Two triangulators is a worse outcome than one but a much better one than a silently
   wrong fold. **Take this exit early rather than fighting it.**

**R3 — Duplicate `three` instances under `file:` links.**
Breaks `instanceof` in ways that produce confusing, non-local failures.
*Mitigation:* `three` as peerDependency everywhere in Atelier + `resolve.dedupe: ['three']`
in both apps. Add a CI assertion that `pnpm why three` reports exactly one version.

**R4 — seamer's selection refactor ripples through ~30 components.**
*Mitigation:* the 2a/2b split described in Phase 2, with a shim as the escape hatch.

**R5 — Visual regressions in Phase 3 that nobody notices for weeks.**
*Mitigation:* capture reference images from both apps *before* Phase 3 starts, via
`captureImage()` / `preserveDrawingBuffer`. Add them to CI as a perceptual diff. Do this in
Phase 0 while it's cheap.

**R6 — Two consumers is a thin basis for a general engine.**
Genuinely true, and worth accepting consciously. The reuse-in-future-projects goal is real but
unvalidated until a third app exists.
*Mitigation:* `examples/minimal/` — the smallest app that uses `Doc` + two commands + a
viewport, built during Phase 2 and kept working. If a change makes `minimal` awkward, the
abstraction is wrong. It is the cheapest available proxy for a third consumer.

---

## 6. Testing

| Level | Where | What |
|---|---|---|
| Unit | every package, colocated | Node, no DOM. `core` and `geometry` must run headless (D2). |
| Golden output | `geometry`, `io` | Snapshot fold vertices (R2) and every export format byte-for-byte. |
| Visual | apps | Reference images captured in Phase 0, diffed in CI from Phase 3 (R5). |
| E2E | seamer | Keep the existing Playwright suite green through every phase. It is the strongest signal available for Phase 2 and 3 regressions. |
| Contract | `examples/minimal` | Must build and run after every phase (R6). |

**Coverage floor:** no module is extracted without at least the tests it already had. Where
packager code moves into a package, it gains tests it never had (AUDIT F7) — that is a
deliverable of the phase, not a follow-up.

---

## 7. Sequence summary

| Phase | Deliverable | Risk | Apps stay shippable |
|---|---|---|---|
| 0 | workspace, lint rules, three reconciliation, reference images | low | yes |
| 1 | `@atelier/geometry` | medium (R2) | yes |
| 2 | `@atelier/core` — **packager gains undo** | medium | yes |
| 3 | `@atelier/viewport` | **high** | yes, if landed subsystem-by-subsystem |
| 4 | `@atelier/io` — both apps gain formats | low | yes |
| 5 | `@atelier/sim` | low | defer; revisit after 4 |
| 6 | unified 2D viewport | high | not recommended |

Phases 0–2 deliver most of the value at moderate risk and are worth committing to now.
Phase 3 is where the plan should be re-evaluated with real code in hand. Phases 5 and 6 are
options, not commitments.
