import { describe, expect, it } from "vitest";
import { buildWarp } from "./index";
import type { MatchPair } from "./index";

describe("thin-plate-spline warp", () => {
  it("uses identity for zero pairs", () => {
    expect(buildWarp([])({ x: 12, y: -3 })).toEqual({ x: 12, y: -3 });
  });

  it("uses translation for one pair", () => {
    const warp = buildWarp([
      { src: { x: 10, y: 10 }, dst: { x: 30, y: -5 } },
    ]);
    expect(warp({ x: 0, y: 0 })).toEqual({ x: 20, y: -15 });
  });

  it("uses a similarity transform for two pairs", () => {
    const warp = buildWarp([
      { src: { x: 0, y: 0 }, dst: { x: 0, y: 0 } },
      { src: { x: 10, y: 0 }, dst: { x: 0, y: 20 } },
    ]);
    const along = warp({ x: 5, y: 0 });
    expect(along.x).toBeCloseTo(0, 6);
    expect(along.y).toBeCloseTo(10, 6);
    const perpendicular = warp({ x: 0, y: 5 });
    expect(perpendicular.x).toBeCloseTo(-10, 6);
    expect(perpendicular.y).toBeCloseTo(0, 6);
  });

  it("interpolates every TPS control point", () => {
    const pairs: MatchPair[] = [
      { src: { x: 0, y: 0 }, dst: { x: 3, y: -2 } },
      { src: { x: 100, y: 0 }, dst: { x: 104, y: 1 } },
      { src: { x: 100, y: 100 }, dst: { x: 98, y: 103 } },
      { src: { x: 0, y: 100 }, dst: { x: -1, y: 99 } },
      { src: { x: 50, y: 50 }, dst: { x: 53, y: 49 } },
    ];
    const warp = buildWarp(pairs);
    for (const { src, dst } of pairs) {
      const point = warp(src);
      expect(point.x).toBeCloseTo(dst.x, 3);
      expect(point.y).toBeCloseTo(dst.y, 3);
    }
  });

  it("reproduces an affine map from affine pairs", () => {
    const warp = buildWarp([
      { src: { x: 0, y: 0 }, dst: { x: 10, y: 20 } },
      { src: { x: 100, y: 0 }, dst: { x: 210, y: 20 } },
      { src: { x: 0, y: 100 }, dst: { x: 10, y: 220 } },
    ]);
    const point = warp({ x: 50, y: 50 });
    expect(point.x).toBeCloseTo(110, 3);
    expect(point.y).toBeCloseTo(120, 3);
  });
});
