import type { CommandResult, CommandSchema } from './command';
import type { Doc } from './doc';
import {
  editorAutomation,
  type Editor,
  type Transaction,
} from './editor';
import type { Selection } from './selection';

interface AutomationApi<T> {
  commands: () => CommandSchema<T>;
  execute: (type: string, params?: unknown) => CommandResult;
  preview: (type: string, params?: unknown) => CommandResult;
  beginTransaction: (label?: string) => Transaction<T>;
  getDoc: () => Doc<T>;
  getContent: () => T;
  getSelection: () => Selection;
  undo: () => boolean;
  redo: () => boolean;
}

export function installAutomationApi<T>(editor: Editor<T>, name: string): () => void {
  const target = globalThis as Record<string, unknown>;
  const api: AutomationApi<T> = {
    commands: () => editor[editorAutomation]().schema(),
    execute: (type, params) => editor.execute(type, params),
    preview: (type, params) => editor.preview(type, params),
    beginTransaction: (label) => editor.transaction(label),
    getDoc: () => editor.doc,
    getContent: () => editor.content,
    getSelection: () => editor.selection,
    undo: () => editor.undo(),
    redo: () => editor.redo(),
  };
  target[name] = api;

  return () => {
    if (target[name] === api) delete target[name];
  };
}
