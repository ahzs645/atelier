# Task: create the `seamer-studio` app repo and its plugin packages

You are creating a NEW application repo that consumes the `atelier` engine, replacing the
architecture of an existing app (`seamer`) without losing its domain logic.

## Working directory & boundaries

- Repo root: `/Users/ahmadjalil/github/Engine`
- **You may WRITE only inside `/Users/ahmadjalil/github/Engine/seamer-studio/`** (create it).
- **Do NOT modify** `atelier/`, `packager/`, `seamer/`, or `packcad/`. All are READ-ONLY here.
  `seamer/` is the source you are porting FROM; it must keep working untouched.

## Read these first

- `atelier/docs/ARCHITECTURE.md` §1, §3, §5.
- `atelier/docs/MIGRATION.md` §2 (consumption model, risk R3), Phase 2 sequencing note, Phase 6.
- `atelier/docs/AUDIT.md` §2 — especially §2.2 (seamer's command bus, which is where most of
  `@atelier/core` came from) and §2.5 (the 2D canvas divergence).
- The engine's real public APIs — read the source:
  `atelier/packages/{geometry,core,viewport,io,sim,svelte}/src/index.ts`

## What `seamer-studio` is

seamer's domain: a parametric sewing-pattern studio. Draft 2D pattern pieces with constraints
and formulas, reconstruct a morphable avatar from body measurements, arrange the pieces on it,
sew the seams, and drape the garment with an XPBD cloth simulation on WebGPU.

The engine now owns: document/commands/undo/selection, 2D geometry, the three.js viewport, I/O,
and the solver host. The app owns: the `Pattern` model, the constraint/formula solver, the
cloth simulation, the avatar, and the UI.

## Target structure

```
seamer-studio/
  package.json             # pnpm workspace root, private
  pnpm-workspace.yaml
  tsconfig.json
  eslint.config.js
  svelte.config.js
  vite.config.ts
  tailwind.config.js
  postcss.config.js
  .gitignore
  README.md
  packages/
    pattern-model/         # PLUGIN: the Pattern schema, commands, constraint solver, resolvers
    cloth-sim/             # PLUGIN: XPBD cloth on WebGPU (WGSL)
    avatar/                # PLUGIN: parametric morphable body + skinning
  src/                     # the SvelteKit app
  static/                  # model assets (see below)
```

Use **pnpm**. Engine deps as `file:` links to `../atelier/packages/*` — core, geometry,
viewport, io, sim, svelte.

**Risk R3:** add `resolve: { dedupe: ['three'] }` to `vite.config.ts`.

**three.js version:** seamer is on 0.170; the engine's viewport targets **0.181.x**. This app
must be on 0.181. `atelier/.codex-reports/viewport.log` contains a section listing every
0.170→0.181 API difference the viewport implementation hit — **read it, it is your upgrade
checklist.** Expect fallout in: the `EffectComposer` chain (`n8ao`, `BokehPass`, `SMAAPass`,
`OutputPass`), `LineMaterial`/`LineSegments2`, `TransformControls`, and colour-management /
tone-mapping defaults.

## Plugin 1 — `@seamer/pattern-model`

The domain model and its command surface. Port from `seamer/src/lib/`:
- `types/pattern.ts` (647) — the whole schema. This becomes the app's `TContent` for `Doc<T>`.
- `commands/*.ts` — ~75 command definitions across 13 categories. **Re-type them against
  `CommandDef<Pattern>` from `@atelier/core`.** The reducer shape already matches, so this is
  mostly mechanical. `commands/execute.ts`'s dispatcher, `PatternTransaction` and
  `installCommandApi` are now the engine's — **delete them and use `Editor` /
  `Editor.transaction()` / `installAutomationApi(editor, 'seamer')`**. Keep the `window.seamer`
  surface byte-compatible so existing external scripts keep working.
- `commands/selection.ts` — the batch transforms stay (they are `Pattern`-typed); the
  `Selection` *type* now comes from `@atelier/core`.
- `solver/{formula,solve}.ts` (657+) — the 2D constraint/formula solver. App domain, stays.
- `utils/patternGeometry.ts` — **keep only the `Pattern`-typed resolvers** (`pathPolyline`,
  `pieceOutline`, `pieceTransform`, `seamGeometry`, `placedPoints`, `indexPoints`, …). The
  domain-free half is now `@atelier/geometry` — import it instead of duplicating.
- `utils/patternMutations.ts`, `pathPointOps.ts`, `linkedPaths.ts`, `pieceSymmetry`,
  `patternValidation.ts`, `breakout.ts`, `seamTool.ts` — app domain, port as-is.
- Bring their existing tests (`commands.test.ts`, `create.test.ts`, `linkedPaths.test.ts`,
  `propertyFormulas.test.ts`, `patternImport.test.ts`, `pieceSymmetry.test.ts`, …).

## Plugin 2 — `@seamer/cloth-sim`

Port from `seamer/src/lib/sim/`: `config.ts`, `build.ts` (584) + `build.test.ts`,
`simulator.ts`, `refit.ts`, `cylinderRefit.ts`, and `webgpu/{device,engine,shaders}.ts`
(1148 LOC of WGSL in `shaders.ts` — port verbatim, do not rewrite shaders).

`webgpu/device.ts`'s device acquisition is now `@atelier/sim`'s `requestDevice()` /
`isWebGPUAvailable()` — use the engine's and delete the local copy. Wire the solve loop through
`@atelier/sim`'s `SolverRunner` and expose the simulation as a `SolverPlugin`. If XPBD's
substep model does not fit `SolverHandle` cleanly, do not contort it — report the mismatch.

Also port the geometry that feeds the sim: `geometry/{boundary,arrangement,cylinders}.ts`
(these are `Pattern`- and body-aware, so they belong here, not in `@atelier/geometry`).
`geometry/triangulate.ts` is now the engine's `triangulate()` — import it.

## Plugin 3 — `@seamer/avatar`

Port from `seamer/src/lib/model/`: `assets.ts`, `matrix.ts`, `measurements.ts`,
`measurementDefs.ts`, `avatar.ts`, `skinnedAvatar.ts`, `avatarController.ts`, `silhouette.ts`,
`bodyMeasurements3d.ts` + `bodyMeasurements3d.test.ts`.

The binary model assets live in `seamer/static/models/` (`base_model.json`,
`female_model.json`, `male_model.json`, `indices.bin`, `skin_indices.bin`, `skin_weights.bin`,
`female_coefficients.bin`, `male_coefficients.bin`). **Copy them into
`seamer-studio/static/models/`** — the avatar is useless without them.

## The app — `seamer-studio/src/`

1. **Document + editor.** Replace `stores/pattern.ts`'s undo/redo internals with the engine's
   `History<Pattern>` via `Editor`. Replace the five parallel `Set<string>` selection stores
   (`selectedPointIds`, `selectedPathIds`, `selectedPieceIds`, …) with the engine's single
   `Selection`. Use `@atelier/svelte`'s `editorState()` to expose it as Svelte 5 runes.
   **Preserve exactly:** gesture coalescing (a drag = one undo entry), labeled history, and
   IndexedDB persistence per pattern id.
2. **3D viewport.** `scene/scene3d.ts` is a 2556-line `PatternRenderer` doing ~10 jobs. It
   becomes a **thin app-level orchestrator** over the engine's `Viewport`, `CameraRig`,
   `LightingRig`, `PostFX`, `PickService`, `OverlayLayer` and `GizmoService`. What stays
   app-side: cloth mesh building, avatar meshes, seam overlays, measurement overlays, the
   arrange-mode logic, `pieceTexture.ts`, and the garment/skin material specifics in
   `scene/materials.ts` (the generic PBR part is now the engine's `createSurfaceMaterial`).
3. **2D canvas — LEAVE IT ALONE.** `components/PatternCanvas2D.svelte` is 3310 lines of
   hand-rolled `CanvasRenderingContext2D`. Porting it to the engine's `projection: '2d'` is
   MIGRATION Phase 6 and is **explicitly out of scope and not recommended**. Port it across
   as-is, changing only what is needed to read from the new `Editor`/`Selection` instead of the
   old stores.
4. **Export.** `utils/{exporters,pdf,hpgl,cutfile}.ts` are now `@atelier/io` — delete the local
   copies and write one `Pattern → Drawing` flattener. seamer **gains** glTF via
   `@atelier/io/three`.
5. **Server / app-level.** `routes/api/**`, `hooks.server.ts`, `lib/server/**`, better-auth,
   the MCP session store, analytics, release notes, and the marketing/docs pages
   (`routes/{pricing,software,docs,faq,about,privacy,terms,changelog}`) are app concerns —
   port them across unchanged. They must NOT reach into the engine.

## Scope control — read this carefully

seamer is ~33.6k LOC TS + ~9.2k LOC Svelte. **A complete port is not achievable in one pass and
you should not pretend otherwise.** Prioritise:

- **Must work end to end:** open `/studio` → load the Pencil Skirt template → the 2D canvas
  draws it → edit a point and undo/redo it → the 3D pane shows the avatar and arranged pieces →
  export SVG.
- The WebGPU drape must be *wired* (plugin ported, `SolverRunner` connected) even though it
  cannot be verified headlessly. Say clearly in your report that it is unverified.
- Everything else may be deferred, but **every deferral goes in the README's "Not yet ported"
  section with the source file it must come from.**
- **Do not leave silent gaps.** Documented gaps are fine; things that look done but aren't are not.

If you conclude the remaining work is too large for one pass, **stop, commit what genuinely
works, and report precisely where you stopped and what is left.** That is a better outcome than
a repo that typechecks but does not run.

## Hard constraints

- **TypeScript strict. Never use `any`.** If genuinely untypable, leave a `// TODO` with the
  reason and report it.
- pnpm only. Svelte 5 (runes), SvelteKit 2, Vite, Tailwind + daisyUI — keep seamer's existing
  stack and styling. This is a port, not a redesign.
- **SSR-safe:** no `window`/`document`/`localStorage`/`indexedDB`/`navigator.gpu` at module
  scope. seamer's existing guards exist for this reason — preserve them.
- Preserve source comments that explain *why*.
- Concise, simple solutions.

## Commands to run (from `/Users/ahmadjalil/github/Engine/seamer-studio`)

```
pnpm install
pnpm check          # svelte-check
pnpm test:unit      # vitest
pnpm lint
```

These must pass. **Do not run `pnpm dev` or any dev server. Do not run a production build.**
Do not run the Playwright e2e suite (it needs a running server).

## Report format

1. **Structure created** — the tree, one line per package/dir.
2. **Where you stopped** — be precise and honest. What is complete, what is partial, what is
   untouched.
3. **three 0.170 → 0.181 fallout** — what actually broke and how you fixed it.
4. **Engine API gaps** — anything the app needed that the engine should have provided, or
   engine APIs that were awkward in real use. This is the most valuable part of your report:
   seamer is the engine's hardest consumer and this is its real integration test.
5. **Behaviour preservation** — confirm coalescing, labeled history, and IndexedDB persistence
   still behave as before, or flag deviations.
6. **Not yet ported** — the README list, with source files.
7. **Command output** for install, check, test, lint (final lines).
