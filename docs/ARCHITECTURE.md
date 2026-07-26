# Atelier — architecture

Design document. **No code exists yet.** This defines package boundaries, public APIs, type
contracts, and the decisions behind them. Read [`AUDIT.md`](AUDIT.md) first for the evidence.

---

## 1. Scope

**In scope — the editor runtime:**

| | |
|---|---|
| Document model | generic typed document, ids, layers, revisions |
| Command bus | schema'd pure reducers, transactions, dry-run, automation surface |
| History | labeled undo/redo, gesture coalescing, persistence |
| Selection | typed multi-kind selection + batch affine transforms |
| 2D geometry | Vec2, polylines, béziers, offsets, boolean-free polygon ops, triangulation |
| Viewport | three.js runtime: camera rig, controls, lighting/IBL, post FX, picking, gizmos, overlays, disposal |
| I/O | SVG, DXF, HPGL, PDF (tiled), PNG, glTF, OBJ, STL |
| Solver host | lifecycle + WebGPU device management for pluggable solvers |

**Out of scope — stays in the apps:**

- Fold solvers (packager), XPBD cloth + WGSL (seamer)
- Parametric avatar, body measurements, skinning (seamer)
- Material *catalogs* (corrugated flutes, fabric presets) — the *material spec type* is shared, the data is not
- All UI chrome, panels, toolbars, modals, routing
- Auth, server routes, analytics, MCP session store, marketing pages (see AUDIT F6)

**Non-goals.** Atelier is not a game engine, not an ECS, not a general scene-graph
abstraction over three.js, and not a rendering abstraction over WebGL/WebGPU. It wraps
three.js; it does not hide it. `THREE` types appear in `@atelier/viewport`'s public API
deliberately — escape hatches are cheaper than a leaky abstraction.

---

## 2. Decisions

### D1 — The engine is imperative and framework-agnostic. Bindings are thin.

`@atelier/viewport` is a plain TypeScript class tree with no framework dependency, in the
shape of seamer's `PatternRenderer` but decomposed. React and Svelte bindings mount it and
push state; they own no scene logic.

*Rationale.* Building on R3F would lock the engine to React and force seamer — the larger,
more mature codebase (33.6k vs 11.5k LOC) — into a full rewrite. The reverse costs packager
its declarative JSX scene graph, which is recoverable later via a thin R3F adapter that
constructs the same objects. Framework-agnostic is also the only option that satisfies the
stated goal of reuse in future projects.

*Cost, stated plainly.* packager's `FoldScene.tsx` and `ThreePreview.tsx` (1244 LOC combined)
become imperative. This is real work and it will read worse than the JSX for a while.

### D2 — `@atelier/core` and `@atelier/geometry` never import three.

Hard rule, enforced by lint (`no-restricted-imports`) and a CI check. They must run in Node
with no DOM, so document logic and geometry stay unit-testable without a canvas — which is
how seamer's existing ~20 test files already work.

### D3 — The document is generic over its content type.

seamer's command bus is excellent and entirely `Pattern`-typed. Generalising is the core
design work:

```ts
Pattern                                    →  Doc<TContent>
CommandDef.run(pattern, params, ctx)       →  CommandDef<T>.run(doc, params, ctx)
pushUndo(p: Pattern, label)                →  History<T>.push(doc, label)
Selection { pointIds, pathIds, pieceIds }  →  Selection (Map<ElementKind, Set<Id>>)
```

Apps supply their own content type and register their own commands. Atelier owns the bus,
history, transactions, and selection algebra — not the vocabulary.

### D4 — Snapshot history, not inverse commands.

Keep seamer's model: each undo entry holds a whole-document snapshot plus a label. It is
simple, cannot desynchronise, and is already proven in seamer. Structural sharing comes free
from reducers returning new objects with shared subtrees.

*Accepted cost.* Memory grows with document size × 100 entries. seamer already caps
persistence at 30 entries per stack. If this becomes a problem, the escape is a `Patch`-based
`HistoryStrategy` behind the same interface — designed for, not built now.

### D5 — Units: **document = millimetres, world = meters, one conversion boundary.**

Adopt seamer's convention wholesale (AUDIT F4). `@atelier/core` exports the constant and the
only two functions permitted to cross the boundary. Magic scalars like packager's
`thicknessMm / 42` become explicit conversions during migration.

Axis convention: **world is Y-up** (three.js default, matches both apps). Document space is
2D `{x, y}`; the doc→world mapping including any Y flip lives in exactly one function
(`docToWorld`) so it is auditable in one place. **The exact flip must be verified against
both apps' 2D canvases during Phase 1** — it is asserted here, not yet confirmed.

### D6 — One triangulation library: **`delaunator` + explicit constraints.**

packager uses `cdt2d`, seamer uses `delaunator` (AUDIT §2.3). Choose seamer's, because:

- `@atelier/geometry` needs holes, internal constraint points, a grain/direction-aligned
  Steiner grid, and index remapping back to input order — seamer's `triangulate.ts` already
  has all of it; `cdt2d` gives constrained edges but none of the rest.
- The engine's triangulation feeds a *simulation particle set*, which is seamer's use case.

packager's `triangulateFace` is CDT over a **convex-ish single face loop with no holes and no
interior points** — the strictly easier case. It must be reproduced on `delaunator` and
validated against the fold solver, since `faceDiagonals()` feeds the isometry bars that keep
facets rigid. **This is the highest-risk item in the whole extraction** (see MIGRATION R2).

### D7 — Viewport is composed of single-responsibility subsystems, not one class.

seamer's `PatternRenderer` is 2556 LOC doing ~10 jobs. It gets decomposed (§4.3). Each
subsystem is independently constructible and disposable, and the `Viewport` facade wires them.

### D8 — One scene, two projections.

Adopt packager's model (`FoldScene.tsx:50,161,315`): the 2D and 3D views are the same scene
graph under different projections, not two renderers. `@atelier/viewport` exposes
`projection: '2d' | '3d'`, where `'2d'` means locked top-down orthographic with pan/zoom only.

*Note.* This does **not** oblige seamer to abandon its 3310-line Canvas2D immediately. That
port is Phase 6 and optional. See MIGRATION.

### D9 — Explicit disposal everywhere, no finalizers.

Every subsystem implements `dispose(): void`. GPU resources are owned by exactly one object.
The `ResourceScope` helper tracks geometries/materials/textures for bulk release; both apps
currently hand-roll this (packager encodes a `disposalOrder` array in a JSON descriptor,
which is not a mechanism — see AUDIT F1).

### D10 — Public API is `import type`-friendly and side-effect free at module scope.

No global registration on import, no singletons. Everything is constructed explicitly. This
is what makes the engine testable and safe under SvelteKit SSR (seamer already guards
`localStorage` and `indexedDB` access for this reason — `stores/pattern.ts:60-70`).

---

## 3. Package graph

```
                        ┌──────────────────┐
                        │ @atelier/geometry│   pure 2D math. no three, no DOM.
                        └────────┬─────────┘
                                 │
                        ┌────────▼─────────┐
                        │  @atelier/core   │   doc, commands, history, selection.
                        └────────┬─────────┘   no three, no DOM.
              ┌──────────────────┼──────────────────┐
     ┌────────▼───────┐ ┌────────▼───────┐ ┌────────▼────────┐
     │@atelier/viewport│ │  @atelier/io  │ │  @atelier/sim   │
     │   three.js      │ │  pure fns     │ │  solver host    │
     └────────┬────────┘ └───────────────┘ └─────────────────┘
              │
     ┌────────┴────────┐
┌────▼─────┐    ┌──────▼────┐
│ /react   │    │ /svelte   │      thin bindings
└──────────┘    └───────────┘
```

**Dependency rules (CI-enforced):**

| Package | May import | May **not** import |
|---|---|---|
| `geometry` | nothing | everything |
| `core` | `geometry` | `three`, DOM, any app |
| `viewport` | `core`, `geometry`, `three` | `react`, `svelte`, any app |
| `io` | `core`, `geometry` | `viewport`, frameworks |
| `sim` | `core`, `geometry` | `viewport`, frameworks |
| `react` / `svelte` | `viewport`, `core`, `geometry` | each other |

No cycles. No app is ever a dependency of a package.

---

## 4. Packages

### 4.1 `@atelier/geometry`

Pure 2D math. Framework-free, three-free, DOM-free. Lifts from seamer's
`patternGeometry.ts` (the ~40% that is domain-free) and `triangulate.ts`, plus packager's
face-loop utilities.

```ts
// --- primitives -------------------------------------------------------------
export interface Vec2 { x: number; y: number }
export type Transform2 = (p: Vec2) => Vec2
export interface Bounds2 { minX: number; minY: number; maxX: number; maxY: number }
export type Polyline = Vec2[]
export interface Polygon { outer: Polyline; holes?: Polyline[] }

export function add(a: Vec2, b: Vec2): Vec2
export function sub(a: Vec2, b: Vec2): Vec2
export function scale(a: Vec2, k: number): Vec2
export function dot(a: Vec2, b: Vec2): number
export function cross(a: Vec2, b: Vec2): number
export function len(a: Vec2): number
export function dist(a: Vec2, b: Vec2): number
export function normalize(a: Vec2): Vec2
export function lerp(a: Vec2, b: Vec2, t: number): Vec2
export function rotate(p: Vec2, deg: number, about?: Vec2): Vec2

// --- curves -----------------------------------------------------------------
export interface CubicSegment { p0: Vec2; c0: Vec2; c1: Vec2; p1: Vec2 }
export function cubicAt(s: CubicSegment, t: number): Vec2
export function cubicTangentAt(s: CubicSegment, t: number): Vec2
export function cubicLength(s: CubicSegment, samples?: number): number
export function flattenCubic(s: CubicSegment, tolerance: number): Polyline

/** Arcs, ported from seamer's arcGeometry/arcParametric (both already unit-tested). */
export interface Arc { center: Vec2; radius: number; startDeg: number; endDeg: number }
export function arcToPolyline(a: Arc, tolerance: number): Polyline
export function threePointArc(a: Vec2, b: Vec2, c: Vec2): Arc | null

// --- polylines & polygons ---------------------------------------------------
export function bounds(pts: Polyline): Bounds2
export function boundsUnion(a: Bounds2, b: Bounds2): Bounds2
export function polylineLength(poly: Polyline): number
export function resamplePolyline(poly: Polyline, n: number): Polyline
export function simplifyPolyline(poly: Polyline, tolerance: number): Polyline
export function polygonArea(poly: Polyline): number          // signed
export function polygonCentroid(poly: Polyline): Vec2
export function pointInPolygon(p: Vec2, poly: Polyline): boolean
export function convexHull(pts: Vec2[]): Polyline
export function reflectAcrossLine(p: Vec2, a: Vec2, b: Vec2): Vec2

/** Miter offset with limit — seam allowance, bleed, kerf. */
export function offsetPolygon(poly: Polyline, dist: number, miterLimit?: number): Polyline
/** Per-edge offset distance (seamer's variable seam allowance). */
export function offsetPolygonVariable(
  poly: Polyline,
  distOf: (edgeIndex: number) => number,
  miterLimit?: number,
): Polyline

// --- triangulation (D6) -----------------------------------------------------
export interface TriangulateInput {
  outer: Polyline
  holes?: Polyline[]
  /** Extra constraint points that must survive as vertices (fold hinges, internal seams). */
  internalPoints?: Vec2[]
  /** Target inter-particle spacing. 0/undefined = boundary-only, no Steiner grid. */
  spacing?: number
  /** Steiner grid alignment (fabric grain, flute direction). Default { x: 1, y: 0 }. */
  grid?: Vec2
}

export interface TriMesh {
  points: Vec2[]
  triangles: number[]                  // flat, 3 indices per tri
  edges: Array<[number, number]>       // unique, deduped
  /** boundary[i] = vertex index of input outer[i], or -1 if pruned. */
  boundary: number[]
  numBoundary: number
  /** internal[k] = vertex index of input internalPoints[k], or -1 if pruned. */
  internal: number[]
}

export function triangulate(input: TriangulateInput): TriMesh
/** Non-boundary edges of the CDT — the isometry bars for rigid-facet solvers. */
export function meshDiagonals(mesh: TriMesh, outerLen: number): Array<[number, number]>

// --- face/edge topology (from packager's FOLD utilities) --------------------
export interface EdgeTopology {
  edgesVertices: Array<[number, number]>
  facesEdges: number[][]
  facesVertices: number[][]
  /** edge index → the 1–2 faces touching it */
  edgeFaces: number[][]
}
export function buildEdgeTopology(facesVertices: number[][]): EdgeTopology
export function faceVertexLoop(faceEdges: number[], edgesVertices: Array<[number, number]>): number[]
export function orientFacesConsistently(topo: EdgeTopology, seedFace: number): void

// --- nesting (from seamer's nestCore/markerLayout) --------------------------
export interface NestPlacement { index: number; offset: Vec2; rotationDeg: number }
export interface NestOptions { binWidth: number; binLength?: number; spacing: number; rotations: number[] }
export function nest(shapes: Polygon[], opts: NestOptions): NestPlacement[]
```

**Explicitly not here:** anything that takes a `Pattern`, `Piece`, `Path`, `FoldModel`,
or `PackagingProject`. Those resolvers stay app-side and *call into* this package.

---

### 4.2 `@atelier/core`

The document, command bus, history, and selection. No three, no DOM (D2).

```ts
// --- identity & document ----------------------------------------------------
export type Id = string
export type ElementKind = string                 // apps define their own vocabulary
export function makeUid(prefix: string): Id      // `${prefix}_${9 hex}` — seamer's convention

export interface DocMeta {
  id: Id
  name: string
  /** Monotonic; bumped by every committed mutation. */
  revision: number
  /** Document unit. Atelier's canonical unit is 'mm' (D5). */
  unit: 'mm'
  createdAt: string
  updatedAt: string
}

export interface Doc<TContent> {
  readonly meta: DocMeta
  readonly content: TContent
}

export function createDoc<T>(content: T, meta?: Partial<DocMeta>): Doc<T>
/** Structural-sharing update; bumps revision and updatedAt. */
export function withContent<T>(doc: Doc<T>, content: T): Doc<T>

// --- selection --------------------------------------------------------------
/** Multi-kind selection. Replaces seamer's five parallel Set<string> stores. */
export class Selection {
  static empty(): Selection
  static of(entries: Iterable<[ElementKind, Iterable<Id>]>): Selection
  get(kind: ElementKind): ReadonlySet<Id>
  has(kind: ElementKind, id: Id): boolean
  kinds(): ElementKind[]
  get size(): number
  add(kind: ElementKind, ...ids: Id[]): Selection      // immutable
  remove(kind: ElementKind, ...ids: Id[]): Selection
  toggle(kind: ElementKind, id: Id): Selection
  replace(kind: ElementKind, ids: Iterable<Id>): Selection
  clear(kind?: ElementKind): Selection
  equals(other: Selection): boolean
}

// --- commands ---------------------------------------------------------------
export interface CommandContext<T> {
  selection: Selection
  uid: (prefix: string) => Id
  /** Read-only view of the doc a command is running against. */
  doc: Doc<T>
}

export interface CommandDef<T, P = Record<string, unknown>> {
  /** Dotted id, e.g. "selection.rotate", "piece.create". */
  type: string
  category: string
  summary: string
  /** Ordered parameter descriptors; a trailing `?` marks optional. Drives docs + agent schema. */
  inputs: string[]
  example?: P
  /** false = read-only, records no history entry. Default true. */
  mutating?: boolean
  /** History label. Falls back to `summary`. */
  label?: string
  /** Pure reducer. Return `content` unchanged to signal "nothing happened". */
  run: (content: T, params: P, ctx: CommandContext<T>) => T
}

export class CommandRegistry<T> {
  register(def: CommandDef<T, never>): this
  registerAll(defs: Array<CommandDef<T, never>>): this
  get(type: string): CommandDef<T, never> | undefined
  list(): ReadonlyArray<CommandDef<T, never>>
  /** Serialisable description of the whole surface — palette, docs, agent tool schemas. */
  schema(): Array<Pick<CommandDef<T>, 'type' | 'category' | 'summary' | 'inputs' | 'example'>>
}

export interface CommandResult { ok: boolean; changed: boolean; error?: string }

// --- history ----------------------------------------------------------------
export interface HistoryEntry<T> { doc: Doc<T>; label: string; at: number }

export interface HistoryOptions {
  limit?: number            // default 100 (seamer's HISTORY_LIMIT)
  coalesceMs?: number       // default 800 — same-label pushes inside the window merge
  persist?: HistoryPersistence<unknown> | null
  persistLimit?: number     // default 30 per stack
}

/** Pluggable persistence. Atelier ships an IndexedDB impl in @atelier/core/persist. */
export interface HistoryPersistence<T> {
  save(docId: Id, undo: Array<HistoryEntry<T>>, redo: Array<HistoryEntry<T>>): Promise<void>
  load(docId: Id): Promise<{ undo: Array<HistoryEntry<T>>; redo: Array<HistoryEntry<T>> } | null>
  delete(docId: Id): Promise<void>
}

export class History<T> {
  constructor(opts?: HistoryOptions)
  push(doc: Doc<T>, label: string): void
  undo(current: Doc<T>): Doc<T> | null
  redo(current: Doc<T>): Doc<T> | null
  get undoLabel(): string | null
  get redoLabel(): string | null
  get labels(): readonly string[]
  reset(): void
  bind(docId: Id): Promise<boolean>     // restore persisted history; true if any was found
  dispose(): void
}

// --- editor: the thing apps actually hold -----------------------------------
export interface EditorOptions<T> {
  registry: CommandRegistry<T>
  history?: HistoryOptions
}

export type EditorEvent = 'doc' | 'selection' | 'history' | 'error'

export class Editor<T> {
  constructor(initial: Doc<T>, opts: EditorOptions<T>)

  get doc(): Doc<T>
  get content(): T
  get selection(): Selection
  setSelection(next: Selection): void

  /** Run a registered command. Commits through history when it changes anything. */
  execute<P>(type: string, params?: P): CommandResult
  /** Evaluate without committing (seamer's dryRun/preview). */
  preview<P>(type: string, params?: P): CommandResult
  /** Batch N commands into ONE history entry. */
  transaction(label?: string): Transaction<T>

  undo(): boolean
  redo(): boolean
  get canUndo(): boolean
  get canRedo(): boolean

  /** Minimal observer surface. Bindings adapt this to hooks / runes. */
  on(event: EditorEvent, fn: (e: Editor<T>) => void): () => void

  dispose(): void
}

export class Transaction<T> {
  execute<P>(type: string, params?: P): CommandResult
  preview<P>(type: string, params?: P): CommandResult
  /** Apply everything as one history entry. Returns whether anything changed. */
  commit(): boolean
  rollback(): void
}

/** Expose an editor on `globalThis` for external scripts/agents. Returns a disposer.
 *  Generalises seamer's installCommandApi / window.seamer. */
export function installAutomationApi<T>(editor: Editor<T>, name: string): () => void
```

**Migration mapping**

| seamer | Atelier |
|---|---|
| `commands/types.ts` `CommandDef` | `CommandDef<T, P>` — generic, typed params |
| `commands/execute.ts` `executeCommand(host, …)` | `Editor.execute` — host folded into the class |
| `commands/execute.ts` `PatternTransaction` | `Transaction<T>` |
| `commands/execute.ts` `installCommandApi` | `installAutomationApi` |
| `commands/registry.ts` (~75 defs) | **stays in seamer**, re-typed against `CommandDef<Pattern>` |
| `commands/selection.ts` `Selection` | `Selection` class; the *transforms* stay in seamer (Pattern-typed) |
| `stores/pattern.ts` undo/redo/coalesce | `History<T>` |
| `stores/localDB.ts` `saveHistory`/`loadHistory` | `IndexedDbHistoryPersistence` in `@atelier/core/persist` |
| `stores/pattern.ts` `persisted<T>()` | `@atelier/core/persist` `persisted<T>()` — SSR-guarded, framework-free |

**packager mapping:** `model/operationPipeline.ts` (10 mutators) and `model/editorMutations.ts`
become `CommandDef<PackagingContent>[]`. Signatures already match the reducer shape
(`(project, args) => project`), so this is mostly mechanical — and it is what gives packager
undo (AUDIT F2).

---

### 4.3 `@atelier/viewport`

The three.js runtime. Imperative, framework-free (D1), decomposed (D7).

```ts
import type * as THREE from 'three'

// --- units (D5) -------------------------------------------------------------
export const MM_PER_M = 1000
export function docToWorld(p: Vec2, z?: number): THREE.Vector3   // mm → m, single boundary
export function worldToDoc(v: THREE.Vector3): Vec2

// --- facade -----------------------------------------------------------------
export type Projection = '2d' | '3d'                             // D8

export interface ViewportOptions {
  container: HTMLElement
  projection?: Projection                    // default '3d'
  preserveDrawingBuffer?: boolean            // for captureImage()
  antialias?: boolean
  /** Skip EffectComposer entirely on low-end devices. */
  postProcessing?: boolean
}

export class Viewport {
  constructor(opts: ViewportOptions)

  readonly scene: THREE.Scene                // deliberate escape hatch (§1 non-goals)
  readonly renderer: THREE.WebGLRenderer
  readonly camera: CameraRig
  readonly lighting: LightingRig
  readonly post: PostFX
  readonly picking: PickService
  readonly overlays: OverlayLayer
  readonly gizmos: GizmoService

  setProjection(p: Projection): void
  /** Mark the frame dirty. The loop is on-demand, not a free-running rAF. */
  invalidate(): void
  resize(): void
  captureImage(mime?: string): string
  dispose(): void
}

// --- camera -----------------------------------------------------------------
export type CameraView = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'isometric' | 'reset'
export type CameraKind = 'perspective' | 'orthographic'

export interface CameraRigOptions {
  kind?: CameraKind
  fov?: number
  /** '2d' locks rotation and forces top-down orthographic. */
  projection?: Projection
}

export class CameraRig {
  readonly camera: THREE.Camera
  readonly controls: OrbitControls

  setKind(kind: CameraKind): void
  setView(view: CameraView): void
  setFov(deg: number): void
  getFov(): number
  /** Frame a bounding box with padding. Replaces both apps' ad-hoc fit code. */
  fit(box: THREE.Box3, padding?: number): void
  fitDoc(bounds: Bounds2, padding?: number): void
  /** Fly the camera to a target over `ms`. Used by seamer's zoomToBodyMeasurement. */
  flyTo(position: THREE.Vector3, target: THREE.Vector3, ms?: number): Promise<void>

  /** Modifier map: which pointer+modifier combos rotate / pan / zoom.
   *  Owns the embedded-browser modifier workaround from ThreePreview.tsx:169. */
  setInputMap(map: Partial<InputMap>): void

  onChange(fn: (state: CameraState) => void): () => void
  getState(): CameraState
  setState(s: CameraState): void            // for URL/session restore
  dispose(): void
}

export interface CameraState {
  kind: CameraKind
  position: [number, number, number]
  target: [number, number, number]
  zoom: number
  fov: number
}

export interface InputMap {
  left: 'rotate' | 'pan' | 'none'
  middle: 'dolly' | 'pan' | 'none'
  right: 'rotate' | 'pan' | 'none'
  /** Behaviour when shift/meta/ctrl is held. */
  modified: Partial<Pick<InputMap, 'left' | 'right'>>
}

// --- lighting ---------------------------------------------------------------
export type LightingPreset = 'studio' | 'flat' | 'technical' | 'hdri'

export class LightingRig {
  setPreset(preset: LightingPreset): void
  /** RoomEnvironment PMREM (packager) or an .hdr URL (seamer). Cached by key. */
  setEnvironment(source: 'room' | { hdri: string }, intensity?: number): Promise<void>
  setEnvironmentIntensity(v: number): void
  setShadows(enabled: boolean): void
  setBackground(color: string | null): void
  setGround(opts: { grid?: boolean; shadowCatcher?: boolean; size?: number } | null): void
  dispose(): void
}

// --- post-processing --------------------------------------------------------
export interface PostSettings {
  ao?: { enabled: boolean; intensity?: number; radius?: number; falloff?: number }
  dof?: { enabled: boolean; fStop?: number }
  smaa?: boolean
}

export class PostFX {
  /** Returns false if the composer failed to build; the Viewport falls back to direct
   *  rendering. Ported from seamer's guarded composer construction. */
  setEnabled(on: boolean): boolean
  apply(settings: PostSettings): void
  setQuality(opts: { forceLowEnd?: boolean; smaaScale?: number }): void
  dispose(): void
}

// --- picking ----------------------------------------------------------------
export type PickKind = 'face' | 'edge' | 'vertex' | 'object'

export interface PickHit {
  kind: PickKind
  /** Stable id written into object.userData.atelierId by whoever built the mesh. */
  id: Id
  elementKind: ElementKind
  object: THREE.Object3D
  point: THREE.Vector3
  /** Document-space position of the hit (mm). */
  docPoint: Vec2
  distance: number
  faceIndex?: number
  /** Index into the object's edge list, when kind === 'edge'. */
  edgeIndex?: number
}

export interface PickOptions {
  kinds?: PickKind[]
  /** Raycaster line threshold in world units. packager uses 0.03 for thin creases
   *  (ThreePreview.tsx:584) so a panel-interior click selects the face, not the crease. */
  lineThreshold?: number
  layers?: number[]
  filter?: (o: THREE.Object3D) => boolean
}

export class PickService {
  /** Raycast from a pointer event against the registered pickable set. */
  pick(event: PointerEvent | { clientX: number; clientY: number }, opts?: PickOptions): PickHit | null
  pickAll(event: PointerEvent, opts?: PickOptions): PickHit[]
  /** Marquee/box select in screen space. */
  pickRegion(a: Vec2, b: Vec2, opts?: PickOptions): PickHit[]

  register(object: THREE.Object3D, id: Id, elementKind: ElementKind, kinds?: PickKind[]): void
  unregister(object: THREE.Object3D): void

  onHover(fn: (hit: PickHit | null) => void): () => void
  onPick(fn: (hit: PickHit | null, ev: PointerEvent) => void): () => void
  dispose(): void
}
```

> **This is what replaces packager's `raycastInteraction.ts`** — which does not raycast at all,
> but hit-tests six hardcoded rectangles (AUDIT F1). It is also what replaces the picking
> scattered through seamer's `PatternRenderer`.

```ts
// --- overlays ---------------------------------------------------------------
export interface LineStyle { color: string; width: number; dashed?: boolean; opacity?: number }

export class OverlayLayer {
  /** Screen-space-width lines via LineSegments2/LineMaterial (both apps already use these). */
  addLines(id: Id, segments: Float32Array, style: LineStyle): void
  updateLines(id: Id, segments: Float32Array): void
  addLabel(id: Id, text: string, at: THREE.Vector3, mode?: 'billboard' | 'flat'): void
  addPoints(id: Id, positions: Float32Array, style: { color: string; size: number }): void
  setVisible(id: Id, v: boolean): void
  setStyle(id: Id, style: Partial<LineStyle>): void
  remove(id: Id): void
  clear(): void
  dispose(): void
}

// --- gizmos -----------------------------------------------------------------
export type GizmoMode = 'translate' | 'rotate' | 'scale'

export class GizmoService {
  attach(object: THREE.Object3D, mode?: GizmoMode): void
  detach(): void
  setMode(mode: GizmoMode): void
  /** Restrict to a plane — '2d' arrangement editing wants XZ or XY only. */
  setPlane(plane: 'xy' | 'xz' | 'yz' | null): void
  onDragStart(fn: () => void): () => void
  onDrag(fn: (o: THREE.Object3D) => void): () => void
  onDragEnd(fn: (o: THREE.Object3D) => void): () => void
  dispose(): void
}

// --- materials --------------------------------------------------------------
/** Shared *spec* type. Material catalogs (corrugated flutes, fabric presets) stay app-side. */
export interface SurfaceSpec {
  color: string
  roughness: number
  metalness: number
  opacity?: number
  alphaCutoff?: number
  specularIntensity?: number
  doubleSided?: boolean
  /** UVs are in document mm; repeat = 1/scaleMm. Matches seamer's convention. */
  map?: { url: string; scaleMm: number; rotationDeg?: number; offset?: Vec2 }
  /** Signed offset along the vertex normal (meters) for visual sheet thickness. */
  shellOffset?: number
}

export function createSurfaceMaterial(spec: SurfaceSpec): THREE.MeshPhysicalMaterial
export function updateSurfaceMaterial(mat: THREE.MeshPhysicalMaterial, spec: SurfaceSpec): void

// --- resources --------------------------------------------------------------
/** Tracks disposables so a subsystem can release everything it owns (D9). */
export class ResourceScope {
  track<T extends { dispose(): void }>(r: T): T
  release(): void
}
```

**Deliberately NOT in viewport:** anything that knows about panels, pieces, seams, creases,
avatars, or fold keyframes. Apps build meshes and register them with `PickService`.

---

### 4.4 `@atelier/io`

Pure functions over `@atelier/geometry` types. No DOM APIs at module scope; browser-only
helpers (`downloadBlob`, `printTiled`) live in `@atelier/io/browser`.

```ts
export interface DrawingLayer { id: string; name: string; style?: LineStyle }
export interface DrawingPoly { pts: Polyline; closed: boolean; layer: string }
export interface DrawingText { text: string; at: Vec2; sizeMm: number; rotationDeg?: number; layer: string }

/** The neutral intermediate every exporter consumes. Apps flatten their document into this. */
export interface Drawing {
  layers: DrawingLayer[]
  polys: DrawingPoly[]
  texts: DrawingText[]
  boundsMm: Bounds2
}

// vector out
export function toSVG(d: Drawing, opts?: SvgOptions): string
export function toDXF(d: Drawing): string
export function toHPGL(d: Drawing, opts?: HpglOptions): string
export function toPDF(d: Drawing, opts?: PdfLayoutOpts): Uint8Array
export function toCSV(d: Drawing): string

// tiled printing (seamer's TILE_OVERLAP_MM = 6)
export interface TileOpts { pageWidthMm?: number; pageHeightMm?: number; overlapMm?: number; marginMm?: number }
export function tilePageCount(d: Drawing, opts?: TileOpts): { cols: number; rows: number }
export function toTiledPDF(d: Drawing, opts?: TileOpts): Uint8Array

// vector in
export function fromSVG(svg: string, opts?: { unit?: 'mm' | 'px'; dpi?: number }): Drawing
export function fromDXF(text: string): Drawing
export function fromHPGL(text: string): Polyline[]

// 3D
export function toGLTF(scene: THREE.Object3D, opts?: { binary?: boolean }): Promise<ArrayBuffer | object>
export function toOBJ(scene: THREE.Object3D): string
export function toSTL(scene: THREE.Object3D, opts?: { binary?: boolean }): ArrayBuffer | string
```

> `toGLTF`/`toOBJ`/`toSTL` take a `THREE.Object3D`, which would make `io` depend on `three`
> and violate §3. **Resolution:** they live in a separate `@atelier/io/three` entry point
> that may depend on three; the base `@atelier/io` stays three-free. Enforced by the lint rule
> scoping to `src/` and excluding `src/three/`.

---

### 4.5 `@atelier/sim`

Thin. Solvers are app-owned plugins (§1); this package only hosts them.

```ts
export interface SolverHandle<TState> {
  step(dt: number): Promise<void> | void
  /** Read current positions back. Length = particleCount * 3. */
  read(out?: Float32Array): Float32Array
  state(): TState
  reset(): void
  dispose(): void
}

export interface SolverPlugin<TInput, TState> {
  readonly id: string
  readonly backend: 'cpu' | 'webgpu' | 'worker'
  build(input: TInput, ctx: SolverContext): Promise<SolverHandle<TState>>
}

export interface SolverContext {
  device?: GPUDevice
  signal?: AbortSignal
}

/** Shared, cached WebGPU device acquisition with a clear unavailability reason.
 *  Generalises seamer's sim/webgpu/device.ts. */
export function isWebGPUAvailable(): boolean
export function requestDevice(opts?: { required?: string[] }): Promise<GPUDevice | null>
export function webgpuUnavailableReason(): string | null

/** Self-paced async solve loop decoupled from the render loop, as seamer already does.
 *  Calls onFrame after each completed step so the viewport can invalidate(). */
export class SolverRunner<TState> {
  constructor(handle: SolverHandle<TState>, opts?: { targetHz?: number })
  start(): void
  stop(): void
  get running(): boolean
  onFrame(fn: (state: TState) => void): () => void
  dispose(): void
}
```

---

### 4.6 `@atelier/react` and `@atelier/svelte`

Thin. Neither contains scene logic; both mount a `Viewport` and adapt `Editor`'s observer
surface to the framework's reactivity.

```ts
// @atelier/react
export function ViewportCanvas(props: {
  options: ViewportOptions
  onReady: (vp: Viewport) => void
  className?: string
}): JSX.Element

export function useEditor<T>(editor: Editor<T>): {
  doc: Doc<T>; content: T; selection: Selection
  execute: Editor<T>['execute']
  undo(): void; redo(): void; canUndo: boolean; canRedo: boolean
  undoLabel: string | null; redoLabel: string | null
}
export function useSelection<T>(editor: Editor<T>): [Selection, (s: Selection) => void]
export function useCommand<T, P>(editor: Editor<T>, type: string): (params?: P) => CommandResult

// @atelier/svelte  — Svelte 5 runes + actions
export function viewport(node: HTMLElement, options: ViewportOptions): {
  update(o: ViewportOptions): void
  destroy(): void
}                                              // use:viewport={options}
export function editorState<T>(editor: Editor<T>): {
  readonly doc: Doc<T>
  readonly content: T
  readonly selection: Selection
  readonly canUndo: boolean
  readonly canRedo: boolean
}                                              // $state-backed
```

---

## 5. Cross-cutting contracts

### 5.1 Coordinate spaces

| Space | Unit | Axes | Where |
|---|---|---|---|
| **Document** | mm | 2D `{x, y}` | `@atelier/core`, `@atelier/geometry`, all commands, all I/O |
| **World** | meters | Y-up | `@atelier/viewport`, three.js scene |
| **Screen** | px | Y-down | pointer events only |

Exactly two functions cross doc↔world: `docToWorld` / `worldToDoc` (D5). Nothing else may
divide or multiply by 1000. Screen↔world goes through `PickService` and `CameraRig` only.

### 5.2 Identity

Every pickable three.js object carries `object.userData.atelierId: Id` and
`object.userData.atelierKind: ElementKind`, written at registration time. `PickService`
reads these; nothing else depends on object naming or scene-graph position.

### 5.3 Frame scheduling

Rendering is **on demand**: `Viewport.invalidate()` marks dirty, one rAF renders. Continuous
motion (orbit damping, a running solver) holds the loop open explicitly. Both apps currently
run free rAF loops; this is a deliberate change and should measurably reduce idle GPU load.

### 5.4 Disposal

Every class exposes `dispose()`. `Viewport.dispose()` cascades to all subsystems. GPU
resources have exactly one owner. `ResourceScope` covers the bulk cases (D9).

### 5.5 Errors

Engine code throws only on programmer error (unknown command type, unregistered object).
Recoverable failures return typed results — `CommandResult.error`, `PostFX.setEnabled()`
returning `false`, `requestDevice()` returning `null` with a reason. No `console.warn` from
inside a package; surface it through the return value or an `'error'` event.

### 5.6 SSR

No package touches `window`, `document`, `localStorage`, `indexedDB`, or `navigator.gpu` at
module scope (D10). Browser-only helpers guard at call time and are segregated into
`/browser` entry points. seamer's SvelteKit build depends on this.

---

## 6. Repo layout

```
atelier/
  package.json                 # pnpm workspace root, private
  pnpm-workspace.yaml
  tsconfig.base.json
  eslint.config.js             # incl. dependency-rule enforcement (§3)
  vitest.workspace.ts
  docs/{ARCHITECTURE,MIGRATION,AUDIT}.md
  packages/
    geometry/  core/  viewport/  io/  sim/  react/  svelte/
  examples/
    minimal/                   # smallest app that proves the API: doc + 2 commands + viewport
```

Each package: `src/`, `src/index.ts` (the only public surface), `package.json` with
`exports` map, colocated `*.test.ts`. Build with `tsc` to ESM + `.d.ts` — no bundler for
libraries; apps bundle.

**Versioning:** all packages share one version, released together. Independent versioning is
not worth the coordination cost at two consumers.

---

## 7. Open questions

Flagged rather than guessed. None block starting Phase 0.

1. ~~**Document Y-axis direction** (D5).~~ **RESOLVED during implementation.** Document space is
   mathematical **Y-up, with no inversion in `docToWorld`**. Evidence: seamer's
   `geometry/arrangement.ts` maps document `(x, y)` straight to world `(x, y)` after the mm→m
   divide, and `PatternCanvas2D` negates Y *only* when projecting to Y-down canvas pixels.
   packager's flat projection negates its depth axis to compensate for the top-down camera's
   screen inversion — that is projection-specific, not a document convention (its folded-3D path
   uses the positive sign). See `packages/viewport/src/units.ts` and its tests.
2. **`delaunator` parity for packager's fold facets** (D6). The single highest-risk item;
   see MIGRATION R2 for the mitigation.
3. **Layers.** seamer has a first-class `Layer` model with style/lock/visibility; packager has
   none. Layers are arguably core, not app. Deferred: layers stay in seamer's content type for
   now; promote to `@atelier/core` only if packager grows a real need.
4. **Grading and alterations.** seamer's `GradingProfile`/`AlterationTrack` are a *parametric
   variation* system that is conceptually general (a packaging line has size runs too). Not
   designed here. Revisit after Phase 4.
5. **Does packager still need R3F?** After Phase 3, packager could keep a thin R3F adapter that
   constructs the same objects, or drop React-Three entirely and use `@atelier/react`'s
   `ViewportCanvas`. Decide with the code in front of you, not now.
6. **Publishing.** Private registry, GitHub Packages, or git dependency? See MIGRATION §2 —
   affects nothing before Phase 1 ships.
7. **Ambient occlusion: `GTAOPass` vs `n8ao`. [known deviation]** seamer's polished look comes
   from the external `n8ao` package (`N8AOPass`). `PostFX` ships three r181's built-in
   `GTAOPass` instead, to keep the engine dependency-light. **This will change seamer's shading
   and must be checked against the Phase 0 reference images (risk R5).**
   `PostFX` currently owns its composer with no injection point, so an app cannot swap the AO
   pass — if the GTAO look is not acceptable, the fix is an engine change: an
   `aoPassFactory` option on `ViewportOptions`, or exposing the composer for app-owned passes.
   Deliberately not built speculatively; decide with the rendered comparison in front of you.
