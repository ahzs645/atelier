import {
  CommandRegistry,
  Editor,
  createDoc,
} from '@atelier/core';
import type { CommandDef } from '@atelier/core';
import { bounds } from '@atelier/geometry';
import type { Polyline } from '@atelier/geometry';
import { toSVG } from '@atelier/io';
import type { Drawing } from '@atelier/io';

export interface Rectangle {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RectangleContent {
  rectangles: Rectangle[];
}

export interface CreateRectangleParams {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MoveRectangleParams {
  id: string;
  dx: number;
  dy: number;
}

export interface DeleteSelectionParams {
  kind?: string;
}

export function rectanglePolygon(rectangle: Rectangle): Polyline {
  const { x, y, width, height } = rectangle;
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
}

export function createRegistry(): CommandRegistry<RectangleContent> {
  const create: CommandDef<RectangleContent, CreateRectangleParams> = {
    type: 'rect.create',
    category: 'rectangle',
    summary: 'Create rectangle',
    inputs: ['name', 'x', 'y', 'width', 'height'],
    example: { name: 'Panel', x: 0, y: 0, width: 80, height: 50 },
    run: (content, params, context) => ({
      ...content,
      rectangles: [
        ...content.rectangles,
        { id: context.uid('rect'), ...params },
      ],
    }),
  };

  const move: CommandDef<RectangleContent, MoveRectangleParams> = {
    type: 'rect.move',
    category: 'rectangle',
    summary: 'Move rectangle',
    inputs: ['id', 'dx', 'dy'],
    example: { id: 'rect_1', dx: 10, dy: 5 },
    run: (content, params) => ({
      ...content,
      rectangles: content.rectangles.map((rectangle) =>
        rectangle.id === params.id
          ? {
              ...rectangle,
              x: rectangle.x + params.dx,
              y: rectangle.y + params.dy,
            }
          : rectangle),
    }),
  };

  const deleteSelection:
    CommandDef<RectangleContent, DeleteSelectionParams> = {
      type: 'selection.delete',
      category: 'selection',
      summary: 'Delete selection',
      inputs: [],
      example: {},
      run: (content, params, context) => {
        const selected = context.selection.get(params.kind ?? 'rect');
        return {
          ...content,
          rectangles: content.rectangles.filter(
            (rectangle) => !selected.has(rectangle.id),
          ),
        };
      },
    };

  return new CommandRegistry<RectangleContent>()
    .register(create)
    .register(move)
    .register(deleteSelection);
}

export function createRectangleEditor(): Editor<RectangleContent> {
  return new Editor(
    createDoc<RectangleContent>(
      { rectangles: [] },
      { id: 'minimal', name: 'Atelier minimal' },
    ),
    { registry: createRegistry(), history: { coalesceMs: 0 } },
  );
}

export function createDemoEditor(): Editor<RectangleContent> {
  const editor = createRectangleEditor();
  editor.execute<CreateRectangleParams>('rect.create', {
    name: 'Front',
    x: 0,
    y: 0,
    width: 90,
    height: 55,
  });
  editor.execute<CreateRectangleParams>('rect.create', {
    name: 'Side',
    x: 110,
    y: 20,
    width: 55,
    height: 75,
  });

  const [front, side] = editor.content.rectangles;
  if (front && side) {
    const transaction = editor.transaction('Arrange rectangles');
    transaction.execute<MoveRectangleParams>('rect.move', {
      id: front.id,
      dx: 10,
      dy: 10,
    });
    transaction.execute<MoveRectangleParams>('rect.move', {
      id: side.id,
      dx: 5,
      dy: -5,
    });
    transaction.commit();
    editor.undo();
    editor.redo();
  }
  return editor;
}

export function drawingFromContent(content: RectangleContent): Drawing {
  const points = content.rectangles.flatMap(rectanglePolygon);
  const drawingBounds = points.length > 0
    ? bounds(points)
    : { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  return {
    layers: [
      {
        id: 'rectangles',
        name: 'Rectangles',
        style: { color: '#172554', width: 0.6 },
      },
    ],
    polys: content.rectangles.map((rectangle) => ({
      pts: rectanglePolygon(rectangle),
      closed: true,
      layer: 'rectangles',
    })),
    texts: content.rectangles.map((rectangle) => ({
      text: rectangle.name,
      at: {
        x: rectangle.x + rectangle.width / 2,
        y: rectangle.y + rectangle.height / 2,
      },
      sizeMm: 5,
      layer: 'rectangles',
    })),
    boundsMm: drawingBounds,
  };
}

export function exportSvg(content: RectangleContent): string {
  return toSVG(drawingFromContent(content), { paddingMm: 10 });
}
