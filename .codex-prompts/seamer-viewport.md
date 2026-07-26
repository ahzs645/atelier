# Task: migrate seamer-studio's 3D scene onto `@atelier/viewport`

`seamer-studio` was ported onto the `atelier` engine, but the 3D layer was NOT migrated: it
still ships its own 2570-line `PatternRenderer`, and imports exactly ONE symbol from
`@atelier/viewport` (`createSurfaceMaterial`). This is MIGRATION.md Phase 3 for seamer, and it
is the largest remaining piece of the project.

## Working directory & boundaries

- Repo root: `/Users/ahmadjalil/github/Engine`
- **You may WRITE only inside `seamer-studio/src/lib/scene/`,
  `seamer-studio/src/lib/components/PatternScene3D.svelte`, and
  `seamer-studio/src/lib/types/n8ao.d.ts`.**
- **Do NOT modify** `atelier/`, `packager/`, `seamer/`, or `packcad/`.
- Another agent is concurrently working in `seamer-studio/packages/**` and
  `seamer-studio/src/lib/utils/**`. **Do not touch those.**

## Read these first

- `atelier/docs/ARCHITECTURE.md` §4.3 (the viewport API), D7 (decomposition), D8, D9, §5.1–5.4.
- `atelier/docs/MIGRATION.md` Phase 3 and risk **R5** (silent visual regressions).
- `atelier/packages/viewport/src/index.ts` — the real API. Read the source, not just the docs.
- **`atelier/docs/ARCHITECTURE.md` §7 open question 7** — the AO problem, below.

## The AO problem — read this before you start

The original production app (captured at
`/Users/ahmadjalil/Downloads/seamscape.com/seamscape.com/`) uses **N8AO**, and it is not
cosmetic: `n8aoEnabled`, `n8aoRadius`, `n8aoIntensity` and `n8aoDistanceFalloff` are
**persisted document settings** in `PatternSettings3D`, surfaced as user controls in
`PropertyPanel.svelte`, and saved in user patterns.

`@atelier/viewport`'s `PostFX` implements three's built-in `GTAOPass` instead, and **owns its
composer with no injection point**. So a naive migration would silently reinterpret four
saved, user-facing document fields.

`seamer-studio` currently still uses real `n8ao` (because this migration never happened), so
today there is no regression. **Your migration must not introduce one.**

Since you cannot modify the engine, pick ONE and justify it in your report:

- **(a) Keep AO app-side.** Migrate everything else to `@atelier/viewport` but leave
  `PostFX`/`setPostProcessing` disabled and keep the app's own N8AO composer chain. Honest and
  lossless; leaves the engine's `PostFX` unused by this app.
- **(b) Migrate to the engine's GTAO** and map the four `n8ao*` settings onto
  `PostSettings.ao` as faithfully as possible, documenting the visual delta.
- **(c) Migrate everything except AO**, using the engine's `PostFX` for SMAA/DOF only.

**(a) or (c) is likely correct** — silently changing saved user documents' meaning is worse than
leaving one subsystem unmigrated. Do not choose (b) just because it is tidier. Whatever you
choose, `n8aoEnabled` etc. must keep behaving as the user expects.

If you conclude the engine genuinely needs an `aoPassFactory` hook on `ViewportOptions`, say so
clearly in your report — that is a real finding and the engine will be changed separately. Do
not work around it with a hack.

## What to migrate

`src/lib/scene/scene3d.ts` (2570 LOC, class `PatternRenderer`) becomes a **thin app-level
orchestrator** over the engine's subsystems. Map it as follows:

| Currently in `PatternRenderer` | Becomes |
|---|---|
| renderer / camera / controls / rAF loop | `Viewport` (note: engine renders **on demand** via `invalidate()`, not a free rAF loop) |
| `setCameraView`, `get/setCameraFov`, `zoomToBodyMeasurement`, fit logic | `CameraRig` |
| `setLightingMode`, HDRI + PMREM + `envCache`, floor/grid | `LightingRig` (the capture ships `3d/hdri/studio_small_08_1k.hdr` — keep HDRI support) |
| `setRenderQualityOptions`, `applyPostSettings`, `setPostProcessing`, SMAA, Bokeh | `PostFX` — **subject to the AO decision above** |
| raycasting / hover / selection / seam picking | `PickService` (register objects with `atelierId` / `atelierKind`) |
| LineSegments2 overlays, labels, arrangement points, measurement lines | `OverlayLayer` |
| `TransformControls`, `setArrangeTransformMode`, arrange mode | `GizmoService` |
| `dispose()` | cascade through `Viewport.dispose()` + `ResourceScope` |
| mm↔m conversions (`/1000`) | `docToWorld` / `worldToDoc` — the ONLY permitted conversion boundary |

**Stays app-side (do not push into the engine):** cloth mesh building, avatar meshes and body
cylinders, seam overlays' *semantics*, measurement definitions, arrangement logic, cloth
grabbing, `pieceTexture.ts`, the garment/skin material specifics and label-badge shader
injection in `scene/materials.ts`, and the simulation loop wiring.

`PatternScene3D.svelte` should drive the orchestrator; use `@atelier/svelte`'s `viewport`
action with its `onReady` callback to get the `Viewport` instance.

## Non-negotiables

- **No visual regressions** (risk R5). The app's existing 3D behaviour must be preserved:
  lighting modes, AO/DOF/SMAA behaviour, camera views, seam display, triangle overlay,
  arrangement points, snapshot ghosting, measurement display, labels.
- **All existing `settings3d` fields must keep working** — all 22 of them. They are persisted
  user data.
- The WebGPU cloth drape must remain wired through `@atelier/sim`'s `SolverRunner`. It cannot
  be verified headlessly; say so rather than claiming it works.
- **On-demand rendering**: the engine invalidates rather than looping. Anything continuously
  animating (orbit damping, a running solve) must hold the loop open explicitly, or it will
  visibly freeze. This is the single most likely way to break the app — be careful.

## Hard constraints

- **TypeScript strict. Never use `any`.** three's addon typings are awkward; narrow properly.
- three is **0.181.x** here. If you hit an API that moved since 0.170, fix it and note it.
- Import three exactly once, as `import * as THREE from 'three'` (risk R3: duplicate instances
  break `instanceof` silently).
- SSR-safe: no DOM/`window` access at module scope.
- Preserve the source comments that explain *why* — they encode real bug fixes.
- Concise and simple. The goal is that `scene3d.ts` gets much smaller.

## Scope control

If the full migration is too large to complete cleanly, **migrate subsystem by subsystem and
stop at a working boundary.** A partial migration where everything still works beats a complete
one that is subtly broken. State exactly where you stopped.

## Commands to run (from `/Users/ahmadjalil/github/Engine/seamer-studio`)

```
pnpm check
pnpm test:unit
pnpm lint
```

`pnpm check` is currently at **0 errors, 0 warnings** — do not regress it. Do not run dev
servers or builds.

## Report format

1. **AO decision** — which of (a)/(b)/(c), and why. Does the engine need an `aoPassFactory` hook?
2. **Subsystems migrated**, and `scene3d.ts` LOC before → after.
3. **What you deliberately left app-side** and why.
4. **On-demand rendering** — everywhere you had to explicitly hold the render loop open.
5. **Engine API gaps** — what `@atelier/viewport` was missing for a real consumer. seamer is
   the hardest consumer; this is the most valuable part of the report.
6. **settings3d coverage** — confirm all 22 fields still work, or list which do not.
7. **Where you stopped**, if not complete.
8. **Command output** for check, test, lint (final lines).
