// Known defect, recorded rather than hidden.
//
// `triangulate` throws "Delaunator could not recover all polygon constraints
// without an incomplete mesh" for *simple, valid, non-convex* polygons at some
// Steiner spacings. The failure is not a winding or Y-convention problem — the
// same polygon fails in all four orientations (both windings x both mirrors) —
// and it is not monotonic in spacing, which is the tell that constraint
// recovery is fragile rather than the mesh being too fine:
//
//     L-shape   spacing 5 THROW  10 THROW  15 THROW  20 ok  25 ok
//                       30 THROW  40 ok  50 ok  100 ok
//     star      spacing 5..30 THROW, 40+ ok
//     comb      spacing 5..20 THROW, 25+ ok
//     square+square hole @ spacing 10 THROW, 20 ok
//
// This matters most to simulation consumers, which triangulate non-convex
// pattern pieces at fine particle spacings — exactly the failing region.
//
// `it.fails` passes while the bug is present and starts failing the moment it
// is fixed, at which point these should become ordinary assertions.
import { describe, expect, it } from "vitest";
import { triangulate } from "./index";
import type { Polyline } from "./index";

const L_SHAPE: Polyline = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 40 },
  { x: 40, y: 40 },
  { x: 40, y: 100 },
  { x: 0, y: 100 },
];

const STAR: Polyline = (() => {
  const pts: Polyline = [];
  for (let i = 0; i < 10; i += 1) {
    const r = i % 2 === 0 ? 60 : 25;
    const a = (Math.PI * 2 * i) / 10 - Math.PI / 2;
    pts.push({ x: 60 + r * Math.cos(a), y: 60 + r * Math.sin(a) });
  }
  return pts;
})();

const SQUARE: Polyline = [
  { x: 0, y: 0 },
  { x: 120, y: 0 },
  { x: 120, y: 120 },
  { x: 0, y: 120 },
];

const SQUARE_HOLE: Polyline = [
  { x: 40, y: 40 },
  { x: 40, y: 80 },
  { x: 80, y: 80 },
  { x: 80, y: 40 },
];

describe("triangulate — convex input is solid", () => {
  it("meshes a convex polygon at every spacing", () => {
    for (const spacing of [5, 10, 20, 40, 100]) {
      const mesh = triangulate({ outer: SQUARE, spacing });
      expect(mesh.triangles.length).toBeGreaterThan(0);
    }
  });
});

describe("triangulate — known non-convex constraint-recovery defect", () => {
  it.fails("meshes an L-shape at spacing 10", () => {
    triangulate({ outer: L_SHAPE, spacing: 10 });
  });

  it.fails("meshes an L-shape at spacing 30 (non-monotonic: 20 and 25 succeed)", () => {
    triangulate({ outer: L_SHAPE, spacing: 30 });
  });

  it.fails("meshes a star at spacing 20", () => {
    triangulate({ outer: STAR, spacing: 20 });
  });

  it.fails("meshes a square with a square hole at spacing 10", () => {
    triangulate({ outer: SQUARE, holes: [SQUARE_HOLE], spacing: 10 });
  });

  it("still succeeds in the coarser region, confirming the input is valid", () => {
    expect(triangulate({ outer: L_SHAPE, spacing: 20 }).triangles.length).toBeGreaterThan(0);
    expect(triangulate({ outer: STAR, spacing: 40 }).triangles.length).toBeGreaterThan(0);
    expect(
      triangulate({ outer: SQUARE, holes: [SQUARE_HOLE], spacing: 20 }).triangles.length,
    ).toBeGreaterThan(0);
  });
});
