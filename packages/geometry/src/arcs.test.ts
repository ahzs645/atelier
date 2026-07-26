import { describe, expect, it } from "vitest";
import { arcToPolyline, threePointArc } from "./index";

describe("arcs", () => {
  it("builds the circumcircle arc through all three points", () => {
    const arc = threePointArc(
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: -1, y: 0 },
    );
    expect(arc).not.toBeNull();
    expect(arc?.center.x).toBeCloseTo(0, 12);
    expect(arc?.center.y).toBeCloseTo(0, 12);
    expect(arc?.radius).toBeCloseTo(1, 12);
    expect((arc?.endDeg ?? 0) - (arc?.startDeg ?? 0)).toBeCloseTo(180, 12);
  });

  it("chooses a clockwise sweep when the middle point requires it", () => {
    const arc = threePointArc(
      { x: 1, y: 0 },
      { x: 0, y: -1 },
      { x: -1, y: 0 },
    );
    expect((arc?.endDeg ?? 0) - (arc?.startDeg ?? 0)).toBeCloseTo(-180, 12);
  });

  it("returns null for collinear three-point arcs", () => {
    expect(
      threePointArc({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }),
    ).toBeNull();
  });

  it("flattens with exact endpoints and a tolerance-controlled point count", () => {
    const arc = { center: { x: 0, y: 0 }, radius: 100, startDeg: 0, endDeg: 90 };
    const coarse = arcToPolyline(arc, 10);
    const fine = arcToPolyline(arc, 0.1);
    expect(coarse[0]).toEqual({ x: 100, y: 0 });
    expect(coarse.at(-1)?.x).toBeCloseTo(0, 12);
    expect(coarse.at(-1)?.y).toBeCloseTo(100, 12);
    expect(fine.length).toBeGreaterThan(coarse.length);
  });
});
