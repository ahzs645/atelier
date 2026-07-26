# Task: close six `@atelier/viewport` API gaps found by a real consumer

`seamer-studio` attempted the full Phase 3 migration onto `@atelier/viewport` and **stalled at
~8%** (`scene3d.ts` 2570 → 2352 LOC). It stopped not from scope but because the engine lacks
the hooks a real editor needs. This task adds them so the migration can finish.

This is the engine's most valuable feedback so far: a genuine second consumer reporting exactly
what is missing. Treat the list as requirements, not suggestions.

## Working directory & boundaries

- Repo root: `/Users/ahmadjalil/github/Engine`
- **You may WRITE only inside `atelier/packages/viewport/` and `atelier/docs/`.**
- **Do NOT modify** `atelier/packages/{core,geometry,io,sim,react,svelte}`, `packcad/`,
  `seamer-studio/`, `packager/`, or `seamer/`.
- `packcad/` and `seamer-studio/` are READ-ONLY reference consumers — read them to understand
  the requirements, but do not edit them.

## Read these first

- `atelier/docs/ARCHITECTURE.md` §4.3 (current viewport API), D7, D9, §5.3 (frame scheduling),
  §5.4 (disposal), §7 open question 7 (the AO problem).
- `atelier/packages/viewport/src/*.ts` — the current implementation.
- **The consumers that need these hooks:**
  - `seamer-studio/src/lib/scene/scene3d.ts` (the partially-migrated orchestrator)
  - `seamer-studio/src/lib/scene/n8aoPost.ts` (the app-side N8AO chain that must become injectable)
  - `seamer-studio/src/lib/scene/seamerLighting.ts` (analyzed-HDRI lighting rigs)
  - `packcad/src/components/ViewportPane.tsx` (the other consumer — do not break it)

## The six gaps

### 1. AO-pass / composer injection [highest priority]

`PostFX` hardcodes three's `GTAOPass` and owns its composer with no injection point. The
original production app uses **N8AO**, and `n8aoEnabled` / `n8aoRadius` / `n8aoIntensity` /
`n8aoDistanceFalloff` are **persisted document fields with user-facing controls** — so mapping
them onto GTAO would silently reinterpret saved user data. seamer therefore had to keep AO
entirely app-side, leaving the engine's `PostFX` unused.

Add an injection hook. Suggested shape (choose what is actually clean):

```ts
export interface AoPass {
  readonly pass: Pass                     // a three Pass to insert in the chain
  apply(settings: NonNullable<PostSettings['ao']>): void
  setSize(width: number, height: number): void
  dispose(): void
}
export interface ViewportOptions {
  /** Supply a custom AO pass (e.g. N8AO). Omit to use the built-in GTAO. */
  aoPassFactory?: (ctx: { scene: THREE.Scene; camera: THREE.Camera; renderer: THREE.WebGLRenderer }) => AoPass | null
}
```

Requirements:
- The built-in GTAO stays the default when no factory is supplied (`packcad` must keep working).
- The factory returning `null` must degrade gracefully, not crash.
- `PostFX`'s existing guarded-construction behaviour must be preserved: if the composer fails
  to build, `setEnabled` returns `false` and the Viewport falls back to direct rendering.
- **`n8ao` must NOT become a dependency of the engine.** The whole point is that the app owns it.
- Read `seamer-studio/src/lib/scene/n8aoPost.ts` and make sure your hook can actually express
  what it does — including its ResizeObserver-driven target sync. If it cannot, your shape is
  wrong.

### 2. Continuous-render lease

`Viewport` renders on demand via `invalidate()`. Apps with their own animations (a running
solve, a camera flight, TransformControls dragging, cloth playback) currently have to call
`invalidate()` on a self-managed loop. seamer reports needing "a general continuous-render
lease".

Add something like:

```ts
/** Hold the render loop open until released. Reference-counted. */
acquireRenderLease(reason?: string): () => void
get renderLeaseCount(): number
```

Requirements:
- Reference-counted: N acquires need N releases.
- Releasing twice must be safe (idempotent).
- While any lease is held, the loop runs continuously; when the last is released it returns to
  on-demand.
- `dispose()` must drop all leases and stop the loop.

### 3. `OverlayLayer` controls

seamer's seam / measurement / label overlays could not migrate. It needs:
- per-overlay **depth test** toggle (`depthTest: boolean`)
- **render order** control
- a **parent group** option, so overlays can be attached to an app-owned group (e.g. one that
  moves with the avatar) rather than always the scene root
- **custom label rendering** (the app needs its own label DOM/sprite content, not just a string)
- **efficient point updates** — currently updating points reallocates; add an in-place
  `updatePoints(id, positions)` that reuses the buffer when the length is unchanged.

### 4. `PickService` raw intersection details

seamer does **semantic seam-run picking**: it needs more than the first hit. Expose the
underlying intersection data — `THREE.Intersection` fields such as `uv`, `barycoord`,
`instanceId`, the full sorted intersection list, and the ability to pick without the service's
own filtering/registration bookkeeping getting in the way.

Extend `PickHit` (additively — do not break `packcad`) and/or add a
`raycast(event, opts): THREE.Intersection[]` escape hatch. ARCHITECTURE §1 explicitly permits
exposing three types; a leaky-but-honest escape hatch beats a lossy abstraction.

### 5. `LightingRig` preset + hooks

- A **"none" / "no direct lights"** preset (env-map-only lighting).
- Hooks for **analyzed HDRI rigs**: seamer analyses an HDRI and derives directional lights from
  it (see `seamer-studio/src/lib/scene/seamerLighting.ts`). It needs to supply its own light set
  while still using the rig's environment/PMREM/caching machinery.
- Preserve the existing `'room'` and HDRI-URL environment behaviour and the `envCache`.

### 6. `GizmoService` space + handle state

- Local vs world **transform space** selection.
- Public **handle-interaction state** (which axis/handle is active, whether a drag is in
  progress) so the app can react without subscribing to raw three events.

## Hard constraints

- **TypeScript strict. Never use `any`.** three's addon typings are awkward — narrow properly.
  If something is genuinely untypable, leave a `// TODO` explaining why and report it.
- **All additions must be backwards compatible.** `packcad` currently consumes this package and
  must keep typechecking and passing tests without modification. Verify this — see below.
- three is a **peerDependency**; do not add runtime dependencies to the engine.
- No framework imports, no module-scope side effects, no singletons.
- Every new resource has an owner and is released in `dispose()`.
- No `console.*`; surface failures through return values.
- Concise and simple. Add the hooks that were actually asked for — resist designing a plugin
  framework.

## Tests

Follow the package's existing approach: three needs a GL context, so unit-test the pure logic.
- render-lease reference counting (acquire/release/double-release/dispose-drops-all)
- `aoPassFactory` wiring: a fake `AoPass` is constructed, receives `apply`/`setSize`, and is
  disposed; returning `null` degrades gracefully; omitting it uses the default
- `OverlayLayer` in-place point update reuses the buffer when the length is unchanged
- `PickService` intersection passthrough shape
- `GizmoService` space + handle-state transitions

## Verification (all must pass)

```
cd /Users/ahmadjalil/github/Engine/atelier
pnpm exec tsc -b --pretty
pnpm exec vitest run
pnpm exec eslint packages examples
```

Then prove you did not break the existing consumer:

```
cd /Users/ahmadjalil/github/Engine/packcad
pnpm typecheck && pnpm test && pnpm lint
```

`packcad` must pass **without any edits to it**. If it cannot, your change is not backwards
compatible — fix the engine, not packcad.

Finally, update `atelier/docs/ARCHITECTURE.md` §4.3 to document the new API, and resolve
**§7 open question 7** (the AO question) to reflect that injection now exists.

Do not run dev servers or production builds.

## Report format

1. **API added**, per gap, with the final signatures.
2. **Backwards compatibility** — confirm `packcad` passes unmodified, with the command output.
3. **Gap 1 validation** — walk through how `seamer-studio/src/lib/scene/n8aoPost.ts` would be
   expressed through your `aoPassFactory`. If it does not fit cleanly, say so.
4. **Anything you chose NOT to add** from the six, and why.
5. **Tests**: count and coverage.
6. **Command output** for the engine and for packcad.
