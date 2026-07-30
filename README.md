# Atelier

A framework-agnostic **CAD editor runtime** for applications that turn flat 2D geometry into
3D form. It provides the shared document, geometry, viewport, I/O, simulation-host, and
framework-binding layers while leaving each application's domain solver and UI app-owned.

> **Status: implemented and in use.** All seven packages are implemented. The package suites
> contain 126 passing tests, and the gated `examples/minimal` contract test brings the workspace
> total to 127. PackCAD (React packaging CAD) and Seamer Studio (Svelte sewing-pattern CAD)
> consume Atelier through local `link:` dependencies. The original `packager` and `seamer`
> repositories remain untouched
> reference implementations; see [`docs/MIGRATION.md`](docs/MIGRATION.md).

## Packages

| Package | Purpose |
|---|---|
| `@atelier/geometry` | Pure 2D math, curves, polygon operations, triangulation, topology, nesting, and warping. |
| `@atelier/core` | Typed documents, commands, transactions, selection, undo/redo history, persistence, and automation. |
| `@atelier/viewport` | Imperative three.js viewport with cameras, lighting, post-processing, picking, overlays, gizmos, and resource ownership. |
| `@atelier/io` | Neutral `Drawing` import/export, PDF and cut-file output, plus browser and three.js entry points. |
| `@atelier/sim` | Solver lifecycle and shared WebGPU device acquisition for app-owned solvers. |
| `@atelier/react` | React hooks and a `ViewportCanvas` binding. |
| `@atelier/svelte` | Svelte 5 editor state and viewport action bindings. |

## Checks

```sh
pnpm typecheck
pnpm test
pnpm lint
```

`pnpm lint` includes the package dependency-boundary rules and the single-three-version
lockfile check.

## The thesis

Neither app needs "a 3D engine". Both are the *same editor*:

```
2D document (mm)  →  solver  →  3D triangle mesh with UVs anchored to flat coords
                                          ↓
                         viewport: pick / select / gizmo / shade
                                          ↓
                                      exporters
```

Only the solver differs — rigid origami vs XPBD cloth. Atelier owns the shared runtime around
those app-specific solvers.

## Name

`atelier` is the workspace name and `@atelier/*` is the package scope used by both consumers.

## Docs

| Doc | What it covers |
|---|---|
| [`docs/AUDIT.md`](docs/AUDIT.md) | What's actually in packager and seamer, with file references |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Package boundaries, public APIs, type contracts, decisions |
| [`docs/MIGRATION.md`](docs/MIGRATION.md) | What actually shipped, the fork-based adoption model, phase status, and remaining risks |
