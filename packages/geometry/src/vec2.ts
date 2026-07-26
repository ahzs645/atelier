export interface Vec2 {
  x: number;
  y: number;
}

export type Transform2 = (p: Vec2) => Vec2;

export interface Bounds2 {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type Polyline = Vec2[];

export interface Polygon {
  outer: Polyline;
  holes?: Polyline[];
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(a: Vec2, k: number): Vec2 {
  return { x: a.x * k, y: a.y * k };
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

export function cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x;
}

export function len(a: Vec2): number {
  return Math.hypot(a.x, a.y);
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function normalize(a: Vec2): Vec2 {
  const length = len(a);
  return length > 0 ? scale(a, 1 / length) : { x: 0, y: 0 };
}

export function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function rotate(p: Vec2, deg: number, about: Vec2 = { x: 0, y: 0 }): Vec2 {
  const angle = (deg * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const x = p.x - about.x;
  const y = p.y - about.y;
  return {
    x: about.x + x * cos - y * sin,
    y: about.y + x * sin + y * cos,
  };
}
