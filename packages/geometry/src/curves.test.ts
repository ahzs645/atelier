import { describe, expect, it } from "vitest";
import {
  cubicAt,
  cubicLength,
  cubicTangentAt,
  flattenCubic,
} from "./index";
import type { CubicSegment } from "./index";

const line: CubicSegment = {
  p0: { x: 0, y: 0 },
  c0: { x: 10 / 3, y: 0 },
  c1: { x: 20 / 3, y: 0 },
  p1: { x: 10, y: 0 },
};

describe("cubic curves", () => {
  it("evaluates endpoints, tangents, and sampled length", () => {
    expect(cubicAt(line, 0)).toEqual(line.p0);
    expect(cubicAt(line, 1)).toEqual(line.p1);
    expect(cubicAt(line, 0.5).x).toBeCloseTo(5, 12);
    expect(cubicTangentAt(line, 0.5)).toEqual({ x: 10, y: 0 });
    expect(cubicLength(line)).toBeCloseTo(10, 10);
  });

  it("adaptively flattens within tighter tolerances", () => {
    const curve: CubicSegment = {
      p0: { x: 0, y: 0 },
      c0: { x: 0, y: 100 },
      c1: { x: 100, y: 100 },
      p1: { x: 100, y: 0 },
    };
    const coarse = flattenCubic(curve, 20);
    const fine = flattenCubic(curve, 0.5);
    expect(coarse[0]).toEqual(curve.p0);
    expect(coarse.at(-1)).toEqual(curve.p1);
    expect(fine.length).toBeGreaterThan(coarse.length);
  });
});
