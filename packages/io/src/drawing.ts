import type { Bounds2, Vec2 } from "@atelier/geometry";
import type {
  Drawing,
  DrawingLayer,
  DrawingPoly,
  DrawingText,
  LineStyle,
} from "./types";

export const EMPTY_BOUNDS: Bounds2 = {
  minX: 0,
  minY: 0,
  maxX: 100,
  maxY: 100,
};

export function finiteBounds(
  polys: readonly DrawingPoly[],
  texts: readonly DrawingText[] = [],
): Bounds2 {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = (point: Vec2): void => {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  };
  for (const poly of polys) for (const point of poly.pts) include(point);
  for (const item of texts) include(item.at);
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : { ...EMPTY_BOUNDS };
}

export function makeDrawing(
  polys: DrawingPoly[],
  texts: DrawingText[],
  layerStyles: ReadonlyMap<string, LineStyle> = new Map(),
  layerNames: ReadonlyMap<string, string> = new Map(),
): Drawing {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of [...polys, ...texts]) {
    if (!seen.has(item.layer)) {
      seen.add(item.layer);
      ids.push(item.layer);
    }
  }
  if (ids.length === 0) ids.push("default");
  const layers: DrawingLayer[] = ids.map((id) => {
    const style = layerStyles.get(id);
    return {
      id,
      name: layerNames.get(id) ?? id,
      ...(style ? { style } : {}),
    };
  });
  return { layers, polys, texts, boundsMm: finiteBounds(polys, texts) };
}

export function defaultLayerStyle(layer: string): LineStyle {
  if (layer === "seam-allowance") {
    return { color: "#888888", width: 0.4, dashed: true };
  }
  if (layer === "internal") {
    return { color: "#444444", width: 0.35, dashed: true };
  }
  if (layer === "marker") {
    return { color: "#c0392b", width: 0.4 };
  }
  return { color: "#000000", width: 0.5 };
}

export function layerStyle(drawing: Drawing, layerId: string): LineStyle {
  return drawing.layers.find((layer) => layer.id === layerId)?.style
    ?? defaultLayerStyle(layerId);
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function decodeXml(value: string): string {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

export function hexToRgb(color: string): [number, number, number] {
  const short = /^#([0-9a-f]{3})$/i.exec(color);
  const full = /^#([0-9a-f]{6})$/i.exec(color);
  const value = full?.[1]
    ?? (short ? [...short[1]].map((char) => char + char).join("") : null);
  if (!value) return [0, 0, 0];
  const number = Number.parseInt(value, 16);
  return [
    ((number >> 16) & 255) / 255,
    ((number >> 8) & 255) / 255,
    (number & 255) / 255,
  ];
}

