import { describe, expect, it } from 'vitest';
import { Selection } from '@atelier/core';
import {
  createRectangleEditor,
  exportSvg,
} from './model';
import type {
  CreateRectangleParams,
  MoveRectangleParams,
} from './model';

describe('minimal editor contract', () => {
  it('runs commands and a transaction through undo and redo without a DOM', () => {
    expect(typeof document).toBe('undefined');
    const editor = createRectangleEditor();

    expect(editor.execute<CreateRectangleParams>('rect.create', {
      name: 'A',
      x: 0,
      y: 0,
      width: 20,
      height: 10,
    })).toMatchObject({ ok: true, changed: true });
    expect(editor.execute<CreateRectangleParams>('rect.create', {
      name: 'B',
      x: 30,
      y: 0,
      width: 10,
      height: 10,
    })).toMatchObject({ ok: true, changed: true });

    const firstId = editor.content.rectangles[0]?.id;
    const secondId = editor.content.rectangles[1]?.id;
    expect(firstId).toBeDefined();
    expect(secondId).toBeDefined();
    if (!firstId || !secondId) throw new Error('Expected two rectangles');

    const transaction = editor.transaction('Move both');
    transaction.execute<MoveRectangleParams>('rect.move', {
      id: firstId,
      dx: 5,
      dy: 2,
    });
    transaction.execute<MoveRectangleParams>('rect.move', {
      id: secondId,
      dx: -3,
      dy: 4,
    });
    expect(transaction.commit()).toBe(true);
    expect(editor.content.rectangles.map(({ x, y }) => [x, y])).toEqual([
      [5, 2],
      [27, 4],
    ]);

    expect(editor.undo()).toBe(true);
    expect(editor.content.rectangles.map(({ x, y }) => [x, y])).toEqual([
      [0, 0],
      [30, 0],
    ]);
    expect(editor.redo()).toBe(true);
    expect(editor.content.rectangles.map(({ x, y }) => [x, y])).toEqual([
      [5, 2],
      [27, 4],
    ]);

    editor.setSelection(Selection.of([['rect', [secondId]]]));
    editor.execute('selection.delete', { kind: 'rect' });
    expect(editor.content.rectangles.map(({ id }) => id)).toEqual([firstId]);
    expect(editor.undo()).toBe(true);
    expect(editor.content.rectangles).toHaveLength(2);
    expect(exportSvg(editor.content)).toContain('<svg');

    editor.dispose();
  });
});
