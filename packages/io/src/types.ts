import type { Bounds2, Polyline, Vec2 } from "@atelier/geometry";

export interface LineStyle {
  color: string;
  width: number;
  dashed?: boolean;
  opacity?: number;
}

export interface DrawingLayer {
  id: string;
  name: string;
  style?: LineStyle;
}

export interface DrawingPoly {
  pts: Polyline;
  closed: boolean;
  layer: string;
}

export interface DrawingText {
  text: string;
  at: Vec2;
  sizeMm: number;
  rotationDeg?: number;
  layer: string;
}

export interface Drawing {
  layers: DrawingLayer[];
  polys: DrawingPoly[];
  texts: DrawingText[];
  boundsMm: Bounds2;
}

export interface SvgOptions {
  /** Empty space around the drawing. Default 20 mm. */
  paddingMm?: number;
  /** Decimal places used for geometry. Default 2. */
  precision?: number;
  /** Include the XML declaration. Default true. */
  xmlDeclaration?: boolean;
}

export interface HpglOptions {
  /** HPGL pen number by drawing-layer id. Unspecified layers use their 1-based order. */
  pens?: Readonly<Record<string, number>>;
  /** HPGL line type by drawing-layer id. */
  lineTypes?: Readonly<Record<string, number>>;
}

export interface TileOpts {
  pageWidthMm?: number;
  pageHeightMm?: number;
  overlapMm?: number;
  marginMm?: number;
}

export const TILE_OVERLAP_MM = 6;

export function collectPolylines(drawing: Drawing): DrawingPoly[] {
  return drawing.polys.filter((poly) => poly.pts.length >= 2);
}

export function drawingBoundsMm(drawing: Drawing): Bounds2 & {
  width: number;
  height: number;
} {
  const { minX, minY, maxX, maxY } = drawing.boundsMm;
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
  };
}

/** Compatibility name for the source helper, now operating on a neutral Drawing. */
export const patternBoundsMm = drawingBoundsMm;

