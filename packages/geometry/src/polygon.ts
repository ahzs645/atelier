import { dist } from "./vec2";
import type { Bounds2, Polyline, Vec2 } from "./vec2";

export function bounds(points: Polyline): Bounds2 {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { minX, minY, maxX, maxY };
}

export function boundsUnion(a: Bounds2, b: Bounds2): Bounds2 {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

export function polylineLength(poly: Polyline): number {
  let length = 0;
  for (let i = 1; i < poly.length; i += 1) length += dist(poly[i - 1], poly[i]);
  return length;
}

/** Resample an open polyline to exactly `n` points, evenly spaced by arc length. */
export function resamplePolyline(poly: Polyline, n: number): Polyline {
  if (poly.length === 0 || n <= 0) return [];
  if (poly.length === 1 || n === 1) {
    return new Array(n).fill(0).map(() => ({ ...poly[0] }));
  }
  const cumulative: number[] = [0];
  for (let i = 1; i < poly.length; i += 1) {
    cumulative.push(cumulative[i - 1] + dist(poly[i - 1], poly[i]));
  }
  const total = cumulative[cumulative.length - 1];
  if (total === 0) return new Array(n).fill(0).map(() => ({ ...poly[0] }));
  const out: Polyline = [];
  let segment = 0;
  for (let i = 0; i < n; i += 1) {
    const target = (total * i) / (n - 1);
    while (
      segment < poly.length - 2 &&
      cumulative[segment + 1] < target
    ) {
      segment += 1;
    }
    const segmentLength = cumulative[segment + 1] - cumulative[segment];
    const t = segmentLength === 0 ? 0 : (target - cumulative[segment]) / segmentLength;
    out.push({
      x: poly[segment].x + (poly[segment + 1].x - poly[segment].x) * t,
      y: poly[segment].y + (poly[segment + 1].y - poly[segment].y) * t,
    });
  }
  return out;
}

function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return dist(p, a);
  const projected = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared;
  const t = Math.max(0, Math.min(1, projected));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Douglas-Peucker simplification of an open polyline (endpoints are retained). */
export function simplifyPolyline(poly: Polyline, tolerance: number): Polyline {
  if (poly.length <= 2 || tolerance <= 0) return poly.slice();
  const keep = new Uint8Array(poly.length);
  keep[0] = 1;
  keep[poly.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, poly.length - 1]];
  while (stack.length > 0) {
    const pair = stack.pop();
    if (!pair) break;
    const [start, end] = pair;
    let worst = -1;
    let worstDistance = tolerance;
    for (let i = start + 1; i < end; i += 1) {
      const distance = distanceToSegment(poly[i], poly[start], poly[end]);
      if (distance > worstDistance) {
        worstDistance = distance;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([start, worst], [worst, end]);
    }
  }
  return poly.filter((_point, index) => keep[index] === 1);
}

/** Signed shoelace area. Counter-clockwise loops have positive area. */
export function polygonArea(poly: Polyline): number {
  let twiceArea = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    twiceArea += a.x * b.y - b.x * a.y;
  }
  return twiceArea / 2;
}

/** Arithmetic mean of polygon vertices, preserving seamer's existing behavior. */
export function polygonCentroid(poly: Polyline): Vec2 {
  if (poly.length === 0) return { x: 0, y: 0 };
  const sum = poly.reduce(
    (result, point) => ({ x: result.x + point.x, y: result.y + point.y }),
    { x: 0, y: 0 },
  );
  return { x: sum.x / poly.length, y: sum.y / poly.length };
}

export function pointInPolygon(p: Vec2, poly: Polyline): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const a = poly[i];
    const b = poly[j];
    if (
      (a.y > p.y) !== (b.y > p.y) &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** Andrew monotone-chain hull, counter-clockwise and not explicitly closed. */
export function convexHull(points: Vec2[]): Polyline {
  const sorted = points
    .slice()
    .sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const unique: Vec2[] = [];
  for (const point of sorted) {
    const previous = unique[unique.length - 1];
    if (!previous || previous.x !== point.x || previous.y !== point.y) unique.push(point);
  }
  if (unique.length < 3) return unique;
  const turn = (o: Vec2, a: Vec2, b: Vec2): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec2[] = [];
  for (const point of unique) {
    while (
      lower.length >= 2 &&
      turn(lower[lower.length - 2], lower[lower.length - 1], point) <= 0
    ) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper: Vec2[] = [];
  for (let i = unique.length - 1; i >= 0; i -= 1) {
    const point = unique[i];
    while (
      upper.length >= 2 &&
      turn(upper[upper.length - 2], upper[upper.length - 1], point) <= 0
    ) {
      upper.pop();
    }
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Reflect a point across the infinite line through a and b. */
export function reflectAcrossLine(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-9) return { x: 2 * a.x - p.x, y: 2 * a.y - p.y };
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared;
  const footX = a.x + t * dx;
  const footY = a.y + t * dy;
  return { x: 2 * footX - p.x, y: 2 * footY - p.y };
}

/** Miter offset ported from seamer; positive distance grows either winding. */
export function offsetPolygon(poly: Polyline, distance: number, miterLimit = 4): Polyline {
  const count = poly.length;
  if (count < 3 || distance === 0) return poly.map((point) => ({ ...point }));
  const ccw = polygonArea(poly) > 0;
  const unit = (x: number, y: number): Vec2 => {
    const length = Math.hypot(x, y) || 1;
    return { x: x / length, y: y / length };
  };
  const out: Polyline = [];
  for (let i = 0; i < count; i += 1) {
    const previous = poly[(i - 1 + count) % count];
    const current = poly[i];
    const next = poly[(i + 1) % count];
    const edge0 = unit(current.x - previous.x, current.y - previous.y);
    const edge1 = unit(next.x - current.x, next.y - current.y);
    const normal0 = ccw
      ? { x: edge0.y, y: -edge0.x }
      : { x: -edge0.y, y: edge0.x };
    const normal1 = ccw
      ? { x: edge1.y, y: -edge1.x }
      : { x: -edge1.y, y: edge1.x };
    const denominator = 1 + normal0.x * normal1.x + normal0.y * normal1.y;
    let offset: Vec2;
    if (Math.abs(denominator) < 1e-4) {
      offset = { x: normal0.x * distance, y: normal0.y * distance };
    } else {
      offset = {
        x: (distance * (normal0.x + normal1.x)) / denominator,
        y: (distance * (normal0.y + normal1.y)) / denominator,
      };
      const cap = Math.abs(distance) * miterLimit;
      const offsetLength = Math.hypot(offset.x, offset.y);
      if (offsetLength > cap && offsetLength > 0) {
        offset.x = (offset.x * cap) / offsetLength;
        offset.y = (offset.y * cap) / offsetLength;
      }
    }
    out.push({ x: current.x + offset.x, y: current.y + offset.y });
  }
  return out;
}

function intersectLines(p0: Vec2, d0: Vec2, p1: Vec2, d1: Vec2): Vec2 | null {
  const denominator = d0.x * d1.y - d0.y * d1.x;
  if (Math.abs(denominator) < 1e-9) return null;
  const t = ((p1.x - p0.x) * d1.y - (p1.y - p0.y) * d1.x) / denominator;
  return { x: p0.x + d0.x * t, y: p0.y + d0.y * t };
}

export function offsetPolygonVariable(
  poly: Polyline,
  distOf: (edgeIndex: number) => number,
  miterLimit = 4,
): Polyline {
  const count = poly.length;
  if (count < 3) return poly.map((point) => ({ ...point }));
  const ccw = polygonArea(poly) > 0;
  const unit = (x: number, y: number): Vec2 => {
    const length = Math.hypot(x, y) || 1;
    return { x: x / length, y: y / length };
  };
  const lines: Array<{ point: Vec2; direction: Vec2; normal: Vec2 }> = [];
  for (let i = 0; i < count; i += 1) {
    const a = poly[i];
    const b = poly[(i + 1) % count];
    const direction = unit(b.x - a.x, b.y - a.y);
    const normal = ccw
      ? { x: direction.y, y: -direction.x }
      : { x: -direction.y, y: direction.x };
    const distance = distOf(i);
    lines.push({
      point: { x: a.x + normal.x * distance, y: a.y + normal.y * distance },
      direction,
      normal,
    });
  }
  const out: Polyline = [];
  for (let i = 0; i < count; i += 1) {
    const previous = lines[(i - 1 + count) % count];
    const current = lines[i];
    const intersection = intersectLines(
      previous.point,
      previous.direction,
      current.point,
      current.direction,
    );
    if (!intersection) {
      out.push({
        x: poly[i].x + current.normal.x * distOf(i),
        y: poly[i].y + current.normal.y * distOf(i),
      });
      continue;
    }
    const distance = dist(intersection, poly[i]);
    const cap =
      Math.max(
        Math.abs(distOf((i - 1 + count) % count)),
        Math.abs(distOf(i)),
      ) * miterLimit;
    if (cap > 0 && distance > cap) {
      out.push({
        x: poly[i].x + ((intersection.x - poly[i].x) / distance) * cap,
        y: poly[i].y + ((intersection.y - poly[i].y) / distance) * cap,
      });
    } else {
      out.push(intersection);
    }
  }
  return out;
}

export interface CornerJoin {
  type:
    | "intersection"
    | "radius"
    | "byLength"
    | "noJoin"
    | "firstEdgeSymmetry"
    | "secondEdgeSymmetry"
    | "firstEdgeRightAngle"
    | "secondEdgeRightAngle";
  radius?: number;
  maxLength?: number;
  length?: number;
}

function unitFrom(from: Vec2, to: Vec2): Vec2 {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  return { x: dx / length, y: dy / length };
}

/**
 * Rewrite seam-allowance corners using seamer's full Valentina-derived join
 * vocabulary. `allow` must have one vertex per `outline` vertex.
 */
export function applyCornerJoins(
  allow: Polyline,
  outline: Polyline,
  joinFor: (corner: Vec2) => CornerJoin | null,
  baseDist: number,
): Polyline {
  const count = allow.length;
  if (count < 3 || outline.length !== count) return allow;
  const out: Polyline = [];
  for (let i = 0; i < count; i += 1) {
    const current = allow[i];
    const previous = allow[(i - 1 + count) % count];
    const next = allow[(i + 1) % count];
    const join = joinFor(outline[i]);
    if (!join) {
      out.push(current);
      continue;
    }
    const unit1 = unitFrom(current, previous);
    const unit2 = unitFrom(current, next);
    const previousLength = dist(previous, current);
    const nextLength = dist(next, current);
    const cosine = Math.max(-1, Math.min(1, unit1.x * unit2.x + unit1.y * unit2.y));
    const halfAngle = Math.acos(cosine) / 2;

    if (
      join.type === "radius" &&
      (join.radius ?? 0) > 0.01 &&
      halfAngle > 0.01 &&
      halfAngle < Math.PI / 2 - 0.01
    ) {
      const radius = join.radius ?? 0;
      let tangent = radius / Math.tan(halfAngle);
      tangent = Math.min(tangent, previousLength * 0.98, nextLength * 0.98);
      if (tangent <= 0.01) {
        out.push(current);
        continue;
      }
      const p1 = {
        x: current.x + unit1.x * tangent,
        y: current.y + unit1.y * tangent,
      };
      const p2 = {
        x: current.x + unit2.x * tangent,
        y: current.y + unit2.y * tangent,
      };
      const bisector = unitFrom(
        { x: 0, y: 0 },
        { x: unit1.x + unit2.x, y: unit1.y + unit2.y },
      );
      const effectiveRadius = tangent * Math.tan(halfAngle);
      const center = {
        x: current.x + bisector.x * (effectiveRadius / Math.sin(halfAngle)),
        y: current.y + bisector.y * (effectiveRadius / Math.sin(halfAngle)),
      };
      const start = Math.atan2(p1.y - center.y, p1.x - center.x);
      let sweep = Math.atan2(p2.y - center.y, p2.x - center.x) - start;
      while (sweep > Math.PI) sweep -= 2 * Math.PI;
      while (sweep < -Math.PI) sweep += 2 * Math.PI;
      const steps = Math.max(2, Math.ceil(Math.abs(sweep) / 0.4));
      for (let step = 0; step <= steps; step += 1) {
        const angle = start + (sweep * step) / steps;
        out.push({
          x: center.x + Math.cos(angle) * effectiveRadius,
          y: center.y + Math.sin(angle) * effectiveRadius,
        });
      }
      continue;
    }

    if (join.type === "byLength" && (join.length ?? 0) > 0.01) {
      const length = Math.min(
        join.length ?? 0,
        previousLength * 0.98,
        nextLength * 0.98,
      );
      if (length <= 0.01) {
        out.push(current);
        continue;
      }
      out.push(
        { x: current.x + unit1.x * length, y: current.y + unit1.y * length },
        { x: current.x + unit2.x * length, y: current.y + unit2.y * length },
      );
      continue;
    }

    if (join.type === "intersection" && (join.maxLength ?? 0) > 0.01) {
      const corner = outline[i];
      const miterDistance = dist(current, corner);
      const cap = baseDist + (join.maxLength ?? 0);
      if (miterDistance > cap && miterDistance > 0.01) {
        out.push({
          x: corner.x + ((current.x - corner.x) / miterDistance) * cap,
          y: corner.y + ((current.y - corner.y) / miterDistance) * cap,
        });
        continue;
      }
    }

    if (
      join.type === "noJoin" ||
      join.type === "firstEdgeSymmetry" ||
      join.type === "secondEdgeSymmetry" ||
      join.type === "firstEdgeRightAngle" ||
      join.type === "secondEdgeRightAngle"
    ) {
      const before = outline[(i - 1 + count) % count];
      const corner = outline[i];
      const after = outline[(i + 1) % count];
      const direction1 = unitFrom(previous, current);
      const direction2 = unitFrom(current, next);
      const valid = (point: Vec2 | null): point is Vec2 =>
        point !== null && dist(point, corner) <= baseDist * 3.4;
      if (join.type === "noJoin") {
        const project = (origin: Vec2, direction: Vec2): Vec2 => {
          const t =
            (corner.x - origin.x) * direction.x +
            (corner.y - origin.y) * direction.y;
          return { x: origin.x + direction.x * t, y: origin.y + direction.y * t };
        };
        out.push(project(previous, direction1), { ...corner }, project(current, direction2));
        continue;
      }
      let cutPoint: Vec2 | null = null;
      let cutDirection: Vec2 | null = null;
      if (
        join.type === "firstEdgeRightAngle" ||
        join.type === "secondEdgeRightAngle"
      ) {
        const edge =
          join.type === "firstEdgeRightAngle"
            ? unitFrom(before, corner)
            : unitFrom(corner, after);
        cutPoint = corner;
        cutDirection = { x: -edge.y, y: edge.x };
      } else {
        const [edgeA, edgeB, axisA, axisB] =
          join.type === "firstEdgeSymmetry"
            ? [before, corner, current, next]
            : [corner, after, previous, current];
        const reflectedA = reflectAcrossLine(edgeA, axisA, axisB);
        const reflectedB = reflectAcrossLine(edgeB, axisA, axisB);
        if (dist(reflectedA, reflectedB) > 1e-6) {
          cutPoint = reflectedA;
          cutDirection = unitFrom(reflectedA, reflectedB);
        }
      }
      if (cutPoint && cutDirection) {
        const intersection1 = intersectLines(
          cutPoint,
          cutDirection,
          previous,
          direction1,
        );
        const intersection2 = intersectLines(
          cutPoint,
          cutDirection,
          current,
          direction2,
        );
        if (valid(intersection1) && valid(intersection2)) {
          out.push(intersection1, intersection2);
          continue;
        }
      }
      out.push(current);
      continue;
    }
    out.push(current);
  }
  return out;
}
