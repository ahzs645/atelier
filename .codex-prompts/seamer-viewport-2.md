# Task: finish seamer-studio's viewport migration + add SVG import

This is the **second pass** of MIGRATION.md Phase 3 for `seamer-studio`. The first pass stalled
at ~8% (`scene3d.ts` 2570 → 2352 LOC) because `@atelier/viewport` lacked the hooks a real editor
needs. Those hooks have since been added. Finish the job.

## Working directory & boundaries

- Repo root: `/Users/ahmadjalil/github/Engine`
- **You may WRITE only inside `/Users/ahmadjalil/github/Engine/seamer-studio/`.**
- **Do NOT modify** `atelier/`, `packager/`, `seamer/`, or `packcad/`.
  If you find the engine still cannot express something, **report it — do not hack around it**
  and do not edit the engine.

## Read these first

1. **`atelier/.codex-reports/seamer-viewport.log`** — the first pass's report. Its sections 3,
   5 and 7 tell you exactly what was left app-side, which engine gaps blocked it, and where it
   stopped. Start there.
2. **`atelier/.codex-reports/engine-gaps.log`** — the report for the newly added engine APIs,
   with final signatures.
3. `atelier/packages/viewport/src/index.ts` — the real, current API. Read the source.
4. `atelier/docs/ARCHITECTURE.md` §4.3, §5.3 (on-demand rendering), §5.4 (disposal).
5. The current app code: `seamer-studio/src/lib/scene/{scene3d,n8aoPost,seamerLighting,materials,pieceTexture}.ts`
   and `src/lib/components/PatternScene3D.svelte`.

## Part 1 — finish the viewport migration

The engine now provides (confirm exact signatures from the engine source/report):

| New engine capability | Adopt it for |
|---|---|
| `aoPassFactory` on `ViewportOptions` | Inject the app's **real N8AO** into the engine's `PostFX` chain, so `PostFX` finally gets used. `src/lib/scene/n8aoPost.ts` becomes the factory. |
| continuous-render lease (`acquireRenderLease`) | Replace every ad-hoc `invalidate()` loop: solver frames, camera flights, TransformControls drags, cloth playback. |
| `OverlayLayer` depth-test / render-order / parent-group / custom labels / in-place point updates | Migrate the **seam overlays, measurement overlays, labels and arrangement points** — this is the single biggest remaining chunk. |
| `PickService` raw intersection details | Migrate **semantic seam-run picking**. |
| `LightingRig` "none" preset + analyzed-HDRI hooks | Migrate `seamerLighting.ts`'s rigs onto the engine's environment/PMREM/cache machinery. |
| `GizmoService` local/world space + handle-interaction state | Migrate **TransformControls** and arrange-mode. |

**Goal:** `scene3d.ts` should end up **well below 2352 LOC** and contain only genuinely
app-specific orchestration. That number is the honest progress metric — report before/after.

**Stays app-side regardless** (do not push into the engine): cloth mesh building, avatar meshes
and body cylinders, the *semantics* of seams/measurements, arrangement logic, cloth grabbing,
`pieceTexture.ts`, and the garment/skin material specifics + label-badge shader injection in
`scene/materials.ts`.

### Non-negotiables

- **All 22 `settings3d` fields must keep working.** They are persisted user data.
- **The four `n8ao*` fields must keep their exact meaning.** This is why the first pass kept AO
  app-side. Now that injection exists, the app's real N8AO goes through `aoPassFactory` — the
  *behaviour* must not change, only where the code lives. If injection cannot reproduce it
  faithfully, keep it app-side and report why.
- **On-demand rendering**: anything that animates must hold a render lease. Missing one causes
  a visible freeze — the most likely way to break this app.
- No visual regressions (MIGRATION.md risk R5): lighting modes, AO/DOF/SMAA, camera views, seam
  display, triangle overlay, arrangement points, snapshot ghosting, measurements, labels.
- The WebGPU cloth drape stays wired through `@atelier/sim`'s `SolverRunner`. It cannot be
  verified headlessly — say so, do not claim it works.

## Part 2 — clean up the temporary alias

A previous concurrent job added this compatibility shim to `seamer-studio/svelte.config.js`:

```js
alias: {
  // Temporary compatibility route for the concurrently migrated 3D scene.
  '$lib/utils/patternGeometry': './packages/pattern-model/src/utils/patternGeometry.ts',
  ...
}
```

It exists only because two agents were editing concurrently. **Remove it** and repoint the
importers directly at `@seamer/pattern-model`.

## Part 3 — add SVG import

The original production app ships an `SvgImportDialog`. `seamer-studio` has **no SVG import at
all** (no `fromSVG` / `parseSVG` anywhere) — a genuine missing feature.

`@atelier/io` already exports `fromSVG(svg, opts): Drawing`. Add:
- an `SvgImportDialog.svelte` matching the existing dialog conventions (see
  `DxfImportDialog.svelte` — mirror its structure, options and UX closely),
- wiring from the studio's import menu,
- conversion from the engine's `Drawing` into `Pattern` geometry, reusing whatever the DXF
  import path already does for that step rather than writing a second converter.

Add a unit test covering the SVG → `Drawing` → `Pattern` conversion.

## Hard constraints

- **TypeScript strict. Never use `any`.**
- Svelte 5 runes. SSR-safe: no DOM globals at module scope.
- three is **0.181.x**; import it exactly once as `import * as THREE from 'three'`.
- Preserve source comments that explain *why* — they encode real bug fixes.
- Do not weaken or delete existing tests to make things pass.
- Concise and simple.

## Scope control

If you cannot finish cleanly, **stop at a working boundary and say exactly where.** A partial
migration where everything works beats a complete one that is subtly broken. Prioritise in this
order: (1) overlays, (2) AO injection, (3) render leases, (4) lighting, (5) gizmo, (6) SVG
import, (7) alias cleanup.

## Verification (all must pass)

```
cd /Users/ahmadjalil/github/Engine/seamer-studio
pnpm install
pnpm check          # currently 0 ERRORS 0 WARNINGS — do not regress
pnpm test:unit
pnpm lint
```

Do not run dev servers or production builds.

## Report format

1. **`scene3d.ts` LOC**: 2570 (original) → 2352 (pass 1) → **your number**.
2. **Subsystems migrated this pass**, and which of the six new engine APIs each used.
3. **AO** — did `aoPassFactory` reproduce the app's N8AO faithfully? If not, what is missing?
4. **Render leases** — every place you took one, and how you verified nothing can freeze.
5. **settings3d** — confirm all 22 still work, or list which do not.
6. **Remaining engine gaps** — anything still missing after this pass.
7. **SVG import** — what it supports and its known limits.
8. **Where you stopped**, if not complete.
9. **Command output** for check, test, lint.
