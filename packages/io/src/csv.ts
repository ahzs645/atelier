import type { Drawing } from "./types";

function cell(value: string): string {
  return /[",\r\n]/.test(value)
    ? `"${value.replace(/"/g, '""')}"`
    : value;
}

export function toCSV(drawing: Drawing): string {
  const rows = ["polyline,point,layer,closed,x_mm,y_mm"];
  drawing.polys.forEach((poly, polylineIndex) => {
    poly.pts.forEach((point, pointIndex) => {
      rows.push([
        String(polylineIndex),
        String(pointIndex),
        cell(poly.layer),
        poly.closed ? "true" : "false",
        point.x.toFixed(3),
        point.y.toFixed(3),
      ].join(","));
    });
  });
  return rows.join("\n");
}

