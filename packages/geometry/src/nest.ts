import { bounds, offsetPolygon, pointInPolygon, polygonArea } from "./polygon";
import { rotate } from "./vec2";
import type { Polygon, Polyline, Vec2 } from "./vec2";

export interface NestPlacement {
  index: number;
  offset: Vec2;
  rotationDeg: number;
}

export interface NestOptions {
  binWidth: number;
  binLength?: number;
  spacing: number;
  rotations: number[];
}

interface Variant {
  rotationDeg: number;
  poly: Polyline;
  inflated: Polyline;
  test: Polyline;
  sourceOffset: Vec2;
  width: number;
  height: number;
}

interface Placed {
  inflated: Polyline;
  test: Polyline;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const orient = (p: Vec2, q: Vec2, r: Vec2): number =>
    (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return (
    (o1 > 0) !== (o2 > 0) &&
    (o3 > 0) !== (o4 > 0)
  );
}

/** True when polygon interiors overlap; exact edge contact is allowed. */
function polygonsOverlap(a: Polyline, b: Polyline): boolean {
  const boxA = bounds(a);
  const boxB = bounds(b);
  if (
    boxA.maxX <= boxB.minX ||
    boxB.maxX <= boxA.minX ||
    boxA.maxY <= boxB.minY ||
    boxB.maxY <= boxA.minY
  ) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) {
      if (
        segmentsIntersect(
          a[i],
          a[(i + 1) % a.length],
          b[j],
          b[(j + 1) % b.length],
        )
      ) {
        return true;
      }
    }
  }
  return pointInPolygon(a[0], b) || pointInPolygon(b[0], a);
}

function translate(poly: Polyline, offset: Vec2): Polyline {
  return poly.map((point) => ({
    x: point.x + offset.x,
    y: point.y + offset.y,
  }));
}

function makeVariant(poly: Polyline, rotationDeg: number, spacing: number): Variant {
  const rotated = poly.map((point) => rotate(point, rotationDeg));
  const box = bounds(rotated);
  const sourceOffset = { x: -box.minX, y: -box.minY };
  const normalized = translate(rotated, sourceOffset);
  // Keep the source core's two offset copies: exact NFP contacts sit on the
  // inflated boundary, while a 2% under-inflated copy avoids rejecting those
  // contacts because of floating-point noise.
  const inflated =
    spacing > 0 ? offsetPolygon(normalized, spacing) : normalized.map((p) => ({ ...p }));
  const test =
    spacing > 0
      ? offsetPolygon(normalized, spacing * 0.98)
      : normalized.map((p) => ({ ...p }));
  return {
    rotationDeg,
    poly: normalized,
    inflated,
    test,
    sourceOffset,
    width: box.maxX - box.minX,
    height: box.maxY - box.minY,
  };
}

/**
 * Generic bottom-left true-shape nester ported from seamer's packing core.
 * Candidate positions come from already placed bounding-box corners and every
 * allowed rotation is evaluated at each position.
 */
export function nest(shapes: Polygon[], options: NestOptions): NestPlacement[] {
  const rotations = options.rotations.length > 0 ? options.rotations : [0];
  const spacing = Math.max(0, options.spacing);
  const margin = spacing;
  const prepared = shapes
    .map((shape, index) => ({
      index,
      area: Math.abs(polygonArea(shape.outer)),
      variants: rotations.map((rotationDeg) =>
        makeVariant(shape.outer, rotationDeg, spacing),
      ),
    }))
    .filter((item) => item.variants.some((variant) => variant.poly.length >= 3))
    .sort((a, b) => b.area - a.area || a.index - b.index);
  const placed: Placed[] = [];
  const placements: NestPlacement[] = [];
  for (const item of prepared) {
    const candidates: Vec2[] = [{ x: margin, y: margin }];
    for (const other of placed) {
      candidates.push(
        { x: other.maxX + margin, y: margin },
        { x: margin, y: other.maxY + margin },
        { x: other.maxX + margin, y: other.minY },
        { x: other.minX, y: other.maxY + margin },
      );
      // Port of nestCore's NFP vertex-contact candidates: q - p places a
      // candidate vertex p exactly against an already placed vertex q. These
      // are what allow small pieces to settle into concavities.
      for (const q of other.inflated) {
        for (const variant of item.variants) {
          for (const p of variant.poly) {
            candidates.push({ x: q.x - p.x, y: q.y - p.y });
          }
        }
      }
    }
    candidates.sort((a, b) => a.y - b.y || a.x - b.x);
    let best:
      | { position: Vec2; variant: Variant; score: number }
      | undefined;
    for (const candidate of candidates) {
      for (const variant of item.variants) {
        if (candidate.x < margin - 1e-9 || candidate.y < margin - 1e-9) continue;
        if (candidate.x + variant.width + margin > options.binWidth + 1e-9) continue;
        if (
          options.binLength !== undefined &&
          candidate.y + variant.height + margin > options.binLength + 1e-9
        ) {
          continue;
        }
        const search = translate(variant.poly, candidate);
        const searchBounds = bounds(search);
        if (
          placed.some(
            (other) =>
              !(
                searchBounds.maxX <= other.minX ||
                other.maxX <= searchBounds.minX ||
                searchBounds.maxY <= other.minY ||
                other.maxY <= searchBounds.minY
              ) && polygonsOverlap(search, other.test),
          )
        ) {
          continue;
        }
        const score = candidate.y + variant.height;
        if (
          !best ||
          score < best.score ||
          (score === best.score && candidate.x < best.position.x)
        ) {
          best = { position: candidate, variant, score };
        }
      }
    }
    if (!best) {
      if (options.binLength !== undefined) {
        throw new Error(`Shape ${item.index} does not fit in the configured nesting bin`);
      }
      const y =
        placed.length === 0 ? margin : Math.max(...placed.map((other) => other.maxY)) + margin;
      const variant = item.variants.find(
        (candidate) => candidate.width + spacing <= options.binWidth + 1e-9,
      );
      if (!variant) {
        throw new Error(`Shape ${item.index} is wider than the nesting bin`);
      }
      best = { position: { x: margin, y }, variant, score: y + variant.height };
    }
    const search = translate(best.variant.poly, best.position);
    const searchBounds = bounds(search);
    placed.push({
      inflated: translate(best.variant.inflated, best.position),
      test: translate(best.variant.test, best.position),
      minX: searchBounds.minX,
      minY: searchBounds.minY,
      maxX: searchBounds.maxX,
      maxY: searchBounds.maxY,
    });
    placements.push({
      index: item.index,
      offset: {
        x: best.position.x + best.variant.sourceOffset.x,
        y: best.position.y + best.variant.sourceOffset.y,
      },
      rotationDeg: best.variant.rotationDeg,
    });
  }
  return placements.sort((a, b) => a.index - b.index);
}
