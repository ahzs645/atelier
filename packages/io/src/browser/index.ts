import type { Vec2 } from "@atelier/geometry";
import { layerStyle } from "../drawing";
import { tilePageCount } from "../pdf";
import { toSVG } from "../svg";
import { TILE_OVERLAP_MM } from "../types";
import type { Drawing, TileOpts } from "../types";

function requireDocument(): Document {
  if (typeof document === "undefined") {
    throw new Error("@atelier/io/browser requires a browser document");
  }
  return document;
}

function requireWindow(): Window {
  if (typeof window === "undefined") {
    throw new Error("@atelier/io/browser requires a browser window");
  }
  return window;
}

export function downloadBlob(filename: string, blob: Blob): void {
  const doc = requireDocument();
  const url = URL.createObjectURL(blob);
  try {
    const anchor = doc.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function downloadText(
  filename: string,
  text: string,
  mime = "text/plain",
): void {
  downloadBlob(filename, new Blob([text], { type: mime }));
}

export function toPNG(
  drawing: Drawing,
  maxPx = 2000,
  marginPx = 40,
): Promise<Blob | null> {
  if (drawing.polys.length === 0) return Promise.resolve(null);
  const doc = requireDocument();
  const bounds = drawing.boundsMm;
  const widthMm = Math.max(1, bounds.maxX - bounds.minX);
  const heightMm = Math.max(1, bounds.maxY - bounds.minY);
  const scale = Math.max(
    0.01,
    (maxPx - marginPx * 2) / Math.max(widthMm, heightMm),
  );
  const width = Math.ceil(widthMm * scale + marginPx * 2);
  const height = Math.ceil(heightMm * scale + marginPx * 2);
  const canvas = doc.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return Promise.resolve(null);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  const transform = (point: Vec2): Vec2 => ({
    x: (point.x - bounds.minX) * scale + marginPx,
    y: (bounds.maxY - point.y) * scale + marginPx,
  });
  for (const poly of drawing.polys) {
    if (poly.pts.length < 2) continue;
    const first = transform(poly.pts[0]);
    context.beginPath();
    context.moveTo(first.x, first.y);
    for (let index = 1; index < poly.pts.length; index += 1) {
      const point = transform(poly.pts[index]);
      context.lineTo(point.x, point.y);
    }
    if (poly.closed) context.closePath();
    const style = layerStyle(drawing, poly.layer);
    context.strokeStyle = style.color;
    context.globalAlpha = style.opacity ?? 1;
    context.lineWidth = Math.max(1, style.width * scale);
    context.setLineDash(style.dashed ? [6, 4] : []);
    context.stroke();
  }
  context.globalAlpha = 1;
  context.setLineDash([]);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

function openPrintDocument(html: string): void {
  const popup = requireWindow().open("", "_blank", "width=900,height=700");
  if (!popup) throw new Error("Print window was blocked");
  popup.document.write(html);
  popup.document.close();
}

export function printDrawing(drawing: Drawing, title = "Drawing"): void {
  const svg = toSVG(drawing);
  openPrintDocument(
    `<!doctype html><html><head><title>${title}</title><style>@page{margin:10mm}body{margin:0}svg{width:100%;height:auto;display:block}</style></head><body>${svg}<script>window.onload=function(){window.focus();window.print();}</script></body></html>`,
  );
}

export function printTiled(drawing: Drawing, opts: TileOpts = {}): void {
  const pageWidth = opts.pageWidthMm ?? 210;
  const pageHeight = opts.pageHeightMm ?? 297;
  const margin = opts.marginMm ?? 8;
  const overlap = opts.overlapMm ?? TILE_OVERLAP_MM;
  const usableWidth = pageWidth - margin * 2;
  const usableHeight = pageHeight - margin * 2;
  const count = tilePageCount(drawing, opts);
  const strideX = Math.max(10, usableWidth - overlap);
  const strideY = Math.max(10, usableHeight - overlap);
  const bounds = drawing.boundsMm;
  const pages: string[] = [];
  for (let row = 0; row < count.rows; row += 1) {
    for (let column = 0; column < count.cols; column += 1) {
      const xStart = bounds.minX + column * strideX;
      const yTop = bounds.maxY - row * strideY;
      const x = (value: number): number => margin + value - xStart;
      const y = (value: number): number => margin + yTop - value;
      const paths = drawing.polys
        .filter((poly) => poly.pts.length >= 2)
        .map((poly) => {
          const style = layerStyle(drawing, poly.layer);
          const path = poly.pts
            .map((point, index) =>
              `${index === 0 ? "M" : "L"}${x(point.x).toFixed(2)},${y(point.y).toFixed(2)}`)
            .join(" ") + (poly.closed ? " Z" : "");
          return `<path d="${path}" fill="none" stroke="${style.color}" stroke-width="${style.width}"${style.dashed ? ' stroke-dasharray="3,2"' : ""}/>`;
        })
        .join("");
      pages.push(
        `<div class="page"><svg xmlns="http://www.w3.org/2000/svg" width="${pageWidth}mm" height="${pageHeight}mm" viewBox="0 0 ${pageWidth} ${pageHeight}"><clipPath id="clip-${row}-${column}"><rect x="${margin}" y="${margin}" width="${usableWidth}" height="${usableHeight}"/></clipPath><g clip-path="url(#clip-${row}-${column})">${paths}</g><text x="${margin + 2}" y="${margin + 5}" font-size="4" fill="#94a3b8">R${row + 1}·C${column + 1} of ${count.rows}×${count.cols}</text></svg></div>`,
      );
    }
  }
  openPrintDocument(
    `<!doctype html><html><head><title>Tiled drawing</title><style>@page{size:${pageWidth}mm ${pageHeight}mm;margin:0}body{margin:0}.page{width:${pageWidth}mm;height:${pageHeight}mm;page-break-after:always;overflow:hidden}.page:last-child{page-break-after:auto}svg{display:block}</style></head><body>${pages.join("")}<script>window.onload=function(){window.focus();window.print();}</script></body></html>`,
  );
}

/** Source-compatible aliases, both now accepting Drawing. */
export const printPattern = printDrawing;
export const printPatternTiled = printTiled;
