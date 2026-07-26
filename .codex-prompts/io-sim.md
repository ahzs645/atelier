# Task: implement `@atelier/io` and `@atelier/sim`

You are implementing two packages of a new engine, `atelier`, which extracts shared CAD-editor
infrastructure out of two existing apps.

## Working directory & boundaries

- Repo root: `/Users/ahmadjalil/github/Engine`
- **You may WRITE only inside `atelier/packages/io/` and `atelier/packages/sim/`.**
- **Do NOT modify** anything else in `atelier/` (root configs, `docs/`, other packages).
- **Do NOT modify** `packager/` or `seamer/`. They are READ-ONLY reference sources.

## Read these first

- `atelier/docs/ARCHITECTURE.md` §4.4 (`io`) and §4.5 (`sim`) — the exact public APIs.
  Also §3 (dependency rules), §5.1 (units), §5.5 (errors), §5.6 (SSR).
- `atelier/docs/AUDIT.md` §2.6 (I/O) and §2.7 (solvers).
- `atelier/docs/MIGRATION.md` Phase 4 and Phase 5.
- `atelier/packages/geometry/src/index.ts` — implemented; use its real types (`Vec2`, `Polyline`,
  `Bounds2`, `Polygon`).

---

# Part 1 — `@atelier/io`

## The central idea

Every exporter consumes ONE neutral intermediate, `Drawing` (ARCHITECTURE §4.4). Apps flatten
their own document into a `Drawing`; the engine never sees `Pattern` or `PackagingProject`.

## Sources to port from

**`seamer/src/lib/utils/`** — this is the rich side; take it:
- `exporters.ts` (456 LOC): `collectPolylines`, `patternBoundsMm`, `patternToSVG`/`patternToSVG2`,
  `patternToDXF`, `patternToCSV`, `patternToPNG`, `downloadText`, `downloadBlob`,
  `printPatternTiled`/`printMarkerTiled`/`printPattern`, `TileOpts`, `TILE_OVERLAP_MM = 6`.
  **Rewrite the `pattern` parameter to `Drawing`.** The `Layer`/`Poly` types there become the
  `DrawingLayer`/`DrawingPoly` of §4.4.
- `pdf.ts` (193 LOC): `buildPdf`, `tilePageCount`, `polylinesToPDF`, `PdfLayoutOpts`. This is a
  hand-rolled PDF writer — port it as-is, it has no dependencies.
- `hpgl.ts`: `toHPGL` and `parseHPGL` (both directions).
- `cutfile.ts`: `markerToCutFile`, `machineUsableWidthMm`, `machineUsableLengthMm`,
  `CuttingMachine`. Keep the machine-agnostic parts; if `printPieceLabels` is too coupled to
  `Pattern`, leave it behind and say so.
- Importers: `patternImport.ts`, `cutImport.ts`, `rulImport.ts`, `seamlyImport.ts`,
  `importSimplePattern.ts`, `autoTrace.ts`. **Port only the format parsing** that produces
  geometry (→ `fromSVG`, `fromDXF`, `fromHPGL`); anything that constructs `Pattern` objects
  stays in the app. Be conservative here — it is fine to port less and report what you left.

**`packager/src/model/exporters.ts`** (615 LOC): `createExportDielineSvg` and `createModelGltf`.
The SVG path should collapse into the shared `toSVG`; `createModelGltf` becomes `toGLTF`.

## Critical structural constraint

`toGLTF` / `toOBJ` / `toSTL` take a `THREE.Object3D`, which would make `io` depend on three and
violate the dependency rules. **Resolution (ARCHITECTURE §4.4):**

- `atelier/packages/io/src/**` — three-free. This is the default entry point.
- `atelier/packages/io/src/three/**` — the ONLY place that may `import * as THREE from 'three'`.
  Add a second export to `packages/io/package.json`:
  ```jsonc
  "exports": {
    ".": "./src/index.ts",
    "./three": "./src/three/index.ts"
  }
  ```
  (Editing `packages/io/package.json` IS permitted — it is inside your write boundary.)

The eslint config already enforces this split; `pnpm exec eslint packages/io` will fail if you
import three outside `src/three/`.

## `io` constraints

- Browser-only helpers (`downloadText`, `downloadBlob`, `printPattern*`, `toPNG` — anything
  touching `document`, `window`, `Blob`, `URL.createObjectURL`) go in
  `src/browser/` with its own export entry `"./browser"`. Nothing may touch DOM globals at
  module scope (§5.6) — seamer's SvelteKit SSR build depends on this.
- Everything else must be a **pure function** returning a string / `Uint8Array`, testable in Node.
- Units are millimetres throughout (§5.1).

---

# Part 2 — `@atelier/sim`

Deliberately **thin** — roughly 200 LOC of genuinely shared code. The solvers themselves
(packager's rigid-origami Newton solver, seamer's XPBD/WGSL cloth) stay in the apps as plugins
and are **explicitly out of scope**. Do not port them.

Implement exactly ARCHITECTURE §4.5: `SolverHandle<TState>`, `SolverPlugin<TInput, TState>`,
`SolverContext`, `isWebGPUAvailable()`, `requestDevice()`, `webgpuUnavailableReason()`,
`SolverRunner<TState>`.

Port the device-acquisition logic from **`seamer/src/lib/sim/webgpu/device.ts`**
(`requestClothDevice`, `isWebGPUAvailable`) — generalise it, add a clear unavailability reason
string, and cache the device.

`SolverRunner` is the self-paced async solve loop, decoupled from the render loop, that seamer
already runs (see `scene3d.ts` around `startSimulation`/`stopSimulation` ~1546). It calls
`onFrame` after each completed step so a viewport can `invalidate()`.

`requestDevice()` returns `null` rather than throwing when WebGPU is unavailable (§5.5).
`@webgpu/types` is already a devDependency — use those types, never `any`.

---

## Hard constraints (both packages)

- **TypeScript strict. Never use `any`.** `@typescript-eslint/no-explicit-any` is an error.
  If something is genuinely untypable, leave a `// TODO` explaining why and report it.
- No framework imports. No singletons or module-scope side effects (D10).
- Use `import type` for type-only imports.
- Concise and simple. Do not over-engineer; `sim` in particular should stay small.
- `src/index.ts` is the only public surface of each package (plus the extra entry points above).

## Tests

- `io`: golden-output tests. For a small hand-built `Drawing`, assert the exact SVG / DXF /
  HPGL / CSV output, and that `toPDF` produces a valid PDF header/trailer and the expected page
  count for a tiled layout. Round-trip `toHPGL` → `fromHPGL`. Adapt
  `seamer/src/lib/utils/export-formats.test.ts` and `cutfile.test.ts` where they apply.
- `sim`: `SolverRunner` lifecycle (start/stop/idempotence, `onFrame` fires per step, `dispose`
  stops the loop) against a fake in-memory `SolverHandle`. `isWebGPUAvailable()` must return
  `false` cleanly in Node with no `navigator.gpu` rather than throwing.

## Commands to run (from `/Users/ahmadjalil/github/Engine/atelier`)

```
pnpm --filter @atelier/io exec tsc -b --pretty
pnpm --filter @atelier/sim exec tsc -b --pretty
pnpm exec vitest run packages/io packages/sim
pnpm exec eslint packages/io packages/sim
```

All must pass. Do not run dev servers or bundler builds.

## Report format

1. **Files created** per package, one line each with purpose.
2. **API deviations** from ARCHITECTURE.md §4.4/§4.5, with justification. "None" if none.
3. **What you left behind** from seamer's exporters/importers because it was too coupled to
   `Pattern`, and what the app will therefore still need to own.
4. **Format coverage** — a table of which formats round-trip (in AND out) vs export-only.
5. **Tests**: count, coverage, final pass/fail.
6. **Command output** for typecheck, test, lint (final lines).
