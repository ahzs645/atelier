# Task: implement `@atelier/viewport`

You are implementing the three.js runtime of a new engine, `atelier`, which extracts shared
CAD-editor infrastructure out of two existing apps. This is the largest and riskiest package.

## Working directory & boundaries

- Repo root: `/Users/ahmadjalil/github/Engine`
- **You may WRITE only inside `atelier/packages/viewport/`.**
- **Do NOT modify** anything else in `atelier/` (root configs, `docs/`, other packages).
- **Do NOT modify** `packager/` or `seamer/`. They are READ-ONLY reference sources.

## Read these first

- `atelier/docs/ARCHITECTURE.md` §4.3 — the exact public API. Also D1, D7, D8, D9, D10,
  and §5.1 (coordinate spaces), §5.2 (identity), §5.3 (frame scheduling), §5.4 (disposal).
- `atelier/docs/AUDIT.md` §2.4 and finding **F1** — packager's `render/*.ts` "contract" files
  are audit scaffolding, NOT an engine layer. Do not port their descriptor/`contractVersion`
  pattern. In particular `packager/src/render/raycastInteraction.ts` does not raycast at all;
  it hit-tests six hardcoded rectangles. `PickService` replaces it with real raycasting.
- `atelier/docs/MIGRATION.md` Phase 3 (which gives the build order) and risks R3, R5.
- `atelier/packages/core/src/index.ts` and `atelier/packages/geometry/src/index.ts` — these are
  now implemented; use their real types (`Id`, `ElementKind`, `Vec2`, `Bounds2`).

## Sources to port from

**`seamer/src/lib/scene/scene3d.ts`** — a 2556-line `PatternRenderer` class. This is the primary
source and it is strictly more capable than packager's. Decompose it (decision D7). Relevant
regions:
- constructor ~line 298 (renderer/camera/controls/scene setup), `invalidate()` ~358
- `setRenderQualityOptions` ~409, `applyPostSettings` ~451, `setPostProcessing` ~474 → `PostFX`
- `setLightingMode` ~507 → `LightingRig`; HDRI via `RGBELoader` + PMREM with `envCache`
- `setCameraView` ~2335, `getCameraFov`/`setCameraFov` ~2363, `zoomToBodyMeasurement` ~2319
  → `CameraRig`
- `setShowLabels`/`setLabelMode` ~1403 and the LineSegments2/LineMaterial overlays → `OverlayLayer`
- `setArrangeTransformMode` ~1777, `enterArrangeMode` ~1666 (TransformControls) → `GizmoService`
- `captureImage` ~2374, `dispose` ~2529
- **`scene/materials.ts`** → `createSurfaceMaterial` / `updateSurfaceMaterial` (the generic PBR
  part only; leave seamer's label-badge shader injection and `hasSeparateBack` behind).

**`packager/src/render/ThreePreview.tsx`**:
- `InteractiveCameraControls` lines 86–264 → merge into `CameraRig`.
  **Port the modifier+left-drag pan workaround verbatim, including its comment** (line ~169:
  "Some embedded browser paths report the modifier on keydown but omit it from pointerdown").
  It exists because of a real bug. Model it through `CameraRig.setInputMap()`.
- `SceneEnvironment` line ~275 (`PMREMGenerator` + `RoomEnvironment`) → the `'room'` option of
  `LightingRig.setEnvironment`.
- Line 584: `raycaster={{ params: { Line: { threshold: 0.03 } } }}` — the thin-crease pick
  radius, so clicking a panel interior selects the FACE and only a click on the line selects the
  crease. This becomes `PickOptions.lineThreshold`.
- Do NOT port `render/{cameraControls,lightingEnvironment,meshMaterialGraph,sceneGeometry,
  raycastInteraction}.ts` — those are the F1 scaffolding.

## Build order (follow it; each step should typecheck before the next)

1. `units.ts` — `MM_PER_M`, `docToWorld`, `worldToDoc`. **These are the ONLY two functions in
   the whole engine allowed to convert mm↔m** (§5.1). Document space is mm, world is meters,
   Y-up.
   **OPEN QUESTION you must resolve:** ARCHITECTURE §7 item 1 flags that the doc→world Y-axis
   flip is asserted, not verified. Determine the correct convention by reading
   `seamer/src/lib/geometry/arrangement.ts` (lines ~45, ~66-77), `seamer/src/lib/components/
   PatternCanvas2D.svelte` (`toCanvas` ~611 / `toPattern` ~620), and packager's
   `render/foldSceneBuilder.ts`. Implement what the sources actually do and **state your finding
   in the report**.
2. `resources.ts` — `ResourceScope` (D9).
3. `viewport.ts` — the `Viewport` facade with **on-demand rAF** (§5.3): `invalidate()` marks
   dirty, one frame renders. Continuous motion holds the loop open explicitly. Both source apps
   run free rAF loops; this is a deliberate change.
4. `camera.ts` — `CameraRig`, `CameraState`, `InputMap`.
5. `lighting.ts` — `LightingRig`.
6. `post.ts` — `PostFX`. Keep seamer's **guarded composer construction**: if the composer fails
   to build, return `false` and let the Viewport fall back to direct rendering.
7. `picking.ts` — `PickService`. New code. Objects register with an id + elementKind, written to
   `object.userData.atelierId` / `.atelierKind` (§5.2). Support `pick`, `pickAll`, `pickRegion`
   (screen-space marquee), hover/pick callbacks.
8. `overlay.ts` — `OverlayLayer` (LineSegments2/LineMaterial screen-space-width lines, labels,
   points).
9. `gizmo.ts` — `GizmoService` over `TransformControls`.
10. `materials.ts` — `SurfaceSpec`, `createSurfaceMaterial`, `updateSurfaceMaterial`.
    UVs are in document mm; `repeat = 1/scaleMm`.

## Hard constraints

- **TypeScript strict. Never use `any`.** `@typescript-eslint/no-explicit-any` is an error.
  three.js typings are awkward in places (addons, `TransformControls.getHelper()`,
  camera narrowing) — use proper narrowing (`camera instanceof THREE.OrthographicCamera`),
  generics, or a precise local interface. If something is genuinely untypable, leave a `// TODO`
  with an explanation and report it. Do not silently widen.
- **three is a peerDependency, imported as `import * as THREE from 'three'`.** Never bundle it,
  never import it twice by different specifiers (risk R3 — duplicate three instances break
  `instanceof` silently).
- The package targets **three 0.181.x** (its devDependency). seamer is currently on 0.170 and
  will be upgraded separately — write against 0.181 APIs and **note in your report every place
  where the 0.170→0.181 API differs**, because that list is the seamer upgrade checklist.
  Pay attention to: `LineMaterial`/`LineSegments2` location and signature, `TransformControls`
  (`.getHelper()`), `EffectComposer`/`OutputPass`, color management / tone mapping defaults.
- **No framework imports** (no react, no svelte) — decision D1, lint-enforced.
- **No module-scope side effects, no singletons** (D10). Everything constructed explicitly.
  Must not crash if imported during SSR — no `window`/`document` access at module scope.
- Every class exposes `dispose()`; `Viewport.dispose()` cascades (§5.4).
- No `console.*` from inside the package; surface failures via return values (§5.5).
- Use `import type` for type-only imports.
- Concise and simple. This package will be big; keep each module focused and readable.
- `src/index.ts` is the only public surface.

## Tests

three.js needs a WebGL context, which is not available in the `node` vitest environment. So:
- **Unit-test the pure logic without a renderer**: `units.ts` (round-trip mm↔m, the Y
  convention), `ResourceScope` (tracks and releases, idempotent), `CameraRig` state
  serialisation (`getState`/`setState` round-trip), `CameraRig.fitDoc` maths against known
  boxes, `InputMap` resolution (which pointer+modifier combination maps to which action),
  `SurfaceSpec` → material property mapping (constructing a `MeshPhysicalMaterial` does not need
  a GL context), and `PickService`'s screen→NDC maths and userData registration bookkeeping.
- Structure the code so this is possible — keep maths in pure functions that the classes call.
  That separation is worth having anyway.
- Do NOT add a headless-GL dependency.

## Commands to run (from `/Users/ahmadjalil/github/Engine/atelier`)

```
pnpm --filter @atelier/viewport exec tsc -b --pretty
pnpm exec vitest run packages/viewport
pnpm exec eslint packages/viewport
```

All three must pass. Do not run dev servers or bundler builds.

## Report format

1. **Files created**, one line each with purpose.
2. **API deviations** from ARCHITECTURE.md §4.3, with justification. "None" if none.
3. **Y-axis finding** — what the doc→world convention actually is in the two apps, and what you
   implemented. This resolves ARCHITECTURE §7 item 1.
4. **three 0.170 → 0.181 API differences** you had to write against. This is the seamer upgrade
   checklist — be thorough and specific.
5. **Typing notes** — anywhere three's types forced awkward code, and any `// TODO` you left.
6. **What you could not decompose cleanly** out of seamer's `PatternRenderer`, and why.
7. **Tests**: count, what they cover, final pass/fail.
8. **Command output** for typecheck, test, lint (final lines).
