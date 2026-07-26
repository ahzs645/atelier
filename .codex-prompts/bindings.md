# Task: implement `@atelier/react`, `@atelier/svelte`, and `examples/minimal`

You are implementing the thin framework bindings of the `atelier` engine, plus the smallest
example app that exercises the whole public API.

## Working directory & boundaries

- Repo root: `/Users/ahmadjalil/github/Engine`
- **You may WRITE only inside `atelier/packages/react/`, `atelier/packages/svelte/`, and
  `atelier/examples/minimal/`.**
- **Do NOT modify** anything else in `atelier/` (root configs, `docs/`, the engine packages).
- **Do NOT modify** `packager/` or `seamer/`.

## Read these first

- `atelier/docs/ARCHITECTURE.md` §4.6 — the exact binding APIs. Also D1 ("bindings are thin"),
  D10 (no module-scope side effects), and §5.6 (SSR safety).
- The engine's real source — these are implemented, read them, don't guess:
  `atelier/packages/core/src/index.ts`, `atelier/packages/viewport/src/index.ts`.

## The governing rule

**Bindings contain NO scene logic and NO document logic.** They mount a `Viewport`, adapt
`Editor`'s observer surface (`editor.on(event, fn)` returning a disposer) to the framework's
reactivity, and get out of the way. If you find yourself writing anything that would be equally
useful without React or Svelte, it belongs in the engine, not here. Each package should be
small — a few hundred lines at most.

## `@atelier/react`

Implement §4.6: `ViewportCanvas`, `useEditor`, `useSelection`, `useCommand`.

- React 19 is the peer dependency. Entry point is `src/index.tsx`.
- `ViewportCanvas` owns a container `<div>`, constructs a `Viewport` on mount, calls `onReady`,
  and **disposes it on unmount**. It must handle container resize (`ResizeObserver` →
  `viewport.resize()`) and must not recreate the `Viewport` on every render.
- `useEditor` should subscribe with `useSyncExternalStore` so it is concurrent-safe, not
  `useState` + `useEffect`.
- No `any`. Type the hooks generically over the editor's content type.

## `@atelier/svelte`

Implement §4.6: the `viewport` action and `editorState`.

- Svelte 5 is the peer dependency, and the bindings must use **runes** (`$state`, `$effect`),
  not the legacy store contract.
- `viewport` is a Svelte action (`use:viewport={options}`) with `update` and `destroy`.
- `editorState(editor)` returns a `$state`-backed object whose fields track the editor.
- **SSR safety is critical here** (§5.6) — SvelteKit will import this on the server. Nothing may
  touch `window`/`document` at module scope, and `editorState` must not explode when there is no
  DOM.

## `examples/minimal`

The smallest app that exercises the engine end to end. Its purpose is stated in MIGRATION.md
risk R6: it is the cheapest available proxy for a third consumer, so **if a change makes
`minimal` awkward, the engine's abstraction is wrong**. Keep it genuinely minimal.

It should:
- define a toy content type (say, a list of named 2D rectangles),
- register two or three commands on a `CommandRegistry` (`rect.create`, `rect.move`,
  `selection.delete`),
- construct an `Editor` and drive it, exercising undo/redo and a transaction,
- build a trivial three.js mesh per rectangle, register it with `PickService`, and mount a
  `Viewport`,
- use `@atelier/geometry` for at least one real operation (e.g. `triangulate` or
  `offsetPolygon`),
- export the scene via `@atelier/io` (`toSVG`).

Framework: use **React** via `@atelier/react` (it is the simpler binding to demo). Vite app,
one `index.html`, a handful of files. No styling framework, no router, no state library.

`examples/minimal` is already in the pnpm workspace (`pnpm-workspace.yaml` includes
`examples/*`). Create its `package.json` with `@atelier/*` as `workspace:*` dependencies.

**It must typecheck.** It does not need a test suite, but add one smoke test that constructs
the `Editor`, runs the commands, and asserts undo/redo works — that test is the actual contract
check and it must not need a DOM.

## Hard constraints

- **TypeScript strict. Never use `any`.**
- Use `import type` for type-only imports.
- No module-scope side effects, no singletons (D10).
- Concise and simple. These packages should be small; resist adding conveniences nobody asked for.
- `src/index.tsx` / `src/index.ts` are the only public surfaces.

## Commands to run (from `/Users/ahmadjalil/github/Engine/atelier`)

```
pnpm install
pnpm --filter @atelier/react exec tsc -b --pretty
pnpm --filter @atelier/svelte exec tsc -b --pretty
pnpm exec vitest run
pnpm exec eslint packages/react packages/svelte examples/minimal
```

All must pass. **Do not run dev servers. Do not run production builds.**

You may need to add devDependencies (`vite`, `@vitejs/plugin-react`, `svelte`) to
`examples/minimal/package.json` and the two binding packages — that is permitted, they are
inside your write boundary. Run `pnpm install` from the atelier root after editing manifests.

## Report format

1. **Files created** per package, one line each.
2. **API deviations** from ARCHITECTURE.md §4.6, with justification.
3. **Engine API friction** — building `minimal` is the engine's first honest usability test.
   What was awkward? What did you reach for that wasn't there? What would you change about the
   public API? Be specific and critical; this is the most valuable part of the report.
4. **SSR check** — confirm `@atelier/svelte` imports cleanly with no DOM present.
5. **Tests**: what the smoke test covers, pass/fail.
6. **Command output** for typecheck, test, lint (final lines).
