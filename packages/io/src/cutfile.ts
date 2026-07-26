import type { Bounds2, Vec2 } from "@atelier/geometry";
import { finiteBounds } from "./drawing";
import { polylinesToHPGL } from "./hpgl";
import { toSVG } from "./svg";
import type { Drawing, DrawingPoly } from "./types";

const CUT_MM_PER_UNIT = 0.254;

export type CutFileFormat = "hpgl" | "cut" | "svg";

export interface CuttingMachine {
  id: string;
  name: string;
  format: CutFileFormat;
  bedWidthMm: number;
  bedLengthMm: number;
  marginMm: number;
  speed?: number;
}

export interface CutFilePart {
  text: string;
  partLabel: string;
}

export interface CutFileResult {
  files: CutFilePart[];
  extension: string;
  mime: string;
  warnings: string[];
}

export function machineUsableWidthMm(machine: CuttingMachine): number {
  return Math.max(100, machine.bedWidthMm - machine.marginMm * 2);
}

export function machineUsableLengthMm(machine: CuttingMachine): number {
  return Math.max(100, machine.bedLengthMm - machine.marginMm * 2);
}

function polyBounds(poly: DrawingPoly): Bounds2 {
  return finiteBounds([poly]);
}

function drawingWithPolys(drawing: Drawing, polys: DrawingPoly[]): Drawing {
  return {
    ...drawing,
    polys,
    texts: [],
    boundsMm: finiteBounds(polys),
  };
}

function splitByBedLength(
  drawing: Drawing,
  usableLengthMm: number,
  warnings: string[],
): Drawing[] {
  const height = drawing.boundsMm.maxY - drawing.boundsMm.minY;
  if (height <= usableLengthMm || drawing.polys.length === 0) return [drawing];
  const entries = drawing.polys
    .map((poly) => ({ poly, bounds: polyBounds(poly) }))
    .sort((a, b) => a.bounds.minY - b.bounds.minY);
  const segments: Array<{ start: number; entries: typeof entries }> = [];
  let current: { start: number; entries: typeof entries } | null = null;
  for (const entry of entries) {
    const polyHeight = entry.bounds.maxY - entry.bounds.minY;
    if (polyHeight > usableLengthMm) {
      warnings.push(
        `Polyline on layer "${entry.poly.layer}" (${Math.round(polyHeight)} mm) exceeds bed length ${Math.round(usableLengthMm)} mm`,
      );
    }
    if (
      !current
      || entry.bounds.maxY - current.start > usableLengthMm
    ) {
      current = { start: entry.bounds.minY, entries: [] };
      segments.push(current);
    }
    current.entries.push(entry);
  }
  warnings.push(
    `Drawing length ${Math.round(height)} mm exceeds bed length ${Math.round(usableLengthMm)} mm — split into ${segments.length} files`,
  );
  return segments.map((segment) => {
    const polys = segment.entries.map(({ poly }) => ({
      ...poly,
      pts: poly.pts.map((point) => ({
        x: point.x,
        y: point.y - segment.start,
      })),
    }));
    return drawingWithPolys(drawing, polys);
  });
}

function machineTransform(drawing: Drawing, machine: CuttingMachine) {
  const bounds = drawing.boundsMm;
  return (point: Vec2): Vec2 => ({
    x: point.x - bounds.minX + machine.marginMm,
    y: bounds.maxY - point.y + machine.marginMm,
  });
}

function segmentToHPGL(drawing: Drawing, machine: CuttingMachine): string {
  const transform = machineTransform(drawing, machine);
  const penByLayer = new Map(
    drawing.layers.map((layer, index) => [layer.id, index + 1]),
  );
  const body = polylinesToHPGL(drawing.polys.map((poly) => ({
    pts: poly.pts.map(transform),
    closed: poly.closed,
    pen: penByLayer.get(poly.layer) ?? 1,
    lineType: drawing.layers.find((layer) => layer.id === poly.layer)
      ?.style?.dashed ? 2 : undefined,
  })));
  return machine.speed
    ? body.replace("SP1;", `SP1;\nVS${machine.speed};`)
    : body;
}

function segmentToCUT(drawing: Drawing, machine: CuttingMachine): string {
  const transform = machineTransform(drawing, machine);
  const units = (mm: number): number => Math.round(mm / CUT_MM_PER_UNIT);
  const output: string[] = [];
  let block = 0;
  for (const poly of drawing.polys) {
    if (!poly.closed || poly.pts.length < 3) continue;
    block += 1;
    const points = poly.pts.map(transform).map((point) => ({
      x: units(point.x),
      y: units(point.y),
    }));
    output.push(
      `N${block}`,
      "M15",
      `X${points[0].x}Y${points[0].y}`,
      "M14",
    );
    for (let index = 1; index < points.length; index += 1) {
      output.push(`X${points[index].x}Y${points[index].y}`);
    }
    output.push(`X${points[0].x}Y${points[0].y}`, "M15");
  }
  output.push("M0");
  return `${output.join("*")}*`;
}

function segmentToSVG(drawing: Drawing, machine: CuttingMachine): string {
  const transform = machineTransform(drawing, machine);
  const polys = drawing.polys.map((poly) => ({
    ...poly,
    pts: poly.pts.map(transform),
  }));
  return toSVG({
    ...drawing,
    polys,
    texts: [],
    boundsMm: finiteBounds(polys),
  }, { paddingMm: 0 });
}

const FORMAT_META = {
  hpgl: { extension: "hpgl", mime: "application/vnd.hp-hpgl" },
  cut: { extension: "cut", mime: "text/plain" },
  svg: { extension: "svg", mime: "image/svg+xml" },
} as const;

/**
 * Generate machine-native files from neutral drawing geometry. Closed polylines
 * are cutting contours; open polylines remain plotter/SVG reference lines.
 */
export function markerToCutFile(
  drawing: Drawing,
  machine: CuttingMachine,
): CutFileResult {
  const warnings: string[] = [];
  const width = drawing.boundsMm.maxX - drawing.boundsMm.minX;
  const usableWidth = machineUsableWidthMm(machine);
  const usableLength = machineUsableLengthMm(machine);
  if (width > usableWidth) {
    warnings.push(
      `Drawing width ${Math.round(width)} mm exceeds bed width ${Math.round(usableWidth)} mm (bed ${machine.bedWidthMm} mm − 2×${machine.marginMm} mm margin)`,
    );
  }
  const segments = splitByBedLength(drawing, usableLength, warnings);
  const metadata = FORMAT_META[machine.format];
  const files = segments.map((segment, index) => ({
    text: machine.format === "hpgl"
      ? segmentToHPGL(segment, machine)
      : machine.format === "cut"
        ? segmentToCUT(segment, machine)
        : segmentToSVG(segment, machine),
    partLabel: segments.length > 1
      ? `part ${index + 1} of ${segments.length}`
      : "",
  }));
  return {
    files,
    extension: metadata.extension,
    mime: metadata.mime,
    warnings,
  };
}

