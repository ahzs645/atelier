import { flattenCubic } from "@atelier/geometry";
import type { CubicSegment, Polyline, Vec2 } from "@atelier/geometry";
import {
  decodeXml,
  escapeXml,
  layerStyle,
  makeDrawing,
} from "./drawing";
import type {
  Drawing,
  DrawingPoly,
  DrawingSegment,
  DrawingText,
  LineStyle,
  SvgOptions,
} from "./types";

function number(value: number, precision: number): string {
  return value.toFixed(precision);
}

export function toSVG(drawing: Drawing, opts: SvgOptions = {}): string {
  const padding = opts.paddingMm ?? 20;
  const precision = opts.precision ?? 2;
  const bounds = drawing.boundsMm;
  const width = Math.max(0, bounds.maxX - bounds.minX) + padding * 2;
  const height = Math.max(0, bounds.maxY - bounds.minY) + padding * 2;
  const x = (value: number): string =>
    number(value - bounds.minX + padding, precision);
  const y = (value: number): string =>
    number(bounds.maxY - value + padding, precision);

  const paths = drawing.polys
    .filter((poly) => poly.pts.length >= 2)
    .map((poly) => {
      const style = layerStyle(drawing, poly.layer);
      const path = poly.pts
        .map((point, index) =>
          `${index === 0 ? "M" : "L"}${x(point.x)},${y(point.y)}`)
        .join(" ") + (poly.closed ? " Z" : "");
      const dash = style.dashed ? ' stroke-dasharray="3,2"' : "";
      const opacity = style.opacity === undefined
        ? ""
        : ` opacity="${number(style.opacity, 3)}"`;
      return `  <path d="${path}" fill="none" stroke="${escapeXml(style.color)}" stroke-width="${number(style.width, 3)}"${dash}${opacity} data-layer="${escapeXml(poly.layer)}"/>`;
    });

  const texts = drawing.texts
    .filter((item) => item.text.length > 0)
    .map((item) => {
      const style = layerStyle(drawing, item.layer);
      const rotation = item.rotationDeg
        ? ` transform="rotate(${number(-item.rotationDeg, precision)} ${x(item.at.x)} ${y(item.at.y)})"`
        : "";
      const opacity = style.opacity === undefined
        ? ""
        : ` opacity="${number(style.opacity, 3)}"`;
      return `  <text x="${x(item.at.x)}" y="${y(item.at.y)}" font-size="${number(item.sizeMm, 1)}" fill="${escapeXml(style.color)}" text-anchor="middle" dominant-baseline="middle"${rotation}${opacity} data-layer="${escapeXml(item.layer)}">${escapeXml(item.text)}</text>`;
    });
  const declaration = opts.xmlDeclaration === false
    ? ""
    : '<?xml version="1.0" encoding="UTF-8"?>\n';
  const body = [...paths, ...texts].join("\n");
  return `${declaration}<svg xmlns="http://www.w3.org/2000/svg" width="${width.toFixed(1)}mm" height="${height.toFixed(1)}mm" viewBox="0 0 ${width.toFixed(1)} ${height.toFixed(1)}">
${body}
</svg>`;
}

interface PathVertex {
  point: Vec2;
  incoming?: Vec2;
  outgoing?: Vec2;
}

interface ParsedPath {
  vertices: PathVertex[];
  closed: boolean;
}

const PATH_TOKEN = /[a-zA-Z]|[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi;

function parsePathData(data: string): ParsedPath[] {
  const tokens = data.match(PATH_TOKEN) ?? [];
  const paths: ParsedPath[] = [];
  let vertices: PathVertex[] = [];
  let command = "";
  let index = 0;
  let current = { x: 0, y: 0 };
  let start = { x: 0, y: 0 };
  let previousCubic: Vec2 | null = null;
  let previousQuadratic: Vec2 | null = null;
  const isCommand = (token: string): boolean => /^[a-z]$/i.test(token);
  const read = (): number => Number.parseFloat(tokens[index++] ?? "NaN");
  const hasNumbers = (): boolean =>
    index < tokens.length && !isCommand(tokens[index]);
  const point = (relative: boolean): Vec2 => {
    const x = read();
    const y = read();
    return relative
      ? { x: current.x + x, y: current.y + y }
      : { x, y };
  };
  const flush = (closed: boolean): void => {
    if (vertices.length > 0) paths.push({ vertices, closed });
    vertices = [];
  };
  const addLine = (next: Vec2): void => {
    vertices.push({ point: next });
    current = next;
    previousCubic = previousQuadratic = null;
  };
  const addCubic = (control1: Vec2, control2: Vec2, end: Vec2): void => {
    const last = vertices[vertices.length - 1];
    if (last) last.outgoing = control1;
    vertices.push({ point: end, incoming: control2 });
    current = end;
    previousCubic = control2;
    previousQuadratic = null;
  };
  const reflected = (control: Vec2 | null): Vec2 => control
    ? {
        x: current.x * 2 - control.x,
        y: current.y * 2 - control.y,
      }
    : { ...current };

  while (index < tokens.length) {
    if (isCommand(tokens[index])) command = tokens[index++];
    if (!command) break;
    const relative = command === command.toLowerCase();
    const upper = command.toUpperCase();
    if (upper === "Z") {
      current = start;
      flush(true);
      previousCubic = previousQuadratic = null;
      command = "";
      continue;
    }
    if (!hasNumbers()) {
      index += 1;
      continue;
    }
    if (upper === "M") {
      const next = point(relative);
      if (vertices.length > 0) flush(false);
      vertices.push({ point: next });
      current = start = next;
      command = relative ? "l" : "L";
      previousCubic = previousQuadratic = null;
    } else if (upper === "L") {
      addLine(point(relative));
    } else if (upper === "H") {
      const value = read();
      addLine({ x: relative ? current.x + value : value, y: current.y });
    } else if (upper === "V") {
      const value = read();
      addLine({ x: current.x, y: relative ? current.y + value : value });
    } else if (upper === "C") {
      const c1 = point(relative);
      const c2 = point(relative);
      const end = point(relative);
      addCubic(c1, c2, end);
    } else if (upper === "S") {
      const c1 = reflected(previousCubic);
      const c2 = point(relative);
      const end = point(relative);
      addCubic(c1, c2, end);
    } else if (upper === "Q" || upper === "T") {
      const control: Vec2 = upper === "Q"
        ? point(relative)
        : reflected(previousQuadratic);
      const end = point(relative);
      const c1 = {
        x: current.x + (control.x - current.x) * 2 / 3,
        y: current.y + (control.y - current.y) * 2 / 3,
      };
      const c2 = {
        x: end.x + (control.x - end.x) * 2 / 3,
        y: end.y + (control.y - end.y) * 2 / 3,
      };
      addCubic(c1, c2, end);
      previousQuadratic = control;
      previousCubic = null;
    } else if (upper === "A") {
      read();
      read();
      read();
      read();
      read();
      addLine(point(relative));
    } else {
      index += 1;
    }
  }
  flush(false);
  return paths;
}

function flattenPath(path: ParsedPath, tolerance: number): Polyline {
  if (path.vertices.length === 0) return [];
  const points: Polyline = [{ ...path.vertices[0].point }];
  const segmentCount = path.closed
    ? path.vertices.length
    : path.vertices.length - 1;
  for (let index = 0; index < segmentCount; index += 1) {
    const from = path.vertices[index];
    const to = path.vertices[(index + 1) % path.vertices.length];
    if (from.outgoing || to.incoming) {
      const segment: CubicSegment = {
        p0: from.point,
        c0: from.outgoing ?? from.point,
        c1: to.incoming ?? to.point,
        p1: to.point,
      };
      points.push(...flattenCubic(segment, tolerance).slice(1));
    } else if (!path.closed || index < path.vertices.length - 1) {
      points.push({ ...to.point });
    }
  }
  return points;
}

/** The authored spans of a path, un-flattened, mirroring `flattenPath`'s walk. */
function pathSegments(path: ParsedPath): DrawingSegment[] {
  if (path.vertices.length === 0) return [];
  const segments: DrawingSegment[] = [];
  const segmentCount = path.closed
    ? path.vertices.length
    : path.vertices.length - 1;
  for (let index = 0; index < segmentCount; index += 1) {
    const from = path.vertices[index];
    const to = path.vertices[(index + 1) % path.vertices.length];
    if (from.outgoing || to.incoming) {
      segments.push({
        kind: "cubic",
        c0: from.outgoing ?? from.point,
        c1: to.incoming ?? to.point,
        to: to.point,
      });
    } else {
      segments.push({ kind: "line", to: to.point });
    }
  }
  return segments;
}

/** Straight geometry described as segments, so `segments` is always populated. */
function lineSegments(points: Polyline, closed: boolean): DrawingSegment[] {
  const segments: DrawingSegment[] = points.slice(1).map((to): DrawingSegment => ({ kind: "line", to }));
  if (closed && points.length > 2) segments.push({ kind: "line", to: points[0] });
  return segments;
}

function attributes(source: string): Map<string, string> {
  const result = new Map<string, string>();
  const expression = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of source.matchAll(expression)) {
    result.set(match[1].toLowerCase(), decodeXml(match[2] ?? match[3] ?? ""));
  }
  return result;
}

function lengthToMm(value: string | undefined, dpi: number): number | null {
  if (!value) return null;
  const match = /^\s*([-+]?(?:\d*\.)?\d+)\s*(mm|cm|in|px|pt)?\s*$/i.exec(value);
  if (!match) return null;
  const amount = Number.parseFloat(match[1]);
  const unit = (match[2] ?? "").toLowerCase();
  if (unit === "cm") return amount * 10;
  if (unit === "in") return amount * 25.4;
  if (unit === "px") return amount * 25.4 / dpi;
  if (unit === "pt") return amount * 25.4 / 72;
  return amount;
}

function parsePoints(value: string): Polyline {
  const values = value
    .trim()
    .split(/[\s,]+/)
    .map(Number)
    .filter(Number.isFinite);
  const points: Polyline = [];
  for (let index = 0; index + 1 < values.length; index += 2) {
    points.push({ x: values[index], y: values[index + 1] });
  }
  return points;
}

function styleFromAttributes(attrs: ReadonlyMap<string, string>): LineStyle | null {
  const inline = attrs.get("style") ?? "";
  const properties = new Map<string, string>();
  for (const part of inline.split(";")) {
    const colon = part.indexOf(":");
    if (colon > 0) {
      properties.set(
        part.slice(0, colon).trim().toLowerCase(),
        part.slice(colon + 1).trim(),
      );
    }
  }
  const color = attrs.get("stroke") ?? properties.get("stroke");
  const width = attrs.get("stroke-width") ?? properties.get("stroke-width");
  const dash = attrs.get("stroke-dasharray")
    ?? properties.get("stroke-dasharray");
  const opacity = attrs.get("opacity") ?? properties.get("opacity");
  if (!color && !width && !dash && !opacity) return null;
  return {
    color: color && color !== "none" ? color : "#000000",
    width: Number.parseFloat(width ?? "0.5") || 0.5,
    ...(dash && dash !== "none" ? { dashed: true } : {}),
    ...(opacity ? { opacity: Number.parseFloat(opacity) } : {}),
  };
}

export function fromSVG(
  svg: string,
  opts: {
    unit?: "mm" | "px";
    dpi?: number;
    /**
     * Also report each poly's authored spans on `DrawingPoly.segments`, keeping
     * the Bezier control points instead of only the flattened `pts`. Off by
     * default: callers that just want polylines are unaffected.
     */
    preserveCurves?: boolean;
    /** Max chord deviation when flattening curves into `pts`, in mm. Default 0.25. */
    curveToleranceMm?: number;
  } = {},
): Drawing {
  const dpi = opts.dpi ?? 96;
  const root = /<svg\b([^>]*)>/i.exec(svg);
  const rootAttrs = attributes(root?.[1] ?? "");
  const viewBox = (rootAttrs.get("viewbox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  let scaleX = opts.unit === "px" ? 25.4 / dpi : 1;
  let scaleY = scaleX;
  if (opts.unit === undefined && viewBox.length === 4) {
    const width = lengthToMm(rootAttrs.get("width"), dpi);
    const height = lengthToMm(rootAttrs.get("height"), dpi);
    if (width !== null && viewBox[2] !== 0) scaleX = width / viewBox[2];
    if (height !== null && viewBox[3] !== 0) scaleY = height / viewBox[3];
  }
  const originX = viewBox.length === 4 ? viewBox[0] : 0;
  const originY = viewBox.length === 4 ? viewBox[1] : 0;
  const convert = (point: Vec2): Vec2 => ({
    x: (point.x - originX) * scaleX,
    y: -(point.y - originY) * scaleY,
  });
  const polys: DrawingPoly[] = [];
  const texts: DrawingText[] = [];
  const styles = new Map<string, LineStyle>();
  const names = new Map<string, string>();
  let automaticLayer = 0;
  const convertSegment = (segment: DrawingSegment): DrawingSegment =>
    segment.kind === "cubic"
      ? { kind: "cubic", c0: convert(segment.c0), c1: convert(segment.c1), to: convert(segment.to) }
      : { kind: "line", to: convert(segment.to) };
  const add = (
    points: Polyline,
    closed: boolean,
    attrs: ReadonlyMap<string, string>,
    segments?: DrawingSegment[],
  ): void => {
    if (points.length < 2) return;
    const layer = attrs.get("data-layer")
      ?? attrs.get("id")
      ?? `svg-${automaticLayer++}`;
    const poly: DrawingPoly = { pts: points.map(convert), closed, layer };
    if (opts.preserveCurves) {
      poly.segments = (segments ?? lineSegments(points, closed)).map(convertSegment);
    }
    polys.push(poly);
    const style = styleFromAttributes(attrs);
    if (style && !styles.has(layer)) styles.set(layer, style);
    names.set(layer, layer);
  };

  const elementExpression = /<(path|polygon|polyline|line|rect)\b([^>]*)\/?>/gi;
  for (const match of svg.matchAll(elementExpression)) {
    const tag = match[1].toLowerCase();
    const attrs = attributes(match[2]);
    if (tag === "path") {
      const tolerance = (opts.curveToleranceMm ?? 0.25) / Math.max(scaleX, scaleY);
      for (const path of parsePathData(attrs.get("d") ?? "")) {
        add(flattenPath(path, tolerance), path.closed, attrs, pathSegments(path));
      }
    } else if (tag === "polygon" || tag === "polyline") {
      add(parsePoints(attrs.get("points") ?? ""), tag === "polygon", attrs);
    } else if (tag === "line") {
      add([
        {
          x: Number.parseFloat(attrs.get("x1") ?? "0"),
          y: Number.parseFloat(attrs.get("y1") ?? "0"),
        },
        {
          x: Number.parseFloat(attrs.get("x2") ?? "0"),
          y: Number.parseFloat(attrs.get("y2") ?? "0"),
        },
      ], false, attrs);
    } else {
      const x = Number.parseFloat(attrs.get("x") ?? "0");
      const y = Number.parseFloat(attrs.get("y") ?? "0");
      const width = Number.parseFloat(attrs.get("width") ?? "0");
      const height = Number.parseFloat(attrs.get("height") ?? "0");
      if (width > 0 && height > 0) {
        add([
          { x, y },
          { x: x + width, y },
          { x: x + width, y: y + height },
          { x, y: y + height },
        ], true, attrs);
      }
    }
  }

  const textExpression = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  for (const match of svg.matchAll(textExpression)) {
    const attrs = attributes(match[1]);
    const layer = attrs.get("data-layer") ?? `svg-${automaticLayer++}`;
    const at = convert({
      x: Number.parseFloat(attrs.get("x") ?? "0"),
      y: Number.parseFloat(attrs.get("y") ?? "0"),
    });
    const transform = /rotate\(\s*([-+]?(?:\d*\.)?\d+)/i.exec(
      attrs.get("transform") ?? "",
    );
    texts.push({
      text: decodeXml(match[2].replace(/<[^>]+>/g, "")).trim(),
      at,
      sizeMm: (Number.parseFloat(attrs.get("font-size") ?? "5") || 5)
        * Math.abs(scaleY),
      ...(transform ? { rotationDeg: -Number.parseFloat(transform[1]) } : {}),
      layer,
    });
    const style = styleFromAttributes(attrs);
    if (style && !styles.has(layer)) styles.set(layer, style);
  }
  return makeDrawing(polys, texts, styles, names);
}
