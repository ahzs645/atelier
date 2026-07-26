# Task: fix the defects found by browser runtime verification

Both apps have now been driven in a real browser for the first time. Three significant failures
were found, plus several smaller ones. **I have already diagnosed the root causes of the two
packcad bugs — read the diagnosis before you start, and verify it rather than re-deriving it.**

## Working directory & boundaries

- Repo root: `/Users/ahmadjalil/github/Engine`
- **You may WRITE in `packcad/` and `seamer-studio/`.**
- **Do NOT modify `atelier/`** unless you conclude an engine change is genuinely required — in
  which case **stop and report it** instead of making it. An engine change must be a deliberate
  decision; both apps consume it.
- Evidence, including screenshots and the full console log, is in
  `atelier/.runtime-verify/`. Read `console-output.txt`.

## Verifying your fixes

`pnpm dev --port 5173` (packcad) and `pnpm dev --port 5174` (seamer-studio) both boot and serve
200. **Use the browser/computer-use plugins to confirm each fix actually works in the browser.**
A fix that only typechecks is not a fix — that assumption is exactly what let these bugs through.

---

## BUG 1 — packcad: the Mailer Box never closes [most important]

**Symptom:** the final 90° fold stage stays visibly open; the box never becomes a closed solid.

**Root cause (diagnosed, verify then fix):** the app never runs the settled solve.

`packcad/src/render/foldSceneBuilder.ts:192` reads:

```ts
const timelineSolve: FoldTimelineSolve = input.foldPositions
  ? { positions: input.foldPositions, ... }
  : solveFoldTimeline(model, foldStepIndex, foldAngle);
```

**Nothing in the app ever supplies `input.foldPositions`** — `grep -rn "foldPositions" src/` finds
no producer. So it always falls back to `solveFoldTimeline`, which is the *fast loop-closing
scrub solver* intended for live angle dragging.

`foldNewtonSequence` in `@packcad/fold-solver` is the **rigid-origami Newton/Gauss-Newton settled
solve**, and it converges properly: on this exact fixture it reaches `maxEdgeError ≈ 5.07e-8` and
`maxAngleErrorDeg ≈ 5.2e-6` (see `packages/fold-solver/src/mailerBox.golden.test.ts`). It is
exported from the plugin and **never called by the app**.

The original app's design, from packager's README: *"A fast loop-closing solver drives live
scrubbing; a Newton / Gauss-Newton rigid-origami solver produces the settled, isometric fold."*
Only the first half was wired up.

**Fix:** run the settled Newton solve and feed its positions in as `foldPositions` when the user
is not actively scrubbing. Keep `solveFoldTimeline` for live dragging — that separation is
deliberate and correct.

Design notes:
- The Newton solve is expensive; do not run it on every render or every angle tick. Settle when
  the fold step / angle stops changing (debounce), or on step change, and cache per
  (design, stepIndex, angle).
- `foldStatusWorker.ts` exists in the plugin for off-thread solve status — see whether the settle
  belongs there rather than blocking the main thread.
- Surface `maxEdgeError` / `maxAngleErrorDeg` somewhere in the UI (the inspector) so a
  non-converging fold is visible instead of silently wrong.

**Acceptance:** load the Mailer Box sample, run to the final step, and confirm in the browser
that the box is a **closed** solid. Screenshot it.

---

## BUG 2 — packcad: undo/redo controls never activate

**Symptom:** after material and pipeline edits, both toolbar buttons stay disabled and Cmd+Z
does nothing.

**Diagnosis so far — the core is NOT at fault.** I probed it directly:

```
new Editor(createDoc(createMailerBoxProject()), { registry: createCommandRegistry() })
editor.execute("material.setThickness", { thicknessMm: 7.5 })
→ canUndo === true
```

So `Editor`, the registry, and history all work headlessly. The command defs have
`mutating: true`. `App.tsx` wires `state.canUndo` → `Toolbar` correctly, and the Cmd+Z handler
calls `editor.undo()` directly.

**Therefore the bug is in the React binding's reactivity or in what the panels actually
dispatch.** Prime suspects, in order:
1. `@atelier/react`'s `useEditor` uses `useSyncExternalStore` with a `snapshotRef` cache — if the
   cached-snapshot comparison is wrong, or `editor.on(...)` disposers are mis-wired, React never
   re-renders. **Note: `useEditor` lives in the engine. If the bug is there, STOP and report it
   — do not edit `atelier/`.**
2. The panels may dispatch commands whose reducers return the project unchanged (→
   `changed: false` → no history entry). Check what `MaterialPanel` / `OperationPipelinePanel`
   actually pass, especially whether they re-send the already-current value.

Reproduce in the browser first, determine which of the two it is, then fix the app side or
report the engine side.

**Acceptance:** make an edit in the browser, confirm the Undo button enables, its tooltip shows
the command label, Cmd+Z reverts, and Cmd+Shift+Z re-applies.

---

## BUG 3 — seamer-studio: 3D pane black until a setting is toggled [ALREADY FIXED — verify only]

**Root cause:** `PatternRenderer.setPattern()` is `async`. The engine renders on demand, so the
initial frame is drawn against an empty scene; by the time the avatar resolves and the cloth is
rebuilt, nothing requests another frame. `setCameraState()` early-returns before its
`invalidate()` when the camera already matches the saved settings.

**I have already added `this.invalidate()` after `this.onStatus('ready')` in `setPattern()`.**

**Your job: verify it in the browser** — load `/studio`, choose the Pencil Skirt template, and
confirm the avatar and arranged pieces appear **without** touching any setting. Then audit
`scene3d.ts` for the same class of bug: any other `async` path that mutates the scene and
returns without invalidating. Fix those too.

---

## Smaller issues from the same run

**4. Drag sensitivity looks wrong (seamer).** ~22 screen pixels moved point A4 from
`(3.3, 731.7)` to `(69.6, 755.2)` mm — roughly 3 mm per pixel, which is far too coarse for a
drafting canvas. Investigate the screen→mm conversion in `PatternCanvas2D.svelte`
(`toPattern` / `baseScale`). This may be a zoom/`graphicsScale` mismatch. **Confirm against the
original app's behaviour before changing it** — do not just pick a number that feels better.

**5. Ungraceful geometry failure (seamer).** The oversized drag produced a UI error:
`Delaunator could not recover all polygon constraints without an incomplete mesh`. That throw is
**correct and deliberate** — the engine refuses to return a silently incomplete mesh. But an
invalid intermediate drag state should not surface a raw kernel error to the user. Catch it at
the app boundary and degrade gracefully (keep the last valid triangulation, show a soft
"invalid shape" state). **Do not weaken or remove the engine's guard.**

**6. Console warnings to clean up:**
- packcad: `GLTFExporter: Use MeshStandardMaterial or MeshBasicMaterial for best results.` (×2)
- seamer: Svelte `derived_inert` (×2)
- seamer: ten seam length/particle mismatch warnings, each emitted twice — investigate whether
  the duplication indicates double-building the cloth, which would be a real bug, not just noise.

---

## Hard constraints

- **TypeScript strict. Never use `any`.**
- Do not weaken or delete tests to make anything pass.
- `pnpm check` (seamer-studio) must stay **0 errors, 0 warnings**; packcad `pnpm typecheck`,
  `pnpm test`, `pnpm lint` must stay green.
- Preserve comments that explain *why*.
- Shut down any dev servers you start.

## Report format

1. **Bug 1** — was my diagnosis right? What you changed, where the settle now runs, how you kept
   it off the hot path, and browser confirmation the box closes. Screenshot path.
2. **Bug 2** — which of the two causes it was. If the engine's `useEditor` is at fault, describe
   the fix needed and **do not apply it**.
3. **Bug 3** — browser-confirmed? Any other missing-invalidate paths you found.
4. **Issues 4–6** — what you found and did; for 4, what the correct mm-per-pixel actually is and
   how you determined it; for 6, whether the doubled warnings indicate double-building.
5. **Anything you chose not to fix**, and why.
6. **Command output** for check/typecheck/test/lint in both apps.
