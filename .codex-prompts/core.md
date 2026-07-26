# Task: implement `@atelier/core`

You are implementing the document/command/history core of a new engine, `atelier`, which
extracts shared CAD-editor infrastructure out of two existing apps.

## Working directory & boundaries

- Repo root for this task: `/Users/ahmadjalil/github/Engine`
- **You may WRITE only inside `atelier/packages/core/`.**
- **Do NOT modify** any file in `atelier/` outside that directory (root `package.json`,
  `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`, `docs/` are already correct).
- **Do NOT modify** `packager/` or `seamer/` at all. They are READ-ONLY reference sources.
- Another agent is concurrently writing `atelier/packages/geometry/`. **Do not read from or
  depend on `@atelier/geometry` source** — it may be mid-write. `core` does not actually need it
  for anything in the API below; if you think you need a `Vec2`, declare a local structural type.

## Read these first

- `atelier/docs/ARCHITECTURE.md` — §4.2 is the exact public API you must implement. Also
  decisions D2, D3, D4, D10, and §5.2/§5.4/§5.5/§5.6.
- `atelier/docs/AUDIT.md` §2.2 — what exists in seamer today.
- `atelier/docs/MIGRATION.md` Phase 2.

## What to build

Implement `atelier/packages/core/src/` to match **ARCHITECTURE.md §4.2** exactly — same names,
same signatures. If you must deviate, report it with the reason.

This is a **generalisation**, not a fresh design. seamer already has a very good, working
version of all of this, hard-typed to its `Pattern`. Your job is to make it generic over
`TContent` while preserving its behaviour exactly.

Port from `seamer/src/lib/`:

| seamer source | becomes |
|---|---|
| `commands/types.ts` — `CommandDef`, `CommandContext`, `CommandResult`, `makeUid` | `CommandDef<T, P>`, `CommandContext<T>`, `CommandResult`, `makeUid` — now generic |
| `commands/execute.ts` — `executeCommand`, `ExecuteHost`, `commandSchema` | folded into `Editor<T>` + `CommandRegistry<T>.schema()` |
| `commands/execute.ts` — `PatternTransaction`, `beginTransaction` | `Transaction<T>`, `Editor.transaction()` |
| `commands/execute.ts` — `installCommandApi` / `window.seamer` | `installAutomationApi(editor, name)` |
| `commands/selection.ts` — the `Selection` interface (5 parallel id sets) | the `Selection` **class** in §4.2 (immutable, multi-kind, `Map<ElementKind, Set<Id>>`) |
| `stores/pattern.ts` lines 86–218 — undo/redo, `HISTORY_LIMIT`, coalescing, `refresh()` | `History<T>` |
| `stores/pattern.ts` lines 116–164 — IndexedDB persist/restore | `HistoryPersistence<T>` interface + `IndexedDbHistoryPersistence` in `src/persist/` |
| `stores/localDB.ts` — `saveHistory`/`loadHistory`/`deleteHistory` | backing impl for the above |
| `stores/pattern.ts` lines 60–70 — `persisted<T>()` | `persisted<T>()` in `src/persist/`, framework-free (no svelte store) |

**Behaviour that must be preserved exactly** (these are the details that make it good):

- `HISTORY_LIMIT = 100` default; `PERSIST_LIMIT = 30` per stack; persist debounce `800ms`.
- **Gesture coalescing**: `COALESCE_MS = 800`. Rapid pushes with the SAME label inside the
  window keep only the first entry (which holds the pre-gesture doc), so a drag is one undo
  entry. A coalesced push still clears the redo stack.
- `undo(current)` pushes `current` onto the redo stack under the popped entry's label, and
  `redo(current)` mirrors it. seamer's comment notes an earlier version never populated redo
  and so redo silently did nothing — do not regress that.
- A command returning the input unchanged means "nothing happened": no history entry, and
  `CommandResult.changed === false`. seamer detects this with
  `next !== current && JSON.stringify(next) !== JSON.stringify(current)`. **Keep the identity
  fast path**, but consider whether the `JSON.stringify` deep compare is worth its cost on
  large documents — if you keep it, keep it; if you make it configurable, default to seamer's
  behaviour and say so in your report.
- `Transaction` runs commands against a working copy and commits once, as ONE history entry.
  `rollback()` discards. Calling `execute`/`commit` after the transaction is finished returns
  an error result rather than throwing.

## Hard constraints

- **TypeScript strict. Never use `any`.** `@typescript-eslint/no-explicit-any` is an error.
  Generic command params are the hard part here: `CommandDef<T, P>` with a registry holding
  heterogeneous `P` types. Use `unknown`-based erasure at the registry boundary plus typed
  `execute<P>()` at the call site. Do NOT reach for `any` to make variance problems go away —
  if you genuinely cannot type something without it, leave a `// TODO` with an explanation and
  report it, do not silently widen.
- **No `three`, no framework import, no DOM API at module scope** (D2, D10). `indexedDB`,
  `localStorage`, `window` may only be touched *inside* functions in `src/persist/`, guarded
  with `typeof x === 'undefined'` checks — seamer's SvelteKit SSR build depends on this.
- **No singletons, no global registration on import** (D10). Everything constructed explicitly.
- Engine code throws only on programmer error; recoverable failures return typed results (§5.5).
  No `console.warn`/`console.error` from inside the package — surface via return value or the
  `'error'` event.
- Every class with resources exposes `dispose()` (§5.4).
- Use `import type` for type-only imports.
- Concise and simple. Do not over-engineer.
- `src/index.ts` is the only public surface. Organise into focused modules
  (`doc.ts`, `selection.ts`, `command.ts`, `history.ts`, `editor.ts`, `automation.ts`,
  `persist/index.ts`, `persist/indexeddb.ts`).

## Tests

Port and adapt `seamer/src/lib/commands/commands.test.ts` and `create.test.ts` where they cover
generic behaviour. Then add tests for:
- coalescing: N rapid same-label pushes → 1 entry; different label → N entries; label repeated
  after the window → 2 entries. Use injectable time (a `now()` option) rather than real timers.
- undo/redo round-trip including the label shuttling.
- history limit eviction.
- transaction commit → exactly one entry; rollback → zero.
- unchanged-reducer → no entry, `changed: false`.
- `Selection` immutability: every mutator returns a new instance, original untouched.
- `CommandRegistry.schema()` shape.
- an `Editor` driven purely through `execute()` on a toy content type.

`History` must be testable without IndexedDB (persistence is injected, default `null`).

## Commands to run (from `/Users/ahmadjalil/github/Engine/atelier`)

```
pnpm --filter @atelier/core exec tsc -b --pretty
pnpm exec vitest run packages/core
pnpm exec eslint packages/core
```

All three must pass. Do not run dev servers or bundler builds.

Note: `packages/core/package.json` declares a `@atelier/geometry` workspace dependency. If
importing it breaks your typecheck because that package is mid-write by another agent, simply
do not import it — do not edit the manifest.

## Report format

1. **Files created**, one line each with purpose.
2. **API deviations** from ARCHITECTURE.md §4.2, with justification. "None" if none.
3. **Typing notes** — how you erased the generic command params without `any`, and anywhere you
   were forced close to it.
4. **Behaviour preserved** — confirm each of the listed seamer behaviours, or flag deviations.
5. **Tests**: count, coverage areas, final pass/fail.
6. **Command output** for typecheck, test, lint (final lines).
