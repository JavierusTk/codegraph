# codegraph_search: filter `import` nodes from results by default

**Status:** implemented
**Audience:** AI coding agents (Claude, Cursor, Codex via MCP)
**Reindex required:** no — pure query-time filter

## Motivation

`codegraph_search` currently returns every node whose name matches the query, including `import` nodes generated from `uses` clauses in Pascal (and equivalent in other languages). For frequently-imported modules these dominate the top of the result set, pushing the actual definition further down.

Real example from this repo's index:

```
codegraph_search "ErrorInformado"
→ #1 ErrorInformado (module)   CyberMAX/lib/ErrorInformado.pas:1     ← what the agent wants
  #2 ErrorInformado (import)   Clientes/AIR/airExportarAENAF1.pas:6 ← noise
  #3 ErrorInformado (import)   Clientes/GAN/dmodGANmed.pas:226       ← noise
  #4 ErrorInformado (import)   Clientes/GAN/ganProveedoresFactura..  ← noise
  #5 ErrorInformado (import)   Clientes/GMC/dmodGMCplanificacion..   ← noise
```

The agent wanted the definition (#1) and got 4 import statements with full multi-line `uses` clauses dumped inline — ~1500 tokens of noise per query.

## Design

Add an optional `includeImports` parameter (default `false`) to `codegraph_search`:

```typescript
interface SearchArgs {
  query: string;
  kind?: string;
  limit?: number;          // default 10
  includeImports?: boolean; // default false — NEW
  projectPath?: string;
}
```

When `includeImports` is `false` (default), the handler post-filters results: drop any `node.kind === 'import' || node.kind === 'export'`.

Because filtering may eliminate matches, the handler internally fetches `limit * 3` (capped at 300) candidates, then filters, then slices to `limit`. Net effect: the agent sees `limit` *useful* results instead of `limit` polluted ones.

When an agent genuinely wants to find "who imports X", they can opt back in with `includeImports: true`, or use the proper tool: `codegraph_callers` if X is callable, or `codegraph_node` to inspect a specific file.

## Files touched

- `src/mcp/tools.ts`:
  - `codegraph_search` schema gains `includeImports`
  - `handleSearch()` post-filters when `includeImports !== true`
  - Tool description note added

## Test plan

Two test files:

- `__tests__/search-filter-imports.test.ts` — synthetic Pascal fixture (Lib.pas with overloads, 3 consumers that `uses Lib`). Covers both #2 (import filtering) and #3 (overload grouping). Needs a SQLite binding with FTS5 (`better-sqlite3`). The bundled `node:sqlite` lacks FTS5 in some environments — those tests will crash with "no such module: fts5"; that's an environment limitation, not a test bug.

- `__tests__/verify-against-live-index.mjs` — runnable smoke test against the live `W:\` codegraph index. Use when the synthetic-fixture tests can't run. Run with `node __tests__/verify-against-live-index.mjs` after `npm run build`. Exit code 0 on pass.

## Activation

After `npm run build`, the MCP server uses the new `dist/`. **A running MCP host (Claude Code) won't pick up the change until the MCP server restarts** — either `/mcp restart` from the host or restart Claude Code.

## Backwards compatibility

- Agents not aware of the new flag get cleaner results by default — strict improvement.
- Agents that already use `kind` filters are unaffected (kind filter is more specific).
- Programmatic callers wanting old behavior pass `includeImports: true`.
