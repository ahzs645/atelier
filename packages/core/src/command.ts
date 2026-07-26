import type { Doc, Id } from './doc';
import type { Selection } from './selection';

export interface CommandContext<T> {
  selection: Selection;
  uid: (prefix: string) => Id;
  doc: Doc<T>;
}

export interface CommandDef<T, P = Record<string, unknown>> {
  type: string;
  category: string;
  summary: string;
  inputs: string[];
  example?: P;
  mutating?: boolean;
  label?: string;
  run: (content: T, params: P, ctx: CommandContext<T>) => T;
}

export interface CommandResult {
  ok: boolean;
  changed: boolean;
  error?: string;
}

type ErasedCommandDef<T> = Omit<CommandDef<T, unknown>, 'run'> & {
  run: (content: T, params: unknown, ctx: CommandContext<T>) => T;
};

type RegistryCommandDef<T> = Omit<CommandDef<T, never>, 'example'> & {
  example?: unknown;
};

export type CommandSchema<T> = Array<
  Pick<CommandDef<T>, 'type' | 'category' | 'summary' | 'inputs' | 'example'>
>;

export class CommandRegistry<T> {
  readonly #commands = new Map<string, ErasedCommandDef<T>>();

  register<P>(def: CommandDef<T, P>): this;
  register(def: CommandDef<T, never>): this;
  register(def: RegistryCommandDef<T>): this {
    const run = def.run as unknown as ErasedCommandDef<T>['run'];
    const erased: ErasedCommandDef<T> = {
      type: def.type,
      category: def.category,
      summary: def.summary,
      inputs: [...def.inputs],
      example: def.example,
      mutating: def.mutating,
      label: def.label,
      run,
    };
    this.#commands.set(def.type, erased);
    return this;
  }

  registerAll(defs: Array<CommandDef<T, never>>): this;
  registerAll(defs: Array<RegistryCommandDef<T>>): this;
  registerAll(defs: Array<RegistryCommandDef<T>>): this {
    for (const def of defs) {
      const run = def.run as unknown as ErasedCommandDef<T>['run'];
      this.#commands.set(def.type, {
        type: def.type,
        category: def.category,
        summary: def.summary,
        inputs: [...def.inputs],
        example: def.example,
        mutating: def.mutating,
        label: def.label,
        run,
      });
    }
    return this;
  }

  get(type: string): CommandDef<T, never> | undefined {
    return this.#commands.get(type) as CommandDef<T, never> | undefined;
  }

  list(): ReadonlyArray<CommandDef<T, never>> {
    return [...this.#commands.values()] as Array<CommandDef<T, never>>;
  }

  schema(): CommandSchema<T> {
    return [...this.#commands.values()].map((def) => ({
      type: def.type,
      category: def.category,
      summary: def.summary,
      inputs: [...def.inputs],
      example: def.example as Record<string, unknown> | undefined,
    }));
  }
}

export function commandError(error: unknown): CommandResult {
  return {
    ok: false,
    changed: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

export function contentChanged<T>(current: T, next: T): boolean {
  return next !== current && JSON.stringify(next) !== JSON.stringify(current);
}
