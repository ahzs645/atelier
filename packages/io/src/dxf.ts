import type { Polyline, Vec2 } from "@atelier/geometry";
import { makeDrawing } from "./drawing";
import type { Drawing, DrawingPoly, DrawingText } from "./types";

interface DxfToken {
  code: number;
  value: string;
}

interface DxfVertex extends Vec2 {
  bulge: number;
}

function tokens(text: string): DxfToken[] {
  const lines = text.split(/\r\n|\r|\n/);
  const result: DxfToken[] = [];
  for (let index = 0; index + 1 < lines.length; index += 2) {
    const code = Number.parseInt(lines[index].trim(), 10);
    if (Number.isNaN(code)) {
      index -= 1;
      continue;
    }
    result.push({ code, value: lines[index + 1].trim() });
  }
  return result;
}

function dxfLayer(value: string): string {
  return value.length > 0 ? value : "default";
}

function expandBulges(vertices: readonly DxfVertex[], closed: boolean): Polyline {
  if (vertices.length < 2) return vertices.map(({ x, y }) => ({ x, y }));
  const result: Polyline = [];
  const count = closed ? vertices.length : vertices.length - 1;
  for (let index = 0; index < count; index += 1) {
    const from = vertices[index];
    const to = vertices[(index + 1) % vertices.length];
    if (index === 0) result.push({ x: from.x, y: from.y });
    if (Math.abs(from.bulge) < 1e-12) {
      if (!closed || index < count - 1) result.push({ x: to.x, y: to.y });
      continue;
    }
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const chord = Math.hypot(dx, dy);
    if (chord < 1e-12) continue;
    const sweep = 4 * Math.atan(from.bulge);
    const offset = chord * (1 - from.bulge * from.bulge)
      / (4 * from.bulge);
    const center = {
      x: (from.x + to.x) / 2 - dy / chord * offset,
      y: (from.y + to.y) / 2 + dx / chord * offset,
    };
    const start = Math.atan2(from.y - center.y, from.x - center.x);
    const radius = Math.hypot(from.x - center.x, from.y - center.y);
    const segments = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 12)));
    for (let step = 1; step <= segments; step += 1) {
      if (closed && index === count - 1 && step === segments) continue;
      const angle = start + sweep * step / segments;
      result.push({
        x: center.x + Math.cos(angle) * radius,
        y: center.y + Math.sin(angle) * radius,
      });
    }
  }
  return result;
}

export function toDXF(drawing: Drawing): string {
  const lines: string[] = ["0", "SECTION", "2", "ENTITIES"];
  for (const poly of drawing.polys) {
    if (poly.pts.length < 2) continue;
    lines.push(
      "0",
      "LWPOLYLINE",
      "8",
      poly.layer,
      "90",
      String(poly.pts.length),
      "70",
      poly.closed ? "1" : "0",
    );
    for (const point of poly.pts) {
      lines.push("10", point.x.toFixed(3), "20", point.y.toFixed(3));
    }
  }
  for (const item of drawing.texts) {
    if (!item.text) continue;
    lines.push(
      "0",
      "TEXT",
      "8",
      item.layer,
      "10",
      item.at.x.toFixed(3),
      "20",
      item.at.y.toFixed(3),
      "40",
      item.sizeMm.toFixed(3),
      "1",
      item.text.replace(/[\r\n]+/g, " "),
    );
    if (item.rotationDeg) lines.push("50", item.rotationDeg.toFixed(3));
  }
  lines.push("0", "ENDSEC", "0", "EOF");
  return lines.join("\n");
}

const INSUNITS_TO_MM: Readonly<Record<number, number>> = {
  0: 1,
  1: 25.4,
  2: 304.8,
  4: 1,
  5: 10,
  6: 1000,
};

function arcPoints(
  center: Vec2,
  radius: number,
  startDeg: number,
  endDeg: number,
  closed: boolean,
): Polyline {
  let end = endDeg;
  if (!closed && end <= startDeg) end += 360;
  const span = closed ? Math.PI * 2 : (end - startDeg) * Math.PI / 180;
  const segments = Math.max(12, Math.ceil(Math.abs(span) / (Math.PI / 12)));
  const last = closed ? segments - 1 : segments;
  const points: Polyline = [];
  for (let index = 0; index <= last; index += 1) {
    const angle = startDeg * Math.PI / 180 + span * index / segments;
    points.push({
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    });
  }
  return points;
}

export function fromDXF(text: string): Drawing {
  const source = tokens(text);
  let unitsCode = 4;
  for (let index = 0; index + 1 < source.length; index += 1) {
    if (
      source[index].code === 9
      && source[index].value.toUpperCase() === "$INSUNITS"
      && source[index + 1].code === 70
    ) {
      unitsCode = Number.parseInt(source[index + 1].value, 10);
      break;
    }
  }
  const scale = INSUNITS_TO_MM[unitsCode] ?? 1;
  const polys: DrawingPoly[] = [];
  const texts: DrawingText[] = [];
  let index = 0;
  const start = (token: DxfToken): boolean => token.code === 0;
  while (index < source.length) {
    const token = source[index];
    if (!start(token)) {
      index += 1;
      continue;
    }
    const type = token.value.toUpperCase();
    index += 1;

    if (type === "LWPOLYLINE") {
      const vertices: DxfVertex[] = [];
      let x: number | null = null;
      let closed = false;
      let layer = "default";
      for (; index < source.length && !start(source[index]); index += 1) {
        const item = source[index];
        if (item.code === 8) layer = dxfLayer(item.value);
        else if (item.code === 70) {
          closed = (Number.parseInt(item.value, 10) & 1) === 1;
        } else if (item.code === 10) {
          x = Number.parseFloat(item.value) * scale;
        } else if (item.code === 20 && x !== null) {
          vertices.push({
            x,
            y: Number.parseFloat(item.value) * scale,
            bulge: 0,
          });
          x = null;
        } else if (item.code === 42 && vertices.length > 0) {
          vertices[vertices.length - 1].bulge = Number.parseFloat(item.value);
        }
      }
      const points = expandBulges(vertices, closed);
      if (points.length >= 2) polys.push({ pts: points, closed, layer });
    } else if (type === "POLYLINE") {
      let closed = false;
      let layer = "default";
      for (; index < source.length && !start(source[index]); index += 1) {
        if (source[index].code === 8) layer = dxfLayer(source[index].value);
        else if (source[index].code === 70) {
          closed = (Number.parseInt(source[index].value, 10) & 1) === 1;
        }
      }
      const vertices: DxfVertex[] = [];
      while (
        index < source.length
        && source[index].code === 0
        && source[index].value.toUpperCase() === "VERTEX"
      ) {
        index += 1;
        const vertex: DxfVertex = { x: 0, y: 0, bulge: 0 };
        for (; index < source.length && !start(source[index]); index += 1) {
          if (source[index].code === 10) {
            vertex.x = Number.parseFloat(source[index].value) * scale;
          } else if (source[index].code === 20) {
            vertex.y = Number.parseFloat(source[index].value) * scale;
          } else if (source[index].code === 42) {
            vertex.bulge = Number.parseFloat(source[index].value);
          }
        }
        vertices.push(vertex);
      }
      if (
        index < source.length
        && source[index].value.toUpperCase() === "SEQEND"
      ) index += 1;
      const points = expandBulges(vertices, closed);
      if (points.length >= 2) polys.push({ pts: points, closed, layer });
    } else if (type === "LINE") {
      let layer = "default";
      const a = { x: 0, y: 0 };
      const b = { x: 0, y: 0 };
      for (; index < source.length && !start(source[index]); index += 1) {
        const item = source[index];
        if (item.code === 8) layer = dxfLayer(item.value);
        else if (item.code === 10) a.x = Number.parseFloat(item.value) * scale;
        else if (item.code === 20) a.y = Number.parseFloat(item.value) * scale;
        else if (item.code === 11) b.x = Number.parseFloat(item.value) * scale;
        else if (item.code === 21) b.y = Number.parseFloat(item.value) * scale;
      }
      polys.push({ pts: [a, b], closed: false, layer });
    } else if (type === "ARC" || type === "CIRCLE") {
      let layer = "default";
      const center = { x: 0, y: 0 };
      let radius = 0;
      let from = 0;
      let to = 360;
      for (; index < source.length && !start(source[index]); index += 1) {
        const item = source[index];
        if (item.code === 8) layer = dxfLayer(item.value);
        else if (item.code === 10) center.x = Number.parseFloat(item.value) * scale;
        else if (item.code === 20) center.y = Number.parseFloat(item.value) * scale;
        else if (item.code === 40) radius = Number.parseFloat(item.value) * scale;
        else if (item.code === 50) from = Number.parseFloat(item.value);
        else if (item.code === 51) to = Number.parseFloat(item.value);
      }
      if (radius > 0) {
        const closed = type === "CIRCLE";
        polys.push({
          pts: arcPoints(center, radius, from, to, closed),
          closed,
          layer,
        });
      }
    } else if (type === "SPLINE") {
      let layer = "default";
      const control: Polyline = [];
      const fit: Polyline = [];
      let controlX: number | null = null;
      let fitX: number | null = null;
      let closed = false;
      for (; index < source.length && !start(source[index]); index += 1) {
        const item = source[index];
        if (item.code === 8) layer = dxfLayer(item.value);
        else if (item.code === 70) {
          closed = (Number.parseInt(item.value, 10) & 1) === 1;
        } else if (item.code === 10) controlX = Number.parseFloat(item.value) * scale;
        else if (item.code === 20 && controlX !== null) {
          control.push({ x: controlX, y: Number.parseFloat(item.value) * scale });
          controlX = null;
        } else if (item.code === 11) fitX = Number.parseFloat(item.value) * scale;
        else if (item.code === 21 && fitX !== null) {
          fit.push({ x: fitX, y: Number.parseFloat(item.value) * scale });
          fitX = null;
        }
      }
      const points = fit.length >= 2 ? fit : control;
      if (points.length >= 2) polys.push({ pts: points, closed, layer });
    } else if (type === "TEXT" || type === "MTEXT") {
      let layer = "default";
      let value = "";
      const at = { x: 0, y: 0 };
      let sizeMm = 5;
      let rotationDeg = 0;
      for (; index < source.length && !start(source[index]); index += 1) {
        const item = source[index];
        if (item.code === 8) layer = dxfLayer(item.value);
        else if (item.code === 1 || item.code === 3) value += item.value;
        else if (item.code === 10) at.x = Number.parseFloat(item.value) * scale;
        else if (item.code === 20) at.y = Number.parseFloat(item.value) * scale;
        else if (item.code === 40) sizeMm = Number.parseFloat(item.value) * scale;
        else if (item.code === 50) rotationDeg = Number.parseFloat(item.value);
      }
      value = value
        .replace(/\\P/g, " ")
        .replace(/\{\\[^;]*;/g, "")
        .replace(/[{}]/g, "")
        .trim();
      if (value) {
        texts.push({
          text: value,
          at,
          sizeMm: Math.max(0.1, sizeMm),
          ...(rotationDeg ? { rotationDeg } : {}),
          layer,
        });
      }
    }
  }
  return makeDrawing(polys, texts);
}

