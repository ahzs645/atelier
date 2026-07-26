import { describe, expect, it } from "vitest";
import {
  meshDiagonals,
  pointInPolygon,
  polygonArea,
  triangulate,
  triangulateFace,
} from "./index";
import type { Polyline, TriMesh, Vec2 } from "./index";

interface PolygonCase {
  name: string;
  outer: Polyline;
  holes?: Polyline[];
}

const cases: PolygonCase[] = [
  {
    name: "L-shape",
    outer: [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 4 },
      { x: 0, y: 4 },
    ],
  },
  {
    name: "U-shape",
    outer: [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 3, y: 4 },
      { x: 3, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 4 },
      { x: 0, y: 4 },
    ],
  },
  {
    name: "deep notch",
    outer: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 6, y: 10 },
      { x: 6, y: 1 },
      { x: 4, y: 1 },
      { x: 4, y: 10 },
      { x: 0, y: 10 },
    ],
  },
  {
    name: "polygon with a hole",
    outer: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ],
    holes: [
      [
        { x: 3, y: 3 },
        { x: 3, y: 7 },
        { x: 7, y: 7 },
        { x: 7, y: 3 },
      ],
    ],
  },
];

function trianglePoints(mesh: TriMesh, offset: number): [Vec2, Vec2, Vec2] {
  return [
    mesh.points[mesh.triangles[offset]],
    mesh.points[mesh.triangles[offset + 1]],
    mesh.points[mesh.triangles[offset + 2]],
  ];
}

function triangleArea(a: Vec2, b: Vec2, c: Vec2): number {
  return Math.abs(
    ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2,
  );
}

function assertValidMesh(testCase: PolygonCase, mesh: TriMesh): void {
  const holes = testCase.holes ?? [];
  let coveredArea = 0;
  const triangleKeys = new Set<string>();
  for (let i = 0; i < mesh.triangles.length; i += 3) {
    const indices = mesh.triangles.slice(i, i + 3);
    const key = indices.slice().sort((a, b) => a - b).join(":");
    expect(triangleKeys.has(key)).toBe(false);
    triangleKeys.add(key);
    const [a, b, c] = trianglePoints(mesh, i);
    const area = triangleArea(a, b, c);
    expect(area).toBeGreaterThan(1e-12);
    coveredArea += area;
    const centroid = {
      x: (a.x + b.x + c.x) / 3,
      y: (a.y + b.y + c.y) / 3,
    };
    expect(pointInPolygon(centroid, testCase.outer)).toBe(true);
    for (const hole of holes) expect(pointInPolygon(centroid, hole)).toBe(false);
  }
  const expectedArea =
    Math.abs(polygonArea(testCase.outer)) -
    holes.reduce((sum, hole) => sum + Math.abs(polygonArea(hole)), 0);
  expect(Math.abs(coveredArea - expectedArea) / expectedArea).toBeLessThan(1e-6);

  expect(mesh.boundary).toHaveLength(testCase.outer.length);
  testCase.outer.forEach((point, index) => {
    const mapped = mesh.boundary[index];
    expect(mapped).toBeGreaterThanOrEqual(0);
    expect(mesh.points[mapped]).toEqual(point);
  });
  expect(mesh.numBoundary).toBe(testCase.outer.length);
}

describe("constrained polygon triangulation", () => {
  for (const testCase of cases) {
    it(`triangulates the ${testCase.name} without leaving or overfilling the domain`, () => {
      const mesh = triangulate({
        outer: testCase.outer,
        holes: testCase.holes,
        spacing: 0,
      });
      assertValidMesh(testCase, mesh);
    });
  }

  it("treats undefined and zero spacing as boundary-only", () => {
    const outer = cases[0].outer;
    const implicit = triangulate({ outer });
    const zero = triangulate({ outer, spacing: 0 });
    expect(implicit.points).toHaveLength(outer.length);
    expect(zero.points).toHaveLength(outer.length);
    expect(implicit.triangles).toEqual(zero.triangles);
  });

  it("adds a direction-aligned Steiner grid only for positive spacing", () => {
    const outer = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const mesh = triangulate({
      outer,
      spacing: 2,
      grid: { x: 1, y: 1 },
    });
    expect(mesh.points.length).toBeGreaterThan(outer.length);
    assertValidMesh({ name: "Steiner square", outer }, mesh);
  });

  it("preserves and maps internal constraint points", () => {
    const outer = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const internalPoints = [
      { x: 2, y: 4 },
      { x: 8, y: 6 },
    ];
    const mesh = triangulate({ outer, internalPoints, spacing: 0 });
    expect(mesh.internal).toHaveLength(2);
    mesh.internal.forEach((mapped, index) => {
      expect(mapped).toBeGreaterThanOrEqual(0);
      expect(mesh.points[mapped]).toEqual(internalPoints[index]);
    });
    assertValidMesh({ name: "internal points", outer }, mesh);
  });

  it("returns only non-boundary edges as mesh diagonals", () => {
    const mesh = triangulate({ outer: cases[1].outer, spacing: 0 });
    const diagonals = meshDiagonals(mesh, cases[1].outer.length);
    expect(diagonals).toHaveLength(cases[1].outer.length - 3);
    const keys = new Set(diagonals.map(([a, b]) => `${Math.min(a, b)}:${Math.max(a, b)}`));
    expect(keys.size).toBe(diagonals.length);
  });

  it("does not misclassify hole boundary edges as mesh diagonals", () => {
    const testCase = cases[3];
    const mesh = triangulate({
      outer: testCase.outer,
      holes: testCase.holes,
      spacing: 0,
    });
    const diagonals = meshDiagonals(mesh, testCase.outer.length);
    const hole = testCase.holes?.[0] ?? [];
    const holeEdges = new Set<string>();
    for (let i = 0; i < hole.length; i += 1) {
      const a = hole[i];
      const b = hole[(i + 1) % hole.length];
      const ia = mesh.points.findIndex((point) => point.x === a.x && point.y === a.y);
      const ib = mesh.points.findIndex((point) => point.x === b.x && point.y === b.y);
      holeEdges.add(ia < ib ? `${ia}:${ib}` : `${ib}:${ia}`);
    }
    for (const [a, b] of diagonals) {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      expect(holeEdges.has(key)).toBe(false);
    }
  });

  it("maps triangulateFace output back to original global vertex indices", () => {
    const loop = [7, 2, 9, 4, 11, 6];
    const local = cases[0].outer;
    const coords: number[][] = Array.from({ length: 12 }, () => [0, 0]);
    loop.forEach((globalIndex, localIndex) => {
      coords[globalIndex] = [local[localIndex].x, local[localIndex].y];
    });
    const triangles = triangulateFace(loop, coords);
    expect(triangles).toHaveLength(loop.length - 2);
    for (const triangle of triangles) {
      for (const vertex of triangle) expect(loop).toContain(vertex);
    }
    const area = triangles.reduce((sum, [ia, ib, ic]) => {
      const a = { x: coords[ia][0], y: coords[ia][1] };
      const b = { x: coords[ib][0], y: coords[ib][1] };
      const c = { x: coords[ic][0], y: coords[ic][1] };
      return sum + triangleArea(a, b, c);
    }, 0);
    expect(area).toBeCloseTo(Math.abs(polygonArea(local)), 12);
  });
});
