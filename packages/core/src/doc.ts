export type Id = string;
export type ElementKind = string;

export interface DocMeta {
  id: Id;
  name: string;
  revision: number;
  unit: 'mm';
  createdAt: string;
  updatedAt: string;
}

export interface Doc<TContent> {
  readonly meta: DocMeta;
  readonly content: TContent;
}

export function makeUid(prefix: string): Id {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 9)}`;
  }

  let suffix = '';
  for (let index = 0; index < 9; index += 1) {
    suffix += Math.floor(Math.random() * 16).toString(16);
  }
  return `${prefix}_${suffix}`;
}

export function createDoc<T>(content: T, meta: Partial<DocMeta> = {}): Doc<T> {
  const now = new Date().toISOString();
  return {
    meta: {
      id: meta.id ?? makeUid('doc'),
      name: meta.name ?? 'Untitled',
      revision: meta.revision ?? 0,
      unit: meta.unit ?? 'mm',
      createdAt: meta.createdAt ?? now,
      updatedAt: meta.updatedAt ?? now,
    },
    content,
  };
}

export function withContent<T>(doc: Doc<T>, content: T): Doc<T> {
  const currentTime = Date.now();
  const previousTime = Date.parse(doc.meta.updatedAt);
  const updatedAt = new Date(
    Number.isNaN(previousTime) ? currentTime : Math.max(currentTime, previousTime + 1),
  ).toISOString();
  return {
    meta: {
      ...doc.meta,
      revision: doc.meta.revision + 1,
      updatedAt,
    },
    content,
  };
}
