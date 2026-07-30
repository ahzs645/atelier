# Atelier — migration plan

Historical adoption plan and current outcome. Companion to
[`ARCHITECTURE.md`](ARCHITECTURE.md).

## Status / what actually happened — 2026-07-30

This was **not** carried out as an in-place migration of `packager` and `seamer`.
Those applications were forked into **PackCAD** (`packcad`) and **Seamer Studio**
(`seamer-studio`), and the forks were built on Atelier from the start. They consume the
implemented packages through `link:` dependencies.

The original `packager` and `seamer` repositories remain untouched, with zero `@atelier/*`
imports. They are deliberately kept read-only as parity and reference oracles; they are
**not archived**. References below use `packcad`/`seamer-studio` for the current consumers and
`packager`/`seamer` only when describing source provenance or legacy behavior.

Phases 0–5 are effectively complete. Phase 6 remains optional and has not been undertaken:
Seamer Studio still owns its Canvas2D drafting surface.

| Phase | Status on 2026-07-30 |
|---|---|
| 0 — foundation | Complete: workspace, checks, CI, package boundaries, and three.js alignment |
| 1 — geometry | Complete and consumed by both forks |
| 2 — core | Complete and consumed by both forks |
| 3 — viewport | Complete and consumed by both forks |
| 4 — I/O | Complete and consumed by both forks |
| 5 — simulation host | Complete; consumed by Seamer Studio |
| 6 — unified 2D viewport | Not started; optional |

---

## 1. Ground rules

1. **Forks are the adoption boundary.** Changes land in `packcad`, `seamer-studio`, or
   `atelier`; the legacy repositories stay read-only.
2. **Preserve behavior deliberately.** Legacy source, fixtures, and screenshots remain the
   reference when judging parity in the forks.
3. **One behavioral change per step, at most.** Extraction and behavior changes should remain
   independently reviewable.
4. **Every shared module keeps or gains a test.** The package suites and
   `examples/minimal` contract test are part of the repository gates.

---

## 2. Consumption model

Atelier is a **separate repo, consumed as a dependency**. Three stages:

**Stage A — local link (current).** Fast iteration, no publish cycle.

> **Use `link:`, NOT `file:`.** This was wrong in the original plan and cost real debugging
> time. pnpm resolves `file:` by copying the package into its store at install time, so engine
> edits are invisible to the consuming app until the next `pnpm install` — an app can run a
> stale snapshot of the engine while its typecheck and tests all pass. `link:` creates a direct
> symlink to the source directory, which is what "fast iteration" actually requires.
>
> Symptom: a fix that demonstrably works in the engine tests appears to have no effect in the
> app. Check with `ls -la <app>/node_modules/@atelier/<pkg>` — it must point at
> `../../../atelier/packages/<pkg>`, not into `.pnpm/`.

```jsonc
// packcad/package.json, seamer-studio/package.json
"dependencies": {
  "@atelier/core":     "link:../atelier/packages/core",
  "@atelier/geometry": "link:../atelier/packages/geometry",
  "@atelier/viewport": "link:../atelier/packages/viewport"
}
```

Both current apps sit beside `atelier/` under `~/github/Engine/`, so relative paths work
today. Seamer Studio also provides `pnpm dev:link` for workspace typechecking in watch mode.

> **Known cost of Stage A:** duplicate `three` instances if the apps and the engine each
> resolve their own copy — this breaks `instanceof` checks silently and is genuinely
> hard to debug. Mitigation: `three` is a **peerDependency** of `@atelier/viewport`, never a
> dependency, plus a Vite `resolve.dedupe: ['three']` in both apps. Atelier's lint gate also
> asserts one three.js version in its lockfile.

**Stage B — versioned packages (not started).** When local sibling links are no longer the
right deployment model, publish to a registry and pin real semver so apps upgrade deliberately.

**Stage C — public (optional).** Only if the engine gets a third consumer. The `@atelier`
npm scope is unclaimed as of writing but should be verified before it matters.

---

## 3. Phases

### Phase 0 — Foundation *(effectively complete)*

*Nothing is extracted. This phase only makes extraction possible.*

**Do:**
- Scaffold the pnpm workspace, `tsconfig.base.json`, shared eslint + vitest config.
- Add the dependency-rule lint (`no-restricted-imports`): `core`/`geometry` cannot import
  `three` or touch DOM globals. Wire it into CI so ARCHITECTURE §3 is enforced, not aspirational.
- **Reconcile three.js** (see §4). Pick one version, upgrade the lagging app, fix fallout,
  ship it in that app's own repo before Atelier depends on it.
- Create empty `packages/*` with `index.ts` exporting nothing, so the graph is real.

**Outcome:** the workspace contains all seven packages, CI runs `pnpm typecheck`,
`pnpm test`, and `pnpm lint`, and the lint gate enforces package boundaries plus a single
three.js lockfile version. PackCAD and Seamer Studio both use three.js 0.181.2.

**Risk:** low. **Touches:** neither app's source, except the three upgrade.

---

### Phase 1 — `@atelier/geometry` *(effectively complete)*

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
- Both forks consume the package; app-specific adapters remain app-owned.

**Outcome:** Atelier's geometry tests pass, both forks consume the package, and PackCAD guards
the triangulation difference and fold result in
`packages/fold-solver/src/{triangulationParity,r2FoldOutcome}.test.ts`. The triangulators are
not byte-identical on two near-cocircular faces, but the converged fold is unchanged within
tolerance (see R2). `cdt2d` remains a PackCAD dev dependency solely for that parity test.

**Risk:** medium, concentrated entirely in the triangulation swap.
**Current paths:** `seamer-studio/packages/pattern-model/src/utils/patternGeometry.ts` and
`seamer-studio/packages/cloth-sim/src/geometry/`; PackCAD consumes face topology and
triangulation from `packages/packcad-format/src/foldGeometry.ts` and `packages/fold-solver/src/`.

---

### Phase 2 — `@atelier/core` *(effectively complete)*

*The highest-value phase. PackCAD gains undo (AUDIT F2).*

**Do:**
- Build `Doc<T>`, `Selection`, `CommandRegistry<T>`, `Editor<T>`, `Transaction<T>`,
  `History<T>`, `installAutomationApi` per ARCHITECTURE §4.2.
- Port seamer's `stores/localDB.ts` history functions → `IndexedDbHistoryPersistence`;
  port `persisted<T>()` into the `@atelier/core` public surface, keeping the SSR guards.
- **Seamer Studio:** re-type its command defs against `CommandDef<Pattern>` — mechanical, the
  reducer shape already matches. Replace `stores/pattern.ts`'s undo/redo internals with
  `History<Pattern>`; replace the five parallel `Set<string>` selection stores with one
  `Selection`. `installAutomationApi(editor, 'seamer')` installs the generic surface; Seamer
  Studio must patch `getPattern`, the legacy selection object, and command metadata itself.
- **PackCAD:** convert `src/model/operationPipeline.ts` and `src/model/editorMutations.ts`
  into `CommandDef<PackagingContent>[]`. Wire `Editor` into `App.tsx`. **Ship Cmd+Z.**

**Outcome:** Seamer Studio's pattern store uses `Editor`, `History`, `Selection`, and
`IndexedDbHistoryPersistence`; its app-side `patchAutomationSurface()` supplies legacy
compatibility. PackCAD uses the same core command/history model with labeled undo/redo.

**Risk:** medium for Seamer Studio (touches the store layer every component reads), low for PackCAD
(purely additive).
**Current paths:** `seamer-studio/packages/pattern-model/src/commands/*` and
`seamer-studio/src/lib/stores/{pattern,localDB}.ts`; `packcad/src/App.tsx` and
`packcad/src/model/{operationPipeline,editorMutations}.ts`.

> **Sequencing note.** The Seamer Studio selection-store change ripples through ~30 components.
> Consider splitting: **2a** = command bus + history (isolated), **2b** = selection unification
> (broad). If 2b looks expensive when you get there, defer it — `Editor` can hold a `Selection`
> while Seamer Studio's components keep reading their old stores through a shim.

---

### Phase 3 — `@atelier/viewport` *(effectively complete)*

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
8. **Seamer Studio:** the 3D scene becomes a thin app-level orchestrator over the subsystems.
9. **PackCAD:** the fold view moves onto `Viewport` through `@atelier/react`.

**Outcome:** PackCAD mounts the engine with
`packcad/src/components/ViewportPane.tsx` and builds its domain scene in
`packcad/src/render/foldSceneBuilder.ts`. Seamer Studio orchestrates the same engine from
`seamer-studio/src/lib/scene/scene3d.ts` and
`seamer-studio/src/lib/components/PatternScene3D.svelte`; its cloth, avatar, materials, and
overlay semantics remain app-owned.

**Risk:** **high.** Largest surface, hardest to test, most likely to produce subtle visual
regressions.
**Mitigation:** land subsystems one at a time behind the old code path; each of steps 1–7 is
its own PR with a screenshot diff. Do not do 8 and 9 until 1–7 are all merged and used.

---

### Phase 4 — `@atelier/io` *(effectively complete)*

*Low risk, high mutual benefit. Both apps gain formats they don't have.*

**Do:**
- Define the neutral `Drawing` intermediate. Each fork writes one flattener
  (`Pattern → Drawing`, `PackagingProject → Drawing`).
- Lift seamer's `utils/{exporters,pdf,hpgl,cutfile}.ts` and its importers
  (`patternImport`, `cutImport`, `rulImport`, `seamlyImport`) onto `Drawing`.
- Lift packager's `createExportDielineSvg` / `createModelGltf` (`model/exporters.ts`).
- `@atelier/io/three` for glTF/OBJ/STL (three-dependent entry point, ARCHITECTURE §4.4).

**What each app gains:** PackCAD gets shared SVG/DXF/HPGL/PDF/CSV and three.js export paths;
Seamer Studio gets the neutral drawing exporters, browser print/PNG helpers, cut files, and
three.js export.

**Outcome:** both forks consume `@atelier/io`. Current adapter paths are
`packcad/src/model/drawing.ts`, `packcad/src/App.tsx`,
`seamer-studio/src/lib/utils/exporters.ts`, and
`seamer-studio/src/lib/utils/cutfile.ts`.

**Risk:** low. Pure functions, existing tests, easily diffable output.

---

### Phase 5 — `@atelier/sim` *(effectively complete)*

The package now provides `requestDevice`, `isWebGPUAvailable`,
`webgpuUnavailableReason`, and `SolverRunner`. Seamer Studio consumes it; WGSL, cloth
simulation, and fold solvers remain app-side.

---

### Phase 6 — Unified 2D viewport *(optional, expensive)*

Port Seamer Studio's `PatternCanvas2D.svelte` onto the engine's `projection: '2d'` (D8),
as PackCAD already does.

**Honest assessment:** this is the largest single body of work in the entire plan and the
payoff is architectural consistency, not new capability. Seamer Studio's Canvas2D works and is
feature-rich (silhouettes, warped background images, HPGL overlays, frozen snapshots, notch
rendering, seam arrows). There is a real argument it should stay Canvas2D forever — a 2D
drafting canvas is a legitimate use for `CanvasRenderingContext2D`, and WebGL buys little at
that scale.

**Recommendation:** do not commit to this. Re-evaluate only if Seamer Studio needs 2D features that
Canvas2D makes hard (e.g. very large patterns where GPU rendering wins).

---

## 4. three.js reconciliation

**Resolved.** The original audit compared legacy Packager on 0.181.2 with legacy Seamer on
0.170.0. The current PackCAD and Seamer Studio forks both use three.js 0.181.2, as does
Atelier's workspace lockfile. `three` is a peer dependency of the engine entry points that
accept three.js objects, and both Vite consumers deduplicate it. `pnpm lint` runs the
single-version lockfile assertion.

---

## 5. Risks

**R1 — The engine becomes a dumping ground.**
Two consumers is the minimum viable number for finding the right abstraction, and it is easy
to promote something that is really app-specific.
*Mitigation:* the "may not import" table (ARCHITECTURE §3) is CI-enforced. Rule of thumb:
if a signature mentions a domain noun (piece, panel, seam, crease, avatar), it does not belong
in a package.

**R2 — `cdt2d` → `delaunator` changes PackCAD's fold output. [RESOLVED — see outcome below]**

> **Outcome (measured, not assumed).** The two triangulators **do** disagree, on 2 of the
> MailerBox fixture's faces (8 and 15): they pick *opposite diagonals of a near-cocircular
> quad*, which is arbitrary in Delaunay and valid either way. Every divergence is a same-size
> diagonal swap, never a different constraint count, and total face area is conserved.
>
> **The converged fold does not move.** Running the Newton solver over the fixture under both
> triangulators gives a maximum per-vertex displacement below `1e-3` on a model spanning
> hundreds of units, with both solves converging to edge error `~5e-8`.
>
> Two permanent tests in `packcad/packages/fold-solver/src/` guard this:
> `triangulationParity.test.ts` (pins *where* they diverge) and `r2FoldOutcome.test.ts` (proves
> the fold is unaffected). `cdt2d` is retained as a devDependency solely for the comparison.
>
> **Testing trap worth remembering:** `vi.spyOn` on an ESM namespace does **not** intercept the
> solver's import — it silently no-ops, so both runs use delaunator and the test passes for the
> wrong reason. The mock must go through `vi.mock` + `vi.hoisted`, and the test asserts the
> mock was actually called.

Historical analysis:
`faceDiagonals()` feeds the isometry bars that keep facets rigid in the Newton solver. A
different triangulation gives a different constraint set, which can change the converged fold —
subtly, and possibly only on some inputs.
The mitigation was to compare both triangulators over PackCAD's fixture, then compare final
solver positions rather than requiring arbitrary Delaunay diagonals to match. The permanent
PackCAD tests above preserve both checks.

**R3 — Duplicate `three` instances under links. [MITIGATED]**
Breaks `instanceof` in ways that produce confusing, non-local failures.
*Mitigation:* `three` as peerDependency everywhere in Atelier + `resolve.dedupe: ['three']`
in both current apps. The Atelier lint gate asserts one three.js version in the lockfile.

**R4 — Seamer Studio's selection refactor ripples through ~30 components.**
*Mitigation:* the 2a/2b split described in Phase 2, with a shim as the escape hatch.

**R5 — Visual regressions in viewport consumers.**
*Mitigation:* compare current PackCAD and Seamer Studio captures with the retained legacy
reference images when viewport behavior changes.

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
| Visual | consumer apps | Reference images compare PackCAD and Seamer Studio with the legacy oracles. |
| Consumer | forks | Keep PackCAD and Seamer Studio's own typechecks and tests green. |
| Contract | `examples/minimal` | Included in Atelier's root TypeScript and Vitest gates. |

**Coverage floor:** shared modules keep their tests, and the minimal contract remains in both
root code gates.

---

## 7. Sequence summary

| Phase | Deliverable | Status | Consumer |
|---|---|---|---|
| 0 | workspace, lint rules, three reconciliation, reference images | complete | forks |
| 1 | `@atelier/geometry` | complete | forks |
| 2 | `@atelier/core` | complete | forks |
| 3 | `@atelier/viewport` | complete | forks |
| 4 | `@atelier/io` | complete | forks |
| 5 | `@atelier/sim` | complete | Seamer Studio |
| 6 | unified 2D viewport | not started | optional |
