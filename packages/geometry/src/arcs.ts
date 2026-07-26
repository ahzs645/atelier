import type { Polyline, Vec2 } from "./vec2";

export interface Arc {
  center: Vec2;
  radius: number;
  startDeg: number;
  endDeg: number;
}

/**
 * Approximate an arc with a chord-error bound. Angles retain their signed sweep,
 * so endDeg below startDeg produces a clockwise arc.
 */
export function arcToPolyline(arc: Arc, tolerance: number): Polyline {
  const radius = Math.abs(arc.radius);
  const start = (arc.startDeg * Math.PI) / 180;
  const sweep = ((arc.endDeg - arc.startDeg) * Math.PI) / 180;
  if (radius === 0 || sweep === 0) {
    return [
      {
        x: arc.center.x + radius * Math.cos(start),
        y: arc.center.y + radius * Math.sin(start),
      },
    ];
  }
  const tol = Math.max(1e-12, tolerance);
  // For a chord spanning angle θ, sagitta = r(1-cos(θ/2)).
  const maxStep =
    tol >= radius ? Math.PI : 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tol / radius)));
  const segments = Math.max(1, Math.ceil(Math.abs(sweep) / Math.max(maxStep, 1e-6)));
  const points: Polyline = [];
  for (let i = 0; i <= segments; i += 1) {
    const angle = start + (sweep * i) / segments;
    points.push({
      x: arc.center.x + radius * Math.cos(angle),
      y: arc.center.y + radius * Math.sin(angle),
    });
  }
  return points;
}

/** Circumcircle arc through a→b→c, with sweep chosen so that it passes through b. */
export function threePointArc(a: Vec2, b: Vec2, c: Vec2): Arc | null {
  const denominator =
    2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(denominator) < 1e-6) return null;
  const aa = a.x * a.x + a.y * a.y;
  const bb = b.x * b.x + b.y * b.y;
  const cc = c.x * c.x + c.y * c.y;
  const center = {
    x: (aa * (b.y - c.y) + bb * (c.y - a.y) + cc * (a.y - b.y)) / denominator,
    y: (aa * (c.x - b.x) + bb * (a.x - c.x) + cc * (b.x - a.x)) / denominator,
  };
  const angle = (point: Vec2): number =>
    (Math.atan2(point.y - center.y, point.x - center.x) * 180) / Math.PI;
  const normalizeDegrees = (degrees: number): number => {
    let result = degrees % 360;
    if (result < 0) result += 360;
    return result;
  };
  const startDeg = angle(a);
  const middleDelta = normalizeDegrees(angle(b) - startDeg);
  const endDelta = normalizeDegrees(angle(c) - startDeg);
  return {
    center,
    radius: Math.hypot(a.x - center.x, a.y - center.y),
    startDeg,
    endDeg: middleDelta <= endDelta ? startDeg + endDelta : startDeg + endDelta - 360,
  };
}
