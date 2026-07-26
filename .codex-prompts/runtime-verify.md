# Task: runtime-verify packcad and seamer-studio in a real browser

Everything in these two apps has been verified **statically only** — typecheck, unit tests,
lint. **Neither has ever been opened in a browser.** Your job is to close that gap: drive both
apps for real, confirm the core vertical slice works, and report exactly what does and does not.

You have the `computer-use` / `browser` / `chrome` plugins. Use them.

## Boundaries

- Repo root: `/Users/ahmadjalil/github/Engine`
- **Prefer diagnosis over repair.** If something is broken, capture evidence and report it.
  Only fix what is small, obvious and clearly in-app (a typo, a bad import path). Do **not**
  restructure code, and do **not** edit `atelier/` — an engine change needs to be a deliberate
  decision, not a drive-by.
- Never weaken a test or assertion to make something pass.

## Start the dev servers

They collide on Vite's default port, so pin them:

```bash
cd /Users/ahmadjalil/github/Engine/packcad       && pnpm dev --port 5173 &
cd /Users/ahmadjalil/github/Engine/seamer-studio && pnpm dev --port 5174 &
```

Wait for each to report ready before driving it. If either fails to boot, that is itself a
top-priority finding — capture the full error and stop rather than working around it.

Shut both down when you are finished.

## App 1 — packcad (http://localhost:5173)

A packaging-dieline editor: import a flat crease pattern, fold it with a rigid-origami solver,
view it in 3D.

**Vertical slice — every step must work:**
1. App loads with no console errors.
2. Load the bundled **MailerBox** sample.
3. It folds and renders a closed 3D box — **not** a flat sheet, not an exploded mess.
4. Orbit the camera; the box stays coherent and lighting looks sane.
5. Click a face — it selects and highlights.
6. Make an edit, then **Cmd+Z / Cmd+Shift+Z**. Undo/redo must work. (This app had no undo at
   all before the engine port, so this is genuinely new — exercise it properly.)
7. Export **SVG** and **glTF**; confirm files download and are non-trivial in size.

## App 2 — seamer-studio (http://localhost:5174/studio)

A parametric sewing-pattern studio with a WebGPU cloth drape.

**Vertical slice:**
1. `/studio` loads with no console errors.
2. Load the **Pencil Skirt** template.
3. The 2D canvas draws the pattern pieces.
4. Select a point and drag it — the canvas repaints, and the shape follows.
   **This is the highest-risk area**: selection was just migrated off compatibility stores onto
   the engine's immutable `Selection`. A canvas that stops repainting on selection change is
   the specific regression to hunt for.
5. Undo/redo the drag. A drag must be **one** undo entry, not one per mousemove (gesture
   coalescing, 800 ms window).
6. The 3D pane shows the avatar and the arranged pieces.
7. Press **▶ Simulate**. WebGPU is required. Report honestly:
   - if WebGPU is unavailable in your browser, say so and confirm the app shows its banner
     rather than failing silently;
   - if it runs, does the garment drape onto the body — waist to hem, wrapping the hips — with
     no NaN explosion or clipping through the avatar?
8. Check **Ambient occlusion (N8AO)** in the property panel toggles and visibly changes shading.
   The AO path was just moved from an app-owned composer to the engine's `aoPassFactory`; the
   four `n8ao*` settings must still behave.
9. Export SVG.

WebGPU may need Chrome with `--enable-unsafe-webgpu`. If you cannot get it, say so plainly —
do not fake the result.

## Evidence

Save screenshots to `/Users/ahmadjalil/github/Engine/atelier/.runtime-verify/`:
- `packcad-folded.png`, `packcad-selected.png`
- `seamer-2d.png`, `seamer-3d.png`, `seamer-draped.png` (if the sim runs), `seamer-ao-on.png` /
  `seamer-ao-off.png`

Capture **all** browser console errors and warnings verbatim, per app.

## Report format

1. **Boot** — did each app start and load? Any console errors on load?
2. **packcad slice** — step by step, pass/fail, with the failure text where it fails.
3. **seamer-studio slice** — same.
4. **Canvas repaint on selection** — explicit verdict. This is the regression I most expect.
5. **WebGPU drape** — ran / did not run / not available, and what you actually observed.
6. **AO toggle** — does it visibly change shading?
7. **Console output** — every error and warning, verbatim.
8. **Anything you fixed**, and why it was safe to fix rather than report.
9. **Screenshots written.**

Be blunt. A clear list of what is broken is far more useful than a reassuring summary — these
apps have never been run, so finding nothing would be the surprising outcome.
