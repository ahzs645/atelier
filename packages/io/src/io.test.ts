import { describe, expect, it } from "vitest";
import {
  fromDXF,
  fromHPGL,
  fromSVG,
  markerToCutFile,
  tilePageCount,
  toCSV,
  toDXF,
  toHPGL,
  toSVG,
  toTiledPDF,
} from "./index";
import type { CuttingMachine, Drawing } from "./index";

const drawing: Drawing = {
  layers: [
    {
      id: "pattern",
      name: "Pattern",
      style: { color: "#000000", width: 0.5 },
    },
    {
      id: "internal",
      name: "Internal",
      style: { color: "#0066cc", width: 0.25, dashed: true },
    },
  ],
  polys: [
    {
      pts: [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 10 },
        { x: 0, y: 10 },
      ],
      closed: true,
      layer: "pattern",
    },
    {
      pts: [{ x: 2, y: 5 }, { x: 18, y: 5 }],
      closed: false,
      layer: "internal",
    },
  ],
  texts: [
    {
      text: "A&B",
      at: { x: 10, y: 5 },
      sizeMm: 4,
      layer: "pattern",
    },
  ],
  boundsMm: { minX: 0, minY: 0, maxX: 20, maxY: 10 },
};

describe("golden vector exports", () => {
  it("emits exact SVG", () => {
    expect(toSVG(drawing, { paddingMm: 0 })).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="20.0mm" height="10.0mm" viewBox="0 0 20.0 10.0">
  <path d="M0.00,10.00 L20.00,10.00 L20.00,0.00 L0.00,0.00 Z" fill="none" stroke="#000000" stroke-width="0.500" data-layer="pattern"/>
  <path d="M2.00,5.00 L18.00,5.00" fill="none" stroke="#0066cc" stroke-width="0.250" stroke-dasharray="3,2" data-layer="internal"/>
  <text x="10.00" y="5.00" font-size="4.0" fill="#000000" text-anchor="middle" dominant-baseline="middle" data-layer="pattern">A&amp;B</text>
</svg>`,
    );
  });

  it("emits exact DXF", () => {
    expect(toDXF(drawing)).toBe([
      "0", "SECTION", "2", "ENTITIES",
      "0", "LWPOLYLINE", "8", "pattern", "90", "4", "70", "1",
      "10", "0.000", "20", "0.000",
      "10", "20.000", "20", "0.000",
      "10", "20.000", "20", "10.000",
      "10", "0.000", "20", "10.000",
      "0", "LWPOLYLINE", "8", "internal", "90", "2", "70", "0",
      "10", "2.000", "20", "5.000",
      "10", "18.000", "20", "5.000",
      "0", "TEXT", "8", "pattern", "10", "10.000", "20", "5.000",
      "40", "4.000", "1", "A&B",
      "0", "ENDSEC", "0", "EOF",
    ].join("\n"));
  });

  it("emits exact HPGL", () => {
    expect(toHPGL(drawing)).toBe([
      "IN;",
      "SP1;",
      "PU0,0;",
      "PD800,0,800,400,0,400,0,0;",
      "SP2;",
      "LT2;",
      "PU80,200;",
      "PD720,200;",
      "LT;",
      "SP1;",
      "PU400,200;",
      "DI1.0000,0.0000;",
      "SI0.264,0.400;",
      "LBA&B\x03;",
      "DI1,0;",
      "PU;",
      "SP0;",
      "IN;",
    ].join("\n"));
  });

  it("emits exact CSV", () => {
    expect(toCSV(drawing)).toBe(
      `polyline,point,layer,closed,x_mm,y_mm
0,0,pattern,true,0.000,0.000
0,1,pattern,true,20.000,0.000
0,2,pattern,true,20.000,10.000
0,3,pattern,true,0.000,10.000
1,0,internal,false,2.000,5.000
1,1,internal,false,18.000,5.000`,
    );
  });
});

describe("format import and round-trip", () => {
  it("round-trips HPGL geometry in plotter precision", () => {
    expect(fromHPGL(toHPGL({ ...drawing, texts: [] }))).toEqual([
      [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 10 },
        { x: 0, y: 10 },
        { x: 0, y: 0 },
      ],
      [{ x: 2, y: 5 }, { x: 18, y: 5 }],
    ]);
  });

  it("imports exported DXF layers, geometry, and text", () => {
    const imported = fromDXF(toDXF(drawing));
    expect(imported.polys).toEqual(drawing.polys);
    expect(imported.texts).toEqual(drawing.texts);
    expect(imported.boundsMm).toEqual(drawing.boundsMm);
  });

  it("imports SVG without DOM globals and converts SVG y-down to y-up", () => {
    const imported = fromSVG(
      '<svg width="20mm" height="10mm" viewBox="0 0 20 10"><polygon data-layer="cut" points="0,0 20,0 20,10 0,10"/></svg>',
    );
    expect(imported.polys).toEqual([{
      pts: [
        { x: 0, y: -0 },
        { x: 20, y: -0 },
        { x: 20, y: -10 },
        { x: 0, y: -10 },
      ],
      closed: true,
      layer: "cut",
    }]);
    expect(imported.boundsMm).toEqual({
      minX: 0,
      minY: -10,
      maxX: 20,
      maxY: -0,
    });
  });
});

describe("PDF tiling", () => {
  const large: Drawing = {
    layers: [{ id: "cut", name: "Cut" }],
    polys: [{
      pts: [{ x: 0, y: 0 }, { x: 400, y: 600 }],
      closed: false,
      layer: "cut",
    }],
    texts: [],
    boundsMm: { minX: 0, minY: 0, maxX: 400, maxY: 600 },
  };

  it("returns the expected tile count and matching valid PDF", () => {
    expect(tilePageCount(large, {
      pageWidthMm: 210,
      pageHeightMm: 297,
      marginMm: 10,
    })).toEqual({ cols: 3, rows: 3 });
    const text = new TextDecoder("latin1").decode(toTiledPDF(large, {
      pageWidthMm: 210,
      pageHeightMm: 297,
      marginMm: 10,
    }));
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.match(/\/Type \/Page\b/g)).toHaveLength(9);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
  });
});

describe("cut-file generation", () => {
  const machine: CuttingMachine = {
    id: "cutter",
    name: "Test cutter",
    format: "cut",
    bedWidthMm: 1000,
    bedLengthMm: 1000,
    marginMm: 10,
  };

  it("exports closed Drawing contours to CUT commands", () => {
    const result = markerToCutFile(
      { ...drawing, polys: [drawing.polys[0]], texts: [] },
      machine,
    );
    expect(result).toEqual({
      files: [{
        text: "N1*M15*X39Y79*M14*X118Y79*X118Y39*X39Y39*X39Y79*M15*M0*",
        partLabel: "",
      }],
      extension: "cut",
      mime: "text/plain",
      warnings: [],
    });
  });
});

describe("Three.js entry point", () => {
  it("serializes a scene to glTF, OBJ, and STL", async () => {
    const THREE = await import("three");
    const { toGLTF, toOBJ, toSTL } = await import("./three/index");
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial(),
    ));

    const gltf = await toGLTF(scene);
    expect(gltf).toMatchObject({ asset: { version: "2.0" } });
    expect(toOBJ(scene)).toContain("\nv ");
    expect(toSTL(scene)).toMatch(/^solid exported/);
  });
});
