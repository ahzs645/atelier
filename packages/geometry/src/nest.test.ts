import { describe, expect, it } from "vitest";
import { nest, rotate } from "./index";
import type { Polygon, Vec2 } from "./index";

function square(size: number): Polygon {
  return {
    outer: [
      { x: 0, y: 0 },
      { x: size, y: 0 },
      { x: size, y: size },
      { x: 0, y: size },
    ],
  };
}

function placedPolygon(shape: Polygon, offset: Vec2, rotationDeg: number): Vec2[] {
  return shape.outer.map((point) => {
    const rotated = rotate(point, rotationDeg);
    return { x: rotated.x + offset.x, y: rotated.y + offset.y };
  });
}

function overlap(a: Vec2[], b: Vec2[]): boolean {
  const minAx = Math.min(...a.map((point) => point.x));
  const maxAx = Math.max(...a.map((point) => point.x));
  const minAy = Math.min(...a.map((point) => point.y));
  const maxAy = Math.max(...a.map((point) => point.y));
  const minBx = Math.min(...b.map((point) => point.x));
  const maxBx = Math.max(...b.map((point) => point.x));
  const minBy = Math.min(...b.map((point) => point.y));
  const maxBy = Math.max(...b.map((point) => point.y));
  return minAx < maxBx && minBx < maxAx && minAy < maxBy && minBy < maxAy;
}

describe("nest", () => {
  it("places every shape within the bin without overlap", () => {
    const shapes = Array.from({ length: 6 }, () => square(100));
    const placements = nest(shapes, {
      binWidth: 320,
      spacing: 10,
      rotations: [0],
    });
    expect(placements).toHaveLength(6);
    const polygons = placements.map((placement) =>
      placedPolygon(
        shapes[placement.index],
        placement.offset,
        placement.rotationDeg,
      ),
    );
    for (const poly of polygons) {
      expect(Math.min(...poly.map((point) => point.x))).toBeGreaterThanOrEqual(0);
      expect(Math.max(...poly.map((point) => point.x))).toBeLessThanOrEqual(320);
    }
    for (let i = 0; i < polygons.length; i += 1) {
      for (let j = i + 1; j < polygons.length; j += 1) {
        expect(overlap(polygons[i], polygons[j])).toBe(false);
      }
    }
  });

  it("uses allowed rotation to fit a rectangular shape", () => {
    const rectangle: Polygon = {
      outer: [
        { x: 0, y: 0 },
        { x: 80, y: 0 },
        { x: 80, y: 30 },
        { x: 0, y: 30 },
      ],
    };
    const [placement] = nest([rectangle], {
      binWidth: 40,
      binLength: 100,
      spacing: 0,
      rotations: [0, 90],
    });
    expect(placement.rotationDeg).toBe(90);
  });

  it("is deterministic and preserves source indices", () => {
    const shapes = [square(20), square(40), square(30)];
    const options = { binWidth: 100, spacing: 2, rotations: [0, 180] };
    expect(nest(shapes, options)).toEqual(nest(shapes, options));
    expect(nest(shapes, options).map((placement) => placement.index)).toEqual([0, 1, 2]);
  });

  it("uses vertex-contact candidates to tuck a square into an L-shaped concavity", () => {
    const ell: Polygon = {
      outer: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 200, y: 100 },
        { x: 200, y: 200 },
        { x: 0, y: 200 },
      ],
    };
    const shapes = [ell, square(90)];
    const placements = nest(shapes, {
      binWidth: 220,
      spacing: 2,
      rotations: [0],
    });
    const squarePlacement = placements[1];
    const squarePoly = placedPolygon(
      shapes[1],
      squarePlacement.offset,
      squarePlacement.rotationDeg,
    );
    expect(Math.max(...squarePoly.map((point) => point.y))).toBeLessThan(205);
  });

  it("rejects shapes that cannot fit a finite bin", () => {
    expect(() =>
      nest([square(50)], {
        binWidth: 40,
        binLength: 40,
        spacing: 0,
        rotations: [0],
      }),
    ).toThrow(/does not fit/);
  });
});
