import type { Vec2 } from "@atelier/geometry";
import { hexToRgb, layerStyle } from "./drawing";
import { TILE_OVERLAP_MM } from "./types";
import type { Drawing, TileOpts } from "./types";

const MM_TO_PT = 72 / 25.4;

export interface PdfStroke {
  color?: [number, number, number];
  /** Stroke width in PostScript points. */
  width?: number;
  dash?: [number, number];
}

export interface PdfPageStroke {
  pts: Vec2[];
  closed: boolean;
  style: PdfStroke;
}

export interface PdfPageText {
  x: number;
  y: number;
  size: number;
  text: string;
  color?: [number, number, number];
  anchor?: "start" | "middle" | "end";
  rotation?: number;
}

export interface PdfPage {
  widthPt: number;
  heightPt: number;
  strokes: PdfPageStroke[];
  texts: PdfPageText[];
}

function escapePdf(value: string): string {
  return value
    .replace(/[\\()]/g, (match) => `\\${match}`)
    .replace(/[^\x20-\x7e]/g, "");
}

function pageContent(page: PdfPage): string {
  const output: string[] = [];
  for (const stroke of page.strokes) {
    if (stroke.pts.length < 2) continue;
    const color = stroke.style.color ?? [0, 0, 0];
    output.push(
      `${color[0].toFixed(3)} ${color[1].toFixed(3)} ${color[2].toFixed(3)} RG`,
      `${(stroke.style.width ?? 0.5).toFixed(2)} w`,
      stroke.style.dash
        ? `[${stroke.style.dash[0]} ${stroke.style.dash[1]}] 0 d`
        : "[] 0 d",
      `${stroke.pts[0].x.toFixed(2)} ${stroke.pts[0].y.toFixed(2)} m`,
    );
    for (let index = 1; index < stroke.pts.length; index += 1) {
      output.push(
        `${stroke.pts[index].x.toFixed(2)} ${stroke.pts[index].y.toFixed(2)} l`,
      );
    }
    output.push(stroke.closed ? "h S" : "S");
  }
  for (const item of page.texts) {
    if (!item.text) continue;
    const color = item.color ?? [0, 0, 0];
    const width = item.text.length * item.size * 0.5;
    const dx = item.anchor === "middle"
      ? -width / 2
      : item.anchor === "end" ? -width : 0;
    output.push(
      "BT",
      `${color[0].toFixed(3)} ${color[1].toFixed(3)} ${color[2].toFixed(3)} rg`,
      `/F1 ${item.size.toFixed(2)} Tf`,
    );
    if (item.rotation) {
      const angle = item.rotation * Math.PI / 180;
      const cosine = Math.cos(angle).toFixed(5);
      const sine = Math.sin(angle).toFixed(5);
      output.push(
        `${cosine} ${sine} ${(-Number(sine)).toFixed(5)} ${cosine} ${item.x.toFixed(2)} ${item.y.toFixed(2)} Tm`,
        `${dx.toFixed(2)} 0 Td`,
      );
    } else {
      output.push(
        `1 0 0 1 ${(item.x + dx).toFixed(2)} ${item.y.toFixed(2)} Tm`,
      );
    }
    output.push(`(${escapePdf(item.text)}) Tj`, "ET");
  }
  return output.join("\n");
}

/** Assemble PDF pages into bytes with exact cross-reference offsets. */
export function buildPdf(pages: readonly PdfPage[]): Uint8Array {
  const objects: string[] = [];
  const catalogNumber = 1;
  const pagesNumber = 2;
  const pageObjectNumbers: number[] = [];
  let objectNumber = 2;
  for (let index = 0; index < pages.length; index += 1) {
    pageObjectNumbers.push(++objectNumber);
    objectNumber += 1;
  }
  const fontNumber = ++objectNumber;
  objects[catalogNumber - 1] =
    `<< /Type /Catalog /Pages ${pagesNumber} 0 R >>`;
  objects[pagesNumber - 1] =
    `<< /Type /Pages /Count ${pages.length} /Kids [${pageObjectNumbers.map((number) => `${number} 0 R`).join(" ")}] >>`;
  pages.forEach((page, index) => {
    const pageNumber = pageObjectNumbers[index];
    const contentNumber = pageNumber + 1;
    const content = pageContent(page);
    objects[pageNumber - 1] =
      `<< /Type /Page /Parent ${pagesNumber} 0 R /MediaBox [0 0 ${page.widthPt.toFixed(2)} ${page.heightPt.toFixed(2)}] /Resources << /Font << /F1 ${fontNumber} 0 R >> >> /Contents ${contentNumber} 0 R >>`;
    objects[contentNumber - 1] =
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  objects[fontNumber - 1] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let index = 0; index < objects.length; index += 1) {
    offsets[index] = body.length;
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body +=
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNumber} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  const bytes = new Uint8Array(body.length);
  for (let index = 0; index < body.length; index += 1) {
    bytes[index] = body.charCodeAt(index) & 0xff;
  }
  return bytes;
}

export interface MmPoly {
  pts: Vec2[];
  closed: boolean;
  style: PdfStroke;
}

export interface MmText {
  x: number;
  y: number;
  sizeMm: number;
  text: string;
  color?: [number, number, number];
  anchor?: "start" | "middle" | "end";
  rotation?: number;
}

export const PAGE_SIZES_MM = {
  A4: [210, 297],
  A3: [297, 420],
  A2: [420, 594],
  A1: [594, 841],
  A0: [841, 1189],
  Letter: [215.9, 279.4],
} as const satisfies Readonly<Record<string, readonly [number, number]>>;

export interface PdfLayoutOpts {
  page?: keyof typeof PAGE_SIZES_MM | [number, number];
  marginMm?: number;
  tile?: boolean;
  landscape?: boolean;
  title?: string;
  overlapMm?: number;
  cropMarks?: boolean;
  scale?: number;
}

interface RawTileOpts {
  pageWmm: number;
  pageHmm: number;
  marginMm?: number;
  overlapMm?: number;
}

function countTiles(
  contentWidthMm: number,
  contentHeightMm: number,
  opts: RawTileOpts,
): { cols: number; rows: number; total: number } {
  const margin = opts.marginMm ?? 10;
  const overlap = opts.overlapMm ?? 0;
  const usableWidth = Math.max(10, opts.pageWmm - margin * 2);
  const usableHeight = Math.max(10, opts.pageHmm - margin * 2);
  const strideWidth = Math.max(1e-6, usableWidth - overlap);
  const strideHeight = Math.max(1e-6, usableHeight - overlap);
  const cols = Math.max(
    1,
    Math.ceil((Math.max(0, contentWidthMm) - overlap) / strideWidth),
  );
  const rows = Math.max(
    1,
    Math.ceil((Math.max(0, contentHeightMm) - overlap) / strideHeight),
  );
  return { cols, rows, total: cols * rows };
}

export function tilePageCount(
  drawing: Drawing,
  opts?: TileOpts,
): { cols: number; rows: number };
export function tilePageCount(
  contentWidthMm: number,
  contentHeightMm: number,
  opts: RawTileOpts,
): { cols: number; rows: number; total: number };
export function tilePageCount(
  drawingOrWidth: Drawing | number,
  optsOrHeight: TileOpts | number = {},
  rawOpts?: RawTileOpts,
): { cols: number; rows: number; total?: number } {
  if (typeof drawingOrWidth === "number") {
    const result = countTiles(
      drawingOrWidth,
      typeof optsOrHeight === "number" ? optsOrHeight : 0,
      rawOpts ?? { pageWmm: 210, pageHmm: 297 },
    );
    return result;
  }
  const opts = typeof optsOrHeight === "number" ? {} : optsOrHeight;
  const result = countTiles(
    drawingOrWidth.boundsMm.maxX - drawingOrWidth.boundsMm.minX,
    drawingOrWidth.boundsMm.maxY - drawingOrWidth.boundsMm.minY,
    {
      pageWmm: opts.pageWidthMm ?? 210,
      pageHmm: opts.pageHeightMm ?? 297,
      marginMm: opts.marginMm,
      overlapMm: opts.overlapMm ?? TILE_OVERLAP_MM,
    },
  );
  return { cols: result.cols, rows: result.rows };
}

export function polylinesToPDF(
  sourcePolys: readonly MmPoly[],
  sourceTexts: readonly MmText[],
  opts: PdfLayoutOpts = {},
): Uint8Array {
  let pageSize: readonly [number, number] = Array.isArray(opts.page)
    ? opts.page
    : PAGE_SIZES_MM[opts.page ?? "A4"];
  if (opts.landscape) pageSize = [pageSize[1], pageSize[0]];
  const [pageWidth, pageHeight] = pageSize;
  const margin = opts.marginMm ?? 10;
  const overlap = opts.overlapMm ?? 0;
  const tiled = opts.tile ?? true;
  const scale = opts.scale ?? 1;
  const polys = scale === 1
    ? [...sourcePolys]
    : sourcePolys.map((poly) => ({
        ...poly,
        pts: poly.pts.map((point) => ({
          x: point.x * scale,
          y: point.y * scale,
        })),
      }));
  const texts = scale === 1
    ? [...sourceTexts]
    : sourceTexts.map((item) => ({
        ...item,
        x: item.x * scale,
        y: item.y * scale,
        sizeMm: item.sizeMm * scale,
      }));

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of polys) {
    for (const point of poly.pts) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }
  for (const item of texts) {
    minX = Math.min(minX, item.x);
    minY = Math.min(minY, item.y);
    maxX = Math.max(maxX, item.x);
    maxY = Math.max(maxY, item.y);
  }
  if (!Number.isFinite(minX)) {
    minX = minY = 0;
    maxX = maxY = 100;
  }
  const contentWidth = maxX - minX;
  const contentHeight = maxY - minY;
  const usableWidth = pageWidth - margin * 2;
  const usableHeight = pageHeight - margin * 2;
  const counted = countTiles(contentWidth, contentHeight, {
    pageWmm: pageWidth,
    pageHmm: pageHeight,
    marginMm: margin,
    overlapMm: overlap,
  });
  const pagesWide = tiled ? counted.cols : 1;
  const pagesHigh = tiled ? counted.rows : 1;
  const fit = tiled
    ? 1
    : Math.min(
        usableWidth / Math.max(contentWidth, 1e-3),
        usableHeight / Math.max(contentHeight, 1e-3),
        1,
      );
  const pages: PdfPage[] = [];

  for (let row = 0; row < pagesHigh; row += 1) {
    for (let column = 0; column < pagesWide; column += 1) {
      const tileMinX = tiled
        ? minX + column * (usableWidth - overlap)
        : minX;
      const tileMaxY = tiled
        ? maxY - row * (usableHeight - overlap)
        : maxY;
      const toPage = (point: Vec2): Vec2 => ({
        x: (margin + (point.x - tileMinX) * fit) * MM_TO_PT,
        y: (pageHeight - margin - (tileMaxY - point.y) * fit) * MM_TO_PT,
      });
      const strokes: PdfPageStroke[] = polys.map((poly) => ({
        pts: poly.pts.map(toPage),
        closed: poly.closed,
        style: { ...poly.style },
      }));
      const pageTexts: PdfPageText[] = texts.map((item) => {
        const at = toPage({ x: item.x, y: item.y });
        return {
          x: at.x,
          y: at.y,
          size: Math.max(4, item.sizeMm * MM_TO_PT * fit),
          text: item.text,
          color: item.color,
          anchor: item.anchor,
          rotation: item.rotation,
        };
      });
      if (
        (opts.cropMarks ?? tiled)
        && (pagesWide > 1 || pagesHigh > 1)
      ) {
        const edge = margin * MM_TO_PT;
        const width = pageWidth * MM_TO_PT;
        const height = pageHeight * MM_TO_PT;
        const tick = 8;
        const style: PdfStroke = {
          color: [0.6, 0.6, 0.6],
          width: 0.4,
        };
        const mark = (a: Vec2, b: Vec2): void => {
          strokes.push({ pts: [a, b], closed: false, style });
        };
        mark(
          { x: edge, y: height - edge },
          { x: edge + tick, y: height - edge },
        );
        mark(
          { x: edge, y: height - edge },
          { x: edge, y: height - edge - tick },
        );
        mark(
          { x: width - edge, y: edge },
          { x: width - edge - tick, y: edge },
        );
        mark(
          { x: width - edge, y: edge },
          { x: width - edge, y: edge + tick },
        );
        pageTexts.push({
          x: width / 2,
          y: edge / 2,
          size: 7,
          text: `${opts.title ?? "Drawing"} — page ${row * pagesWide + column + 1}/${pagesWide * pagesHigh} (col ${column + 1}, row ${row + 1})`,
          anchor: "middle",
        });
      }
      pages.push({
        widthPt: pageWidth * MM_TO_PT,
        heightPt: pageHeight * MM_TO_PT,
        strokes,
        texts: pageTexts,
      });
    }
  }
  return buildPdf(pages);
}

export function toPDF(
  drawing: Drawing,
  opts: PdfLayoutOpts = {},
): Uint8Array {
  const polys: MmPoly[] = drawing.polys.map((poly) => {
    const style = layerStyle(drawing, poly.layer);
    return {
      pts: poly.pts,
      closed: poly.closed,
      style: {
        color: hexToRgb(style.color),
        width: style.width * MM_TO_PT,
        ...(style.dashed ? { dash: [3, 2] as [number, number] } : {}),
      },
    };
  });
  const texts: MmText[] = drawing.texts.map((item) => {
    const style = layerStyle(drawing, item.layer);
    return {
      x: item.at.x,
      y: item.at.y,
      sizeMm: item.sizeMm,
      text: item.text,
      color: hexToRgb(style.color),
      anchor: "middle",
      rotation: item.rotationDeg,
    };
  });
  return polylinesToPDF(polys, texts, opts);
}

export function toTiledPDF(
  drawing: Drawing,
  opts: TileOpts = {},
): Uint8Array {
  return toPDF(drawing, {
    page: [opts.pageWidthMm ?? 210, opts.pageHeightMm ?? 297],
    marginMm: opts.marginMm,
    overlapMm: opts.overlapMm ?? TILE_OVERLAP_MM,
    tile: true,
  });
}

