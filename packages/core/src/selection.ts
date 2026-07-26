import type { ElementKind, Id } from './doc';

export class Selection {
  readonly #entries: ReadonlyMap<ElementKind, ReadonlySet<Id>>;

  private constructor(entries: ReadonlyMap<ElementKind, ReadonlySet<Id>>) {
    this.#entries = entries;
  }

  static empty(): Selection {
    return new Selection(new Map());
  }

  static of(entries: Iterable<[ElementKind, Iterable<Id>]>): Selection {
    const next = new Map<ElementKind, ReadonlySet<Id>>();
    for (const [kind, ids] of entries) {
      const values = new Set(ids);
      if (values.size > 0) next.set(kind, values);
    }
    return new Selection(next);
  }

  get(kind: ElementKind): ReadonlySet<Id> {
    const ids = this.#entries.get(kind);
    return new Set(ids ?? []);
  }

  has(kind: ElementKind, id: Id): boolean {
    return this.#entries.get(kind)?.has(id) ?? false;
  }

  kinds(): ElementKind[] {
    return [...this.#entries.keys()];
  }

  get size(): number {
    let total = 0;
    for (const ids of this.#entries.values()) total += ids.size;
    return total;
  }

  add(kind: ElementKind, ...ids: Id[]): Selection {
    const next = this.cloneEntries();
    const values = new Set(next.get(kind) ?? []);
    for (const id of ids) values.add(id);
    if (values.size > 0) next.set(kind, values);
    return new Selection(next);
  }

  remove(kind: ElementKind, ...ids: Id[]): Selection {
    const next = this.cloneEntries();
    const values = new Set(next.get(kind) ?? []);
    for (const id of ids) values.delete(id);
    if (values.size > 0) next.set(kind, values);
    else next.delete(kind);
    return new Selection(next);
  }

  toggle(kind: ElementKind, id: Id): Selection {
    return this.has(kind, id) ? this.remove(kind, id) : this.add(kind, id);
  }

  replace(kind: ElementKind, ids: Iterable<Id>): Selection {
    const next = this.cloneEntries();
    const values = new Set(ids);
    if (values.size > 0) next.set(kind, values);
    else next.delete(kind);
    return new Selection(next);
  }

  clear(kind?: ElementKind): Selection {
    if (kind === undefined) return Selection.empty();
    const next = this.cloneEntries();
    next.delete(kind);
    return new Selection(next);
  }

  equals(other: Selection): boolean {
    if (this.size !== other.size || this.#entries.size !== other.#entries.size) return false;
    for (const [kind, ids] of this.#entries) {
      const otherIds = other.#entries.get(kind);
      if (!otherIds || ids.size !== otherIds.size) return false;
      for (const id of ids) {
        if (!otherIds.has(id)) return false;
      }
    }
    return true;
  }

  private cloneEntries(): Map<ElementKind, ReadonlySet<Id>> {
    return new Map(this.#entries);
  }
}
