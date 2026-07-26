import type { Polyline, Vec2 } from "@atelier/geometry";
import type { Drawing, HpglOptions } from "./types";

const UNIT_MM = 0.025;
const ETX = "\x03";

export interface HpglPoly {
  pts: Polyline;
  closed?: boolean;
  pen?: number;
  lineType?: number;
}

export interface HpglText {
  text: string;
  x: number;
  y: number;
  sizeMm: number;
  rotationDeg?: number;
  pen?: number;
}

export interface HpglCross {
  x: number;
  y: number;
  sizeMm?: number;
  pen?: number;
}

export function polylinesToHPGL(
  polys: readonly HpglPoly[],
  extras: {
    texts?: readonly HpglText[];
    crosses?: readonly HpglCross[];
  } = {},
): string {
  const units = (value: number): number => Math.round(value / UNIT_MM);
  const output = ["IN;", "SP1;"];
  let pen = 1;
  let lineType: number | null = null;
  const setPen = (next: number | undefined): void => {
    if (next && next !== pen) {
      pen = next;
      output.push(`SP${pen};`);
    }
  };
  const setLineType = (next: number | null): void => {
    if (next === lineType) return;
    lineType = next;
    output.push(next === null ? "LT;" : `LT${next};`);
  };
  for (const poly of polys) {
    if (poly.pts.length < 2) continue;
    setPen(poly.pen);
    setLineType(poly.lineType ?? null);
    output.push(`PU${units(poly.pts[0].x)},${units(poly.pts[0].y)};`);
    const points = poly.closed
      ? [...poly.pts.slice(1), poly.pts[0]]
      : poly.pts.slice(1);
    output.push(
      `PD${points.map((point) => `${units(point.x)},${units(point.y)}`).join(",")};`,
    );
  }
  setLineType(null);
  for (const cross of extras.crosses ?? []) {
    setPen(cross.pen ?? 5);
    const arm = cross.sizeMm ?? 3;
    output.push(
      `PU${units(cross.x - arm)},${units(cross.y)};`,
      `PD${units(cross.x + arm)},${units(cross.y)};`,
      `PU${units(cross.x)},${units(cross.y - arm)};`,
      `PD${units(cross.x)},${units(cross.y + arm)};`,
    );
  }
  for (const item of extras.texts ?? []) {
    if (!item.text) continue;
    setPen(item.pen ?? 5);
    const radians = (item.rotationDeg ?? 0) * Math.PI / 180;
    output.push(
      `PU${units(item.x)},${units(item.y)};`,
      `DI${Math.cos(radians).toFixed(4)},${Math.sin(radians).toFixed(4)};`,
      `SI${(item.sizeMm * 0.066).toFixed(3)},${(item.sizeMm / 10).toFixed(3)};`,
      `LB${item.text.replace(new RegExp(ETX, "g"), "")}${ETX};`,
    );
  }
  if ((extras.texts?.length ?? 0) > 0) output.push("DI1,0;");
  output.push("PU;", "SP0;", "IN;");
  return output.join("\n");
}

/** Low-level source-compatible name for exporting explicit HPGL polylines. */
export const writeHPGL = polylinesToHPGL;

export function toHPGL(drawing: Drawing, opts: HpglOptions = {}): string {
  const layerPen = new Map(
    drawing.layers.map((layer, index) => [
      layer.id,
      opts.pens?.[layer.id] ?? index + 1,
    ]),
  );
  const polys: HpglPoly[] = drawing.polys.map((poly) => ({
    pts: poly.pts,
    closed: poly.closed,
    pen: layerPen.get(poly.layer) ?? 1,
    lineType: opts.lineTypes?.[poly.layer]
      ?? (drawing.layers.find((layer) => layer.id === poly.layer)?.style?.dashed
        ? 2
        : undefined),
  }));
  const texts: HpglText[] = drawing.texts.map((item) => ({
    text: item.text,
    x: item.at.x,
    y: item.at.y,
    sizeMm: item.sizeMm,
    rotationDeg: item.rotationDeg,
    pen: layerPen.get(item.layer) ?? 1,
  }));
  return polylinesToHPGL(polys, { texts });
}

export function fromHPGL(text: string): Polyline[] {
  const polys: Polyline[] = [];
  let current: Polyline = [];
  let penDown = false;
  let x = 0;
  let y = 0;
  const flush = (): void => {
    if (current.length > 1) polys.push(current);
    current = [];
  };
  for (const raw of text.replace(/[\r\n]+/g, "").split(";")) {
    const command = raw.trim();
    if (command.length < 2) continue;
    const operation = command.slice(0, 2).toUpperCase();
    const values = command
      .slice(2)
      .split(/[\s,]+/)
      .map(Number)
      .filter(Number.isFinite);
    if (operation === "PU") {
      flush();
      penDown = false;
      for (let index = 0; index + 1 < values.length; index += 2) {
        x = values[index];
        y = values[index + 1];
      }
      if (values.length >= 2) current = [{ x: x * UNIT_MM, y: y * UNIT_MM }];
    } else if (operation === "PD") {
      penDown = true;
      if (current.length === 0) current = [{ x: x * UNIT_MM, y: y * UNIT_MM }];
      for (let index = 0; index + 1 < values.length; index += 2) {
        x = values[index];
        y = values[index + 1];
        current.push({ x: x * UNIT_MM, y: y * UNIT_MM });
      }
    } else if (operation === "PA") {
      for (let index = 0; index + 1 < values.length; index += 2) {
        x = values[index];
        y = values[index + 1];
        const point: Vec2 = { x: x * UNIT_MM, y: y * UNIT_MM };
        if (penDown) current.push(point);
        else {
          flush();
          current = [point];
        }
      }
    }
  }
  flush();
  return polys;
}

/** Source-compatible name. */
export const parseHPGL = fromHPGL;

