# Task: close three remaining `@atelier/viewport` gaps

`seamer-studio` completed its Phase 3 migration but reported three capabilities it could not
reproduce faithfully through the engine. Close them.

## Working directory & boundaries

- Repo root: `/Users/ahmadjalil/github/Engine`
- **You may WRITE only inside `atelier/packages/viewport/` and `atelier/docs/`.**
- **Do NOT modify** other `atelier/packages/*`, `packcad/`, `seamer-studio/`, `packager/`, `seamer/`.
- `packcad/` and `seamer-studio/` are READ-ONLY reference consumers.

## Read these first

- `atelier/packages/viewport/src/{post,lighting,viewport}.ts` — current implementation.
- `atelier/docs/ARCHITECTURE.md` §4.3, §5.4 (disposal), §5.5 (errors — engine code returns typed
  results rather than throwing or logging).
- The consumer that needs these: `seamer-studio/src/lib/scene/{scene3d,seamerLighting,n8aoPost}.ts`
  and `src/lib/components/PatternScene3D.svelte`.

## The three gaps (verbatim from the consumer's report)

> - PostFX needs a custom DOF focus-distance provider and aperture policy to reproduce the
>   previous autofocus exactly.
> - `LightingRig` needs `clearEnvironment()`; flat mode currently cancels pending HDRIs with a
>   zero-intensity room request, then clears `scene.environment`.
> - `LightingRig.setEnvironment()` swallows load failures and provides no result/error hook, so
>   the previous three-attempt HDRI retry/backoff cannot be reproduced reliably.

### 1. DOF focus provider + aperture policy

`PostFX`'s Bokeh currently derives focus from a fixed target. seamer had autofocus driven by
its own scene knowledge (see `debugFocusPoint` in `settings3d`, and the focus logic in
`seamer-studio/src/lib/scene/scene3d.ts`). Add a way for the app to supply focus distance and
aperture policy — e.g. an optional `focusProvider?: () => { distance: number; aperture?: number } | null`
on `PostSettings.dof` or on `ViewportOptions`, whichever is cleaner given the existing code.

Read the consumer's actual focus logic before designing the hook. If a callback per frame is
too costly, an explicit `setFocus(distance, aperture)` plus an opt-in auto mode is fine — but
it must be able to reproduce the app's behaviour.

### 2. `LightingRig.clearEnvironment()`

Add an explicit method that removes `scene.environment`, cancels any in-flight HDRI load, and
releases the associated PMREM texture. The current workaround — requesting a zero-intensity
room environment purely to cancel a pending load, then nulling `scene.environment` — is a hack
forced by the missing API, and it leaks intent.

Cancellation must be real: an HDRI that resolves after `clearEnvironment()` must not install
itself. Keep the existing `envCache` behaviour for cached textures (do not evict shared cache
entries that other calls may still want).

### 3. `setEnvironment()` result / error hook

It currently swallows load failures. Per ARCHITECTURE §5.5 the engine surfaces recoverable
failures through return values rather than throwing or logging. Change it to report outcome —
e.g. `Promise<{ ok: true } | { ok: false; reason: string }>` (it already returns a Promise), or
an `onError` option — so a consumer can implement retry/backoff.

**Requirement:** seamer's three-attempt HDRI retry with backoff must be implementable on top of
your API *from the app side*. Do not put retry policy in the engine; just make failure visible.

## Hard constraints

- **TypeScript strict. Never use `any`.**
- **Backwards compatible.** `packcad` must keep passing **unmodified**, and `seamer-studio`
  must keep typechecking **unmodified** (you are not editing it, so any signature change must
  not break its current call sites). If `setEnvironment`'s return type changes, make it additive
  — existing `await rig.setEnvironment(...)` calls that ignore the result must still compile.
- three is a peerDependency; add no runtime dependencies.
- No `console.*`. No module-scope side effects. Everything disposable has an owner.
- Concise and simple: add the three hooks that were asked for, nothing speculative.

## Tests

Follow the package's existing pattern (no GL context in vitest — test the pure logic):
- `clearEnvironment()` cancels a pending load: a slow HDRI that resolves after the clear must
  not install itself.
- `setEnvironment()` reports failure rather than swallowing it, and a caller can retry.
- DOF focus provider is consulted and its distance/aperture reach the pass.

## Verification (all must pass)

```
cd /Users/ahmadjalil/github/Engine/atelier
pnpm exec tsc -b --pretty
pnpm exec vitest run
pnpm exec eslint packages examples

cd /Users/ahmadjalil/github/Engine/packcad
pnpm typecheck && pnpm test && pnpm lint

cd /Users/ahmadjalil/github/Engine/seamer-studio
pnpm check
```

`packcad` and `seamer-studio` must pass **without any edits to them**. If they cannot, your
change is not backwards compatible — fix the engine.

Update `atelier/docs/ARCHITECTURE.md` §4.3 to document the new API.

Do not run dev servers or production builds.

## Report format

1. **API added**, per gap, with final signatures.
2. **Backwards compatibility** — command output proving packcad and seamer-studio pass unmodified.
3. **Gap 1 validation** — how seamer's existing focus logic maps onto your hook.
4. **Gap 2 validation** — how cancellation is guaranteed.
5. **Tests**: count and coverage.
6. **Command output** for all five commands above.
