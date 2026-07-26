import { describe, expect, it } from "vitest";
import {
  applyCornerJoins,
  bounds,
  boundsUnion,
  convexHull,
  offsetPolygon,
  offsetPolygonVariable,
  pointInPolygon,
  polygonArea,
  polygonCentroid,
  polylineLength,
  reflectAcrossLine,
  resamplePolyline,
  simplifyPolyline,
} from "./index";
import type { Vec2 } from "./index";

const square: Vec2[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];

describe("polylines and polygons", () => {
  it("computes bounds, union, lengths, signed area, and the ported centroid", () => {
    expect(bounds(square)).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
    expect(
      boundsUnion(bounds(square), { minX: -3, minY: 2, maxX: 4, maxY: 20 }),
    ).toEqual({ minX: -3, minY: 0, maxX: 10, maxY: 20 });
    expect(polylineLength(square)).toBe(30);
    expect(polygonArea(square)).toBe(100);
    expect(polygonArea(square.slice().reverse())).toBe(-100);
    expect(polygonCentroid(square)).toEqual({ x: 5, y: 5 });
  });

  it("resamples evenly and simplifies with Douglas-Peucker", () => {
    expect(
      resamplePolyline(
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
        ],
        5,
      ),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
      { x: 10, y: 10 },
    ]);
    expect(
      simplifyPolyline(
        [
          { x: 0, y: 0 },
          { x: 5, y: 0.1 },
          { x: 10, y: 0 },
        ],
        0.5,
      ),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
  });

  it("tests containment, reflection, and convex hulls", () => {
    expect(pointInPolygon({ x: 5, y: 5 }, square)).toBe(true);
    expect(pointInPolygon({ x: 15, y: 5 }, square)).toBe(false);
    expect(
      reflectAcrossLine({ x: 2, y: 3 }, { x: 0, y: 0 }, { x: 1, y: 0 }),
    ).toEqual({ x: 2, y: -3 });
    expect(
      convexHull([...square, { x: 5, y: 5 }, { x: 0, y: 0 }]),
    ).toEqual(square);
  });

  it("offsets either winding outward with a miter limit", () => {
    for (const loop of [square, square.slice().reverse()]) {
      const out = offsetPolygon(loop, 2);
      const box = bounds(out);
      expect(box.minX).toBeCloseTo(-2, 10);
      expect(box.minY).toBeCloseTo(-2, 10);
      expect(box.maxX).toBeCloseTo(12, 10);
      expect(box.maxY).toBeCloseTo(12, 10);
    }
  });

  it("supports per-edge offset widths", () => {
    const out = offsetPolygonVariable(square, (edge) => edge + 1);
    expect(bounds(out)).toEqual({ minX: -4, minY: -1, maxX: 12, maxY: 13 });
  });

  it("ports seam-allowance chamfer and no-join corner behavior", () => {
    const allowance = offsetPolygon(square, 2);
    const chamfered = applyCornerJoins(
      allowance,
      square,
      (corner) => (corner.x === 0 && corner.y === 0 ? { type: "byLength", length: 1 } : null),
      2,
    );
    expect(chamfered.length).toBe(5);
    const pinched = applyCornerJoins(
      allowance,
      square,
      (corner) => (corner.x === 0 && corner.y === 0 ? { type: "noJoin" } : null),
      2,
    );
    expect(pinched.some((point) => point.x === 0 && point.y === 0)).toBe(true);
  });
});
