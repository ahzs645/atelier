import Delaunator from "delaunator";
import { bounds, pointInPolygon, polygonArea } from "./polygon";
import type { Polyline, Vec2 } from "./vec2";

export interface TriangulateInput {
  outer: Polyline;
  holes?: Polyline[];
  internalPoints?: Vec2[];
  spacing?: number;
  grid?: Vec2;
}

export interface TriMesh {
  points: Vec2[];
  triangles: number[];
  edges: Array<[number, number]>;
  boundary: number[];
  numBoundary: number;
  internal: number[];
}

type Triangle = [number, number, number];

function squaredDistance(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

// Uniform spatial hash ported with the Steiner-grid clearance behavior.
class SpatialGrid {
  private readonly cell: number;
  private readonly map = new Map<number, Vec2[]>();

  constructor(cell: number) {
    this.cell = Math.max(1e-3, cell);
  }

  private key(x: number, y: number): number {
    const ix = Math.floor(x / this.cell);
    const iy = Math.floor(y / this.cell);
    return (ix * 73856093) ^ (iy * 19349663);
  }

  add(point: Vec2): void {
    const key = this.key(point.x, point.y);
    const points = this.map.get(key);
    if (points) points.push(point);
    else this.map.set(key, [point]);
  }

  hasWithin(point: Vec2, radius: number): boolean {
    const radiusSquared = radius * radius;
    const ix = Math.floor(point.x / this.cell);
    const iy = Math.floor(point.y / this.cell);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const points = this.map.get(
          ((ix + dx) * 73856093) ^ ((iy + dy) * 19349663),
        );
        if (!points) continue;
        for (const other of points) {
          if (squaredDistance(point, other) < radiusSquared) return true;
        }
      }
    }
    return false;
  }
}

function samePoint(a: Vec2, b: Vec2): boolean {
  return a.x === b.x && a.y === b.y;
}

function orientation(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** Proper crossing only: touching at a shared endpoint is a valid mesh connection. */
function segmentsProperlyIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  if (samePoint(a, c) || samePoint(a, d) || samePoint(b, c) || samePoint(b, d)) {
    return false;
  }
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  return (
    ((abC > 0 && abD < 0) || (abC < 0 && abD > 0)) &&
    ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))
  );
}

function boundarySegments(outer: Polyline, holes: Polyline[]): Array<[Vec2, Vec2]> {
  const result: Array<[Vec2, Vec2]> = [];
  for (const loop of [outer, ...holes]) {
    for (let i = 0; i < loop.length; i += 1) {
      result.push([loop[i], loop[(i + 1) % loop.length]]);
    }
  }
  return result;
}

function triangleCrossesBoundary(
  triangle: Triangle,
  points: Vec2[],
  segments: Array<[Vec2, Vec2]>,
): boolean {
  const pairs: Array<[number, number]> = [
    [triangle[0], triangle[1]],
    [triangle[1], triangle[2]],
    [triangle[2], triangle[0]],
  ];
  for (const [from, to] of pairs) {
    for (const [a, b] of segments) {
      if (segmentsProperlyIntersect(points[from], points[to], a, b)) return true;
    }
  }
  return false;
}

function pointInTriangle(point: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const ab = orientation(a, b, point);
  const bc = orientation(b, c, point);
  const ca = orientation(c, a, point);
  const epsilon = 1e-12;
  return ab >= -epsilon && bc >= -epsilon && ca >= -epsilon;
}

/**
 * Ear-clipping fallback for a simple face loop. This is intentionally retained:
 * unconstrained Delaunay can choose an exterior diagonal for a non-convex face.
 */
function earClip(poly: Polyline): Triangle[] {
  if (poly.length < 3) return [];
  if (poly.length === 3) return [[0, 1, 2]];
  const remaining = Array.from({ length: poly.length }, (_value, index) => index);
  if (polygonArea(poly) < 0) remaining.reverse();
  const triangles: Triangle[] = [];
  let guard = poly.length * poly.length;
  while (remaining.length > 3 && guard > 0) {
    guard -= 1;
    let clipped = false;
    for (let i = 0; i < remaining.length; i += 1) {
      const previous = remaining[(i - 1 + remaining.length) % remaining.length];
      const current = remaining[i];
      const next = remaining[(i + 1) % remaining.length];
      if (orientation(poly[previous], poly[current], poly[next]) <= 1e-12) continue;
      let containsVertex = false;
      for (const candidate of remaining) {
        if (candidate === previous || candidate === current || candidate === next) continue;
        if (
          pointInTriangle(
            poly[candidate],
            poly[previous],
            poly[current],
            poly[next],
          )
        ) {
          containsVertex = true;
          break;
        }
      }
      if (containsVertex) continue;
      triangles.push([previous, current, next]);
      remaining.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (remaining.length === 3) {
    triangles.push([remaining[0], remaining[1], remaining[2]]);
  }
  return triangles;
}

function triangleArea(triangle: Triangle, points: Vec2[]): number {
  return Math.abs(
    orientation(points[triangle[0]], points[triangle[1]], points[triangle[2]]) / 2,
  );
}

function expectedArea(outer: Polyline, holes: Polyline[]): number {
  return (
    Math.abs(polygonArea(outer)) -
    holes.reduce((sum, hole) => sum + Math.abs(polygonArea(hole)), 0)
  );
}

function areaMatches(
  triangles: Triangle[],
  points: Vec2[],
  expected: number,
): boolean {
  const actual = triangles.reduce(
    (sum, triangle) => sum + triangleArea(triangle, points),
    0,
  );
  const tolerance = Math.max(1e-9, expected * 1e-9);
  return Math.abs(actual - expected) <= tolerance;
}

function steinerGrid(
  outer: Polyline,
  holes: Polyline[],
  constraints: Vec2[],
  spacing: number,
  direction: Vec2,
): Vec2[] {
  const directionLength = Math.hypot(direction.x, direction.y) || 1;
  const along = {
    x: direction.x / directionLength,
    y: direction.y / directionLength,
  };
  const across = { x: -along.y, y: along.x };
  const box = bounds(outer);
  const corners = [
    { x: box.minX, y: box.minY },
    { x: box.maxX, y: box.minY },
    { x: box.minX, y: box.maxY },
    { x: box.maxX, y: box.maxY },
  ];
  let alongMin = Infinity;
  let alongMax = -Infinity;
  let acrossMin = Infinity;
  let acrossMax = -Infinity;
  for (const corner of corners) {
    const u = corner.x * along.x + corner.y * along.y;
    const v = corner.x * across.x + corner.y * across.y;
    alongMin = Math.min(alongMin, u);
    alongMax = Math.max(alongMax, u);
    acrossMin = Math.min(acrossMin, v);
    acrossMax = Math.max(acrossMax, v);
  }
  const hash = new SpatialGrid(spacing);
  constraints.forEach((point) => hash.add(point));
  const clearance = spacing * 0.6;
  const result: Vec2[] = [];
  for (let u = alongMin; u <= alongMax; u += spacing) {
    for (let v = acrossMin; v <= acrossMax; v += spacing) {
      const point = {
        x: u * along.x + v * across.x,
        y: u * along.y + v * across.y,
      };
      if (!pointInPolygon(point, outer)) continue;
      if (holes.some((hole) => pointInPolygon(point, hole))) continue;
      if (hash.hasWithin(point, clearance)) continue;
      hash.add(point);
      result.push(point);
    }
  }
  return result;
}

function uniqueEdges(triangles: number[]): Array<[number, number]> {
  const seen = new Set<string>();
  const edges: Array<[number, number]> = [];
  const add = (a: number, b: number): void => {
    const low = Math.min(a, b);
    const high = Math.max(a, b);
    const key = `${low}:${high}`;
    if (!seen.has(key)) {
      seen.add(key);
      edges.push([low, high]);
    }
  };
  for (let i = 0; i < triangles.length; i += 3) {
    add(triangles[i], triangles[i + 1]);
    add(triangles[i + 1], triangles[i + 2]);
    add(triangles[i + 2], triangles[i]);
  }
  return edges;
}

export function triangulate(input: TriangulateInput): TriMesh {
  const outer = input.outer;
  const holes = input.holes ?? [];
  const internalPoints = input.internalPoints ?? [];
  const spacing = input.spacing && input.spacing > 0 ? input.spacing : 0;
  const constraints = [...outer, ...holes.flat(), ...internalPoints];
  const internalBase = constraints.length - internalPoints.length;
  const steiner =
    spacing > 0
      ? steinerGrid(
          outer,
          holes,
          constraints,
          spacing,
          input.grid ?? { x: 1, y: 0 },
        )
      : [];
  const all = [...constraints, ...steiner];
  const boundaryCount = outer.length;
  if (all.length < 3 || outer.length < 3) {
    return {
      points: all.slice(),
      triangles: [],
      edges: [],
      boundary: outer.map((_point, index) => index),
      numBoundary: outer.length,
      internal: internalPoints.map((_point, index) => internalBase + index),
    };
  }

  const coordinates = new Float64Array(all.length * 2);
  all.forEach((point, index) => {
    coordinates[index * 2] = point.x;
    coordinates[index * 2 + 1] = point.y;
  });
  const delaunay = new Delaunator(coordinates);
  const segments = boundarySegments(outer, holes);
  const scale = Math.max(
    1,
    ...outer.map((point) => Math.max(Math.abs(point.x), Math.abs(point.y))),
  );
  const minEdge = spacing > 0 ? Math.max(spacing * 0.1, 1e-4) : scale * 1e-12;
  const minArea = spacing > 0 ? Math.max(spacing * spacing * 0.01, 1e-6) : scale * scale * 1e-14;
  let kept: Triangle[] = [];
  for (let i = 0; i < delaunay.triangles.length; i += 3) {
    const triangle: Triangle = [
      delaunay.triangles[i],
      delaunay.triangles[i + 1],
      delaunay.triangles[i + 2],
    ];
    const a = all[triangle[0]];
    const b = all[triangle[1]];
    const c = all[triangle[2]];
    const centroid = {
      x: (a.x + b.x + c.x) / 3,
      y: (a.y + b.y + c.y) / 3,
    };
    if (!pointInPolygon(centroid, outer)) continue;
    if (holes.some((hole) => pointInPolygon(centroid, hole))) continue;
    if (triangleCrossesBoundary(triangle, all, segments)) continue;
    const minEdgeSquared = minEdge * minEdge;
    if (
      squaredDistance(a, b) < minEdgeSquared ||
      squaredDistance(b, c) < minEdgeSquared ||
      squaredDistance(c, a) < minEdgeSquared
    ) {
      continue;
    }
    if (triangleArea(triangle, all) < minArea) continue;
    kept.push(triangle);
  }

  const targetArea = expectedArea(outer, holes);
  if (!areaMatches(kept, all, targetArea)) {
    if (holes.length === 0 && internalPoints.length === 0 && steiner.length === 0) {
      kept = earClip(outer);
    }
    if (!areaMatches(kept, all, targetArea)) {
      throw new Error(
        "Delaunator could not recover all polygon constraints without an incomplete mesh",
      );
    }
  }

  // Compact in triangle encounter order while preserving maps back to input constraints.
  const originalToNew = new Int32Array(all.length).fill(-1);
  const points: Vec2[] = [];
  const remap = (index: number): number => {
    if (originalToNew[index] === -1) {
      originalToNew[index] = points.length;
      points.push(all[index]);
    }
    return originalToNew[index];
  };
  const triangles: number[] = [];
  for (const triangle of kept) {
    triangles.push(remap(triangle[0]), remap(triangle[1]), remap(triangle[2]));
  }
  const boundary = new Array<number>(boundaryCount);
  let numBoundary = 0;
  for (let i = 0; i < boundaryCount; i += 1) {
    boundary[i] = originalToNew[i];
    if (boundary[i] !== -1) numBoundary += 1;
  }
  const internal = internalPoints.map(
    (_point, index) => originalToNew[internalBase + index],
  );
  return {
    points,
    triangles,
    edges: uniqueEdges(triangles),
    boundary,
    numBoundary,
    internal,
  };
}

export function meshDiagonals(
  mesh: TriMesh,
  outerLen: number,
): Array<[number, number]> {
  const outerBoundary = new Set<string>();
  const count = Math.min(outerLen, mesh.boundary.length);
  for (let i = 0; i < count; i += 1) {
    const a = mesh.boundary[i];
    const b = mesh.boundary[(i + 1) % count];
    if (a < 0 || b < 0) continue;
    outerBoundary.add(a < b ? `${a}:${b}` : `${b}:${a}`);
  }
  const incidence = new Map<string, number>();
  for (let i = 0; i < mesh.triangles.length; i += 3) {
    const triangleEdges: Array<[number, number]> = [
      [mesh.triangles[i], mesh.triangles[i + 1]],
      [mesh.triangles[i + 1], mesh.triangles[i + 2]],
      [mesh.triangles[i + 2], mesh.triangles[i]],
    ];
    for (const [a, b] of triangleEdges) {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      incidence.set(key, (incidence.get(key) ?? 0) + 1);
    }
  }
  return mesh.edges.filter(([a, b]) => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    // Incidence one is any domain boundary, including hole loops. The explicit
    // outer set also preserves behavior for partial/degenerate meshes.
    return !outerBoundary.has(key) && incidence.get(key) === 2;
  });
}

/**
 * Packager-compatible convenience wrapper. Triangle indices are mapped back to
 * the original global vertex indices in `loop`.
 */
export function triangulateFace(
  loop: number[],
  coords: ReadonlyArray<ReadonlyArray<number>>,
): Triangle[] {
  if (loop.length < 3) return [];
  if (loop.length === 3) return [[loop[0], loop[1], loop[2]]];
  const outer = loop.map((vertex) => {
    const coordinate = coords[vertex];
    if (!coordinate || coordinate.length < 2) {
      throw new Error(`Missing 2D coordinate for vertex ${vertex}`);
    }
    return { x: coordinate[0], y: coordinate[1] };
  });
  const mesh = triangulate({ outer, spacing: 0 });
  const sourceIndexByMeshIndex = new Map<number, number>();
  mesh.boundary.forEach((meshIndex, sourceIndex) => {
    if (meshIndex >= 0) sourceIndexByMeshIndex.set(meshIndex, sourceIndex);
  });
  const result: Triangle[] = [];
  for (let i = 0; i < mesh.triangles.length; i += 3) {
    const a = sourceIndexByMeshIndex.get(mesh.triangles[i]);
    const b = sourceIndexByMeshIndex.get(mesh.triangles[i + 1]);
    const c = sourceIndexByMeshIndex.get(mesh.triangles[i + 2]);
    if (a === undefined || b === undefined || c === undefined) {
      throw new Error("Face triangulation lost an input boundary vertex");
    }
    result.push([loop[a], loop[b], loop[c]]);
  }
  return result;
}
