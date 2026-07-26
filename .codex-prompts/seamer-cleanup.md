# Task: seamer-studio — retire the selection compatibility layer, de-duplicate packing, expose glTF

Three focused cleanups. This is the last scaffolding from the engine port.

## Working directory & boundaries

- Repo root: `/Users/ahmadjalil/github/Engine`
- **You may WRITE only inside `/Users/ahmadjalil/github/Engine/seamer-studio/`.**
- **Do NOT modify** `atelier/`, `packcad/`, `packager/`, or `seamer/`.
  Another agent is concurrently editing `atelier/packages/viewport/` — do not read-depend on
  it changing, and do not edit it.
- **Do NOT touch `src/lib/components/PatternCanvas2D.svelte` beyond the selection change in
  Part 1.** Replacing Canvas2D with the engine's 2D projection is MIGRATION.md Phase 6 and is
  explicitly out of scope.

## Read these first

- `seamer-studio/README.md` "Not yet ported" — the verified gap list this task closes.
- `atelier/packages/core/src/selection.ts` — the canonical immutable `Selection`.
- `atelier/packages/svelte/src/editor-state.svelte.ts` — `editorState()` / `EditorState`.
- `seamer-studio/src/lib/stores/pattern.ts` — the compatibility stores you are retiring.

---

## Part 1 — retire the selection compatibility layer [main task]

`@atelier/core`'s `Selection` is the canonical state, but **eight files** still read the
`selectedPointIds` / `selectedPathIds` / `selectedPieceIds` Svelte stores, and
`EditorState.selection` currently has **zero** direct consumers:

```
src/lib/components/StatusBar.svelte
src/lib/components/PropertyPanel.svelte
src/lib/components/DrawingTools.svelte
src/lib/components/ErrorsPanel.svelte
src/lib/components/PatternCanvas2D.svelte
src/lib/components/ObjectBrowser.svelte
src/lib/components/StudioToolbar.svelte
src/routes/studio/[...slug]/+page.svelte
```

The stores already write through to the canonical `Selection` (see `selectionStore()` in
`src/lib/stores/pattern.ts`), so **this is cleanup, not a bug fix** — behaviour must not change.

Migrate each consumer to read `Selection` directly via `editorState()` from `@atelier/svelte`,
then **delete the three compatibility stores and the `selectionStore()` helper**.

Notes and cautions:
- `Selection` is **immutable** — every mutator returns a new instance. Code that did
  `selectedPointIds.update(s => { s.add(id); return s; })` must become
  `editor.setSelection(editor.selection.add('point', id))`.
- `Selection.get(kind)` returns a `ReadonlySet`. Call sites doing `$selectedPointIds.size`,
  `.has(id)`, or spreading need the equivalent `selection.get('point')` form.
- The kind strings in use are `'point'`, `'path'`, `'piece'` (see `selectionStore()`).
- `PatternCanvas2D.svelte` is 3317 LOC and is the heaviest consumer. Change **only** its
  selection reads/writes. Do not restructure it.
- Watch for reactivity: the old stores were `$`-subscribed. With runes, make sure selection
  changes still trigger redraws — a canvas that stops repainting on selection change is the
  most likely regression here.

If any consumer genuinely needs something `Selection` cannot express, **report it** rather than
keeping a shim.

---

## Part 2 — de-duplicate the packing core

`src/lib/utils/nestCore.ts` (492 LOC) and `src/lib/utils/markerLayout.ts` (531 LOC) overlap
`@atelier/geometry`'s `nest()`.

- **`nestCore.ts`**: the generic bottom-left / NFP packing core is engine work — replace it with
  `@atelier/geometry`'s `nest()` and delete the local duplicate.
- **`markerLayout.ts`**: **most of this is legitimately Pattern-specific** (piece construction,
  labels, fabric width/warp handling). Migrate **only** the packing call; keep the rest app-side.
  Do not force the whole file into the engine.

If the engine's `nest()` produces materially different layouts from the local implementation,
**do not silently accept it** — report the difference. `utils/nestCore.test.ts` and
`markerLayout.test.ts` must keep passing; do not weaken them to fit.

---

## Part 3 — expose glTF export in the UI

`sceneToGLTF` is wired in `src/lib/utils/exporters.ts` but no Studio action exposes it. Add a
glTF entry to the existing 3D/export menu, matching the conventions of the surrounding export
actions (filename, download helper, toast on completion/failure).

It needs the live three scene — see how the current 3D export path obtains it in
`src/lib/components/PatternScene3D.svelte` / `src/lib/scene/scene3d.ts`.

---

## Hard constraints

- **TypeScript strict. Never use `any`.**
- Svelte 5 runes. SSR-safe: no DOM globals at module scope.
- `pnpm check` is currently **0 errors, 0 warnings** — do not regress it.
- Do not weaken or delete existing tests to make things pass.
- Preserve source comments that explain *why*.
- Concise and simple. Parts 1–3 are deletion and rewiring, not redesign.

## Verification (all must pass)

```
cd /Users/ahmadjalil/github/Engine/seamer-studio
pnpm install
pnpm check          # must stay 0 ERRORS 0 WARNINGS
pnpm test:unit      # currently 183 passing — must not drop
pnpm lint
```

If `pnpm install` fails on network, **say so explicitly in your report** rather than reporting
verification you could not actually run. (This has happened on previous runs and produced
misleading reports.)

Do not run dev servers or production builds.

## Report format

1. **Selection migration** — the eight files, what changed in each, and how you verified
   reactivity still fires (especially the canvas).
2. **Stores deleted** — confirm `selectedPointIds`/`selectedPathIds`/`selectedPieceIds` and
   `selectionStore()` are gone, and that `EditorState.selection` now has real consumers.
3. **Anything `Selection` could not express**, if any.
4. **Packing** — what moved to `@atelier/geometry`, what stayed app-side and why, and whether
   layouts changed at all.
5. **glTF** — where the action lives and how it gets the scene.
6. **Test count** before → after, with any change explained.
7. **Command output** for install, check, test, lint — including any failures.
