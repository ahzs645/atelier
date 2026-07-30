import { describe, expect, it, vi } from "vitest";
import {
  nestSearch,
  offsetPolygon,
} from "./index";
import {
  searchPolygonsOverlap,
  simplifyClosedPolygon,
} from "./nestSearch";
import type {
  NestSearchItem,
  NestSearchOptions,
  Vec2,
} from "./index";

const square = (size: number): Vec2[] => [
  { x: 0, y: 0 },
  { x: size, y: 0 },
  { x: size, y: size },
  { x: 0, y: size },
];

const ell: Vec2[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 200, y: 100 },
  { x: 200, y: 200 },
  { x: 0, y: 200 },
];

function item(id: string, shape: Vec2[]): NestSearchItem {
  return { id, shape };
}

const options: NestSearchOptions = {
  binWidth: 220,
  spacing: 2,
  rotations: [0],
  generations: 0,
  population: 4,
  seed: 42,
  strategy: "nfp",
};

describe("nestSearch", () => {
  it("packs shapes without overlap and within the bin", () => {
    const items = Array.from({ length: 6 }, (_, index) =>
      item(`p${index}`, square(100)),
    );
    const layout = nestSearch(items, { ...options, binWidth: 320 });
    expect(layout.placements).toHaveLength(6);
    for (let i = 0; i < layout.placements.length; i += 1) {
      for (const point of layout.placements[i].shape) {
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(320);
      }
      for (let j = i + 1; j < layout.placements.length; j += 1) {
        expect(
          searchPolygonsOverlap(
            layout.placements[i].shape,
            layout.placements[j].shape,
          ),
        ).toBe(false);
      }
    }
  });

  it("tucks a shape into a concavity with the NFP strategy", () => {
    const items = [item("L", ell), item("square", square(90))];
    const nfp = nestSearch(items, options);
    const corners = nestSearch(items, { ...options, strategy: "corners" });

    expect(nfp.usedLength).toBeLessThan(280);
    expect(nfp.usedLength).toBeLessThan(corners.usedLength);
  });

  it("is fully deterministic for the same seed", () => {
    const items = Array.from({ length: 5 }, (_, index) =>
      item(`p${index}`, square(60 + index * 10)),
    );
    const searchOptions = {
      ...options,
      binWidth: 400,
      rotations: [0, 90, 180],
      generations: 3,
    };
    expect(nestSearch(items, searchOptions)).toEqual(
      nestSearch(items, searchOptions),
    );
  });

  it("respects spacing between shapes", () => {
    const layout = nestSearch(
      [item("a", square(50)), item("b", square(50))],
      { ...options, binWidth: 500, spacing: 8 },
    );
    const [first, second] = layout.placements.map(
      (placement) => placement.shape,
    );
    let minimum = Infinity;
    for (const a of first) {
      for (const b of second) {
        minimum = Math.min(
          minimum,
          Math.hypot(a.x - b.x, a.y - b.y),
        );
      }
    }
    expect(minimum).toBeGreaterThanOrEqual(7);
  });

  it("reports initial and per-generation progress", () => {
    const onProgress = vi.fn();
    nestSearch(
      [item("a", square(50)), item("b", square(40))],
      { ...options, generations: 3 },
      onProgress,
    );
    expect(onProgress).toHaveBeenCalledTimes(4);
    expect(onProgress.mock.calls.map(([progress]) => progress.generation)).toEqual(
      [0, 1, 2, 3],
    );
    expect(onProgress.mock.calls[3][0].efficiency).toBeGreaterThan(0);
  });

  it("spills overflow into multiple bins", () => {
    const items = Array.from({ length: 4 }, (_, index) =>
      item(`p${index}`, square(100)),
    );
    const layout = nestSearch(items, {
      ...options,
      binWidth: 120,
      spacing: 5,
      maxLength: 250,
    });

    expect(layout.bins).toHaveLength(2);
    for (const placement of layout.placements) {
      const bin = layout.bins?.[placement.binIndex];
      expect(bin).toBeDefined();
      for (const point of placement.shape) {
        expect(point.y).toBeGreaterThanOrEqual((bin?.start ?? 0) - 1e-6);
        expect(point.y).toBeLessThanOrEqual(
          (bin?.start ?? 0) + (bin?.usedLength ?? 0) + 1e-6,
        );
      }
    }
  });

  it("keeps unlimited searches in a single implicit bin", () => {
    const layout = nestSearch(
      Array.from({ length: 3 }, (_, index) =>
        item(`p${index}`, square(80)),
      ),
      { ...options, binWidth: 300 },
    );
    expect(layout.bins).toBeUndefined();
    expect(layout.placements.every((placement) => placement.binIndex === 0)).toBe(
      true,
    );
  });

  it("simplifies dense closed polygons while retaining corners", () => {
    const dense: Vec2[] = [];
    for (let i = 0; i <= 10; i += 1) dense.push({ x: i * 10, y: 0 });
    for (let i = 0; i <= 10; i += 1) dense.push({ x: 100, y: i * 10 });
    for (let i = 10; i >= 0; i -= 1) dense.push({ x: i * 10, y: 100 });
    for (let i = 10; i > 0; i -= 1) dense.push({ x: 0, y: i * 10 });

    const simplified = simplifyClosedPolygon(dense, 0.5);
    expect(simplified.length).toBeLessThan(10);
    expect(simplified.length).toBeGreaterThanOrEqual(4);
  });

  it("uses an outward polygon offset for spacing geometry", () => {
    const offset = offsetPolygon(square(100), 10);
    const x = offset.map((point) => point.x);
    const y = offset.map((point) => point.y);
    expect(Math.min(...x)).toBeCloseTo(-10, 5);
    expect(Math.max(...x)).toBeCloseTo(110, 5);
    expect(Math.min(...y)).toBeCloseTo(-10, 5);
    expect(Math.max(...y)).toBeCloseTo(110, 5);
  });
});
