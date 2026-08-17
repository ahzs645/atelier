// The engine's document convention is mathematical Y-up (ARCHITECTURE D5), but
// LeatherCad stores document coordinates Y-down and projects straight to screen.
// Rather than force a conversion layer at every call site, these tests pin the
// property that makes direct consumption safe: the polygon and polyline helpers
// are *equivariant* under a Y flip — flipping the input flips the output and
// nothing else. Breaking any of these silently corrupts a Y-down consumer, so
// they are part of the package contract, not incidental behavior.
import { describe, expect, it } from "vitest";
import {
  applyCornerJoins,
  bounds,
  offsetPolygon,
  offsetPolygonVariable,
  pointInPolygon,
  polygonArea,
  polygonCentroid,
  polylineLength,
  resamplePolyline,
  simplifyPolyline,
} from "./index";
import type { Polyline, Vec2 } from "./index";

const flip = (p: Polyline): Polyline => p.map((v) => ({ x: v.x, y: -v.y }));
const flip1 = (v: Vec2): Vec2 => ({ x: v.x, y: -v.y });

function expectNear(a: Polyline, b: Polyline, eps = 1e-6): void {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => {
    expect(v.x).toBeCloseTo(b[i].x, 6);
    expect(v.y).toBeCloseTo(b[i].y, 6);
  });
  void eps;
}

// Asymmetric, non-convex, authored clockwise in a Y-down frame.
const P: Polyline = [
  { x: 0, y: 0 },
  { x: 100, y: 10 },
  { x: 120, y: 60 },
  { x: 60, y: 45 },
  { x: 30, y: 90 },
  { x: -10, y: 40 },
];

describe("Y-flip equivariance", () => {
  it("polygonArea flips sign but preserves magnitude", () => {
    // The one function whose *sign* is convention-dependent. Consumers that
    // branch on the sign (rather than on |area|) must account for their frame.
    expect(polygonArea(flip(P))).toBeCloseTo(-polygonArea(P), 9);
    expect(Math.abs(polygonArea(flip(P)))).toBeCloseTo(Math.abs(polygonArea(P)), 9);
  });

  it("polygonCentroid is equivariant", () => {
    const c = polygonCentroid(P);
    const cf = polygonCentroid(flip(P));
    expect(cf.x).toBeCloseTo(c.x, 9);
    expect(cf.y).toBeCloseTo(-c.y, 9);
  });

  it("offsetPolygon is equivariant — outward stays outward in either frame", () => {
    // offsetPolygon derives its normals from the polygon's own winding
    // (ccw = polygonArea > 0), so a mirrored polygon offsets mirrored. This is
    // what lets a Y-down consumer compute seam allowances without converting.
    for (const distance of [5, -5, 12.5]) {
      expectNear(offsetPolygon(flip(P), distance), flip(offsetPolygon(P, distance)));
    }
  });

  it("offsetPolygonVariable is equivariant", () => {
    const dists = [5, 8, 2, 9, 4, 6];
    const distOf = (i: number): number => dists[i % dists.length];
    expectNear(offsetPolygonVariable(flip(P), distOf), flip(offsetPolygonVariable(P, distOf)));
  });

  it("applyCornerJoins is equivariant", () => {
    for (const join of [
      { type: "intersection" } as const,
      { type: "radius", radius: 4 } as const,
      { type: "byLength", length: 3 } as const,
    ]) {
      const a = applyCornerJoins(offsetPolygon(P, 6), P, () => join, 6);
      const b = applyCornerJoins(offsetPolygon(flip(P), 6), flip(P), () => join, 6);
      expectNear(b, flip(a));
    }
  });

  it("pointInPolygon is invariant", () => {
    const probes: Vec2[] = [
      { x: 50, y: 30 },
      { x: 5, y: 5 },
      { x: 200, y: 200 },
      { x: 60, y: 44 },
      { x: 20, y: 60 },
    ];
    for (const q of probes) {
      expect(pointInPolygon(flip1(q), flip(P))).toBe(pointInPolygon(q, P));
    }
  });

  it("length, resampling and simplification are equivariant", () => {
    expect(polylineLength(flip(P))).toBeCloseTo(polylineLength(P), 9);
    expectNear(resamplePolyline(flip(P), 7), flip(resamplePolyline(P, 7)));
    expectNear(simplifyPolyline(flip(P), 3), flip(simplifyPolyline(P, 3)));
  });

  it("bounds swap min/max on the flipped axis", () => {
    const b = bounds(P);
    const bf = bounds(flip(P));
    expect(bf.minX).toBeCloseTo(b.minX, 9);
    expect(bf.maxX).toBeCloseTo(b.maxX, 9);
    expect(bf.minY).toBeCloseTo(-b.maxY, 9);
    expect(bf.maxY).toBeCloseTo(-b.minY, 9);
  });
});
