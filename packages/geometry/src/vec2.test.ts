import { describe, expect, it } from "vitest";
import {
  add,
  cross,
  dist,
  dot,
  len,
  lerp,
  normalize,
  rotate,
  scale,
  sub,
} from "./index";

describe("Vec2 primitives", () => {
  it("performs vector arithmetic", () => {
    expect(add({ x: 2, y: 3 }, { x: -1, y: 4 })).toEqual({ x: 1, y: 7 });
    expect(sub({ x: 2, y: 3 }, { x: -1, y: 4 })).toEqual({ x: 3, y: -1 });
    expect(scale({ x: 2, y: -3 }, 2.5)).toEqual({ x: 5, y: -7.5 });
    expect(dot({ x: 2, y: 3 }, { x: -1, y: 4 })).toBe(10);
    expect(cross({ x: 2, y: 3 }, { x: -1, y: 4 })).toBe(11);
  });

  it("measures, normalizes, and interpolates vectors", () => {
    expect(len({ x: 3, y: 4 })).toBe(5);
    expect(dist({ x: 3, y: 4 }, { x: 0, y: 0 })).toBe(5);
    expect(normalize({ x: 3, y: 4 }).x).toBeCloseTo(0.6, 12);
    expect(normalize({ x: 3, y: 4 }).y).toBeCloseTo(0.8, 12);
    expect(normalize({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(lerp({ x: 0, y: 10 }, { x: 20, y: 0 }, 0.25)).toEqual({
      x: 5,
      y: 7.5,
    });
  });

  it("rotates about the origin or a supplied center", () => {
    const origin = rotate({ x: 2, y: 0 }, 90);
    expect(origin.x).toBeCloseTo(0, 12);
    expect(origin.y).toBeCloseTo(2, 12);
    const centered = rotate({ x: 2, y: 1 }, 180, { x: 1, y: 1 });
    expect(centered.x).toBeCloseTo(0, 12);
    expect(centered.y).toBeCloseTo(1, 12);
  });
});
