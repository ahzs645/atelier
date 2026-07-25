# Atelier

A framework-agnostic **CAD editor runtime** for applications that turn flat 2D geometry into
3D form: document model, command bus with undo, 2D geometry kernel, three.js viewport, and I/O.

Extracted from two existing applications that independently rebuilt the same machine:

- **packager** — packaging dielines → rigid-origami fold → 3D mockup (React + R3F)
- **seamer** — sewing patterns → arrange on avatar → XPBD cloth drape (SvelteKit + three + WebGPU)

> **Status: design only.** No code has been written or moved yet. Read
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) first, then
> [`docs/MIGRATION.md`](docs/MIGRATION.md). [`docs/AUDIT.md`](docs/AUDIT.md) records what
> was found in the two source repos and is the evidence behind the design.

## The thesis

Neither app needs "a 3D engine". Both are the *same editor*:

```
2D document (mm)  →  solver  →  3D triangle mesh with UVs anchored to flat coords
                                          ↓
                         viewport: pick / select / gizmo / shade
                                          ↓
                                      exporters
```

Only the solver differs — rigid origami vs XPBD cloth. Everything around it is duplicated.
Atelier is everything except the solver.

## Name

`atelier` and the `@atelier/*` npm scope are placeholders. Both are a single find/replace
away from anything else; nothing in the design depends on the name.

## Docs

| Doc | What it covers |
|---|---|
| [`docs/AUDIT.md`](docs/AUDIT.md) | What's actually in packager and seamer, with file references |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Package boundaries, public APIs, type contracts, decisions |
| [`docs/MIGRATION.md`](docs/MIGRATION.md) | Phased plan, consumption model, three.js reconciliation, risks |
