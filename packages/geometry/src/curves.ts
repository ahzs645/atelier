import { dist, lerp } from "./vec2";
import type { Polyline, Vec2 } from "./vec2";

export interface CubicSegment {
  p0: Vec2;
  c0: Vec2;
  c1: Vec2;
  p1: Vec2;
}

export function cubicAt(s: CubicSegment, t: number): Vec2 {
  const mt = 1 - t;
  const w0 = mt * mt * mt;
  const w1 = 3 * mt * mt * t;
  const w2 = 3 * mt * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * s.p0.x + w1 * s.c0.x + w2 * s.c1.x + w3 * s.p1.x,
    y: w0 * s.p0.y + w1 * s.c0.y + w2 * s.c1.y + w3 * s.p1.y,
  };
}

/** Raw first derivative; callers can normalize it when they need a unit tangent. */
export function cubicTangentAt(s: CubicSegment, t: number): Vec2 {
  const mt = 1 - t;
  return {
    x:
      3 * mt * mt * (s.c0.x - s.p0.x) +
      6 * mt * t * (s.c1.x - s.c0.x) +
      3 * t * t * (s.p1.x - s.c1.x),
    y:
      3 * mt * mt * (s.c0.y - s.p0.y) +
      6 * mt * t * (s.c1.y - s.c0.y) +
      3 * t * t * (s.p1.y - s.c1.y),
  };
}

export function cubicLength(s: CubicSegment, samples = 24): number {
  const count = Math.max(1, Math.floor(samples));
  let length = 0;
  let previous = s.p0;
  for (let i = 1; i <= count; i += 1) {
    const point = cubicAt(s, i / count);
    length += dist(previous, point);
    previous = point;
  }
  return length;
}

function distanceToLine(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-12) return dist(p, a);
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / length;
}

/**
 * Adaptively flatten a cubic until both controls lie within `tolerance` of the
 * chord. The depth cap prevents numerical noise around cusps from recursing forever.
 */
export function flattenCubic(s: CubicSegment, tolerance: number): Polyline {
  const out: Polyline = [{ ...s.p0 }];
  const tol = Math.max(0, tolerance);
  const visit = (segment: CubicSegment, depth: number): void => {
    if (
      depth >= 18 ||
      (distanceToLine(segment.c0, segment.p0, segment.p1) <= tol &&
        distanceToLine(segment.c1, segment.p0, segment.p1) <= tol)
    ) {
      out.push({ ...segment.p1 });
      return;
    }
    const p01 = lerp(segment.p0, segment.c0, 0.5);
    const p12 = lerp(segment.c0, segment.c1, 0.5);
    const p23 = lerp(segment.c1, segment.p1, 0.5);
    const p012 = lerp(p01, p12, 0.5);
    const p123 = lerp(p12, p23, 0.5);
    const middle = lerp(p012, p123, 0.5);
    visit({ p0: segment.p0, c0: p01, c1: p012, p1: middle }, depth + 1);
    visit({ p0: middle, c0: p123, c1: p23, p1: segment.p1 }, depth + 1);
  };
  visit(s, 0);
  return out;
}
