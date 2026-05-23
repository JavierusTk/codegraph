# codegraph_search: group overloads into a single result entry

**Status:** implemented
**Audience:** AI coding agents
**Reindex required:** no — query-time aggregation

## Motivation

In Pascal (and Delphi specifically) it's idiomatic to declare a function with multiple overloads at adjacent lines in the same unit. Current `codegraph_search` returns one full result entry per overload:

```
codegraph_search "CrearQuery"
### CrearQuery (function)
VCL/DBdata/TableMax.Query.pas:153
`(const pSQL:string='';const pPrepare:boolean=false): TQueryMAX`

### CrearQuery (function)
VCL/DBdata/TableMax.Query.pas:151
`(const pParentDataSet:TTableMAX;...)`

### CrearQuery (function)
VCL/DBdata/TableMax.Query.pas:152
`(const pOwner:TComponent;...)`

### CrearQuery (function)
VCL/DBdata/TableMax.Query.pas:150
`(const pOwner:TComponent;const pParentDataSet:TTableMAX;...)`
```

Four heading blocks, ~12 lines, when the situation is **one symbol with four signatures in one file**. With `limit: 10`, four of those slots are gone before any other relevant result can surface.

## Design

When multiple results share the same `(name, filePath, kind)`, collapse them into a single entry that lists all overload signatures grouped by line:

```
### CrearQuery (function) — 4 overloads
VCL/DBdata/TableMax.Query.pas
  :150 `(const pOwner:TComponent;const pParentDataSet:TTableMAX;...)`
  :151 `(const pParentDataSet:TTableMAX;...)`
  :152 `(const pOwner:TComponent;...)`
  :153 `(const pSQL:string='';...)`
```

Half the lines, one mental concept, ordered by `startLine` (canonical reading order).

Add optional flag `groupOverloads` (default `true`) to opt out when the agent specifically wants flat results.

A "real" SearchResult expansion isn't introduced — grouping happens entirely in `formatSearchResults`. The internal `searchNodes` call still fetches `limit * 3` candidates (capped) to keep the post-group result count near `limit`.

## Interaction with #2 (import filtering)

Pipeline order: search → drop imports → group overloads → slice to limit. Imports are dropped *before* grouping so import nodes don't accidentally count toward a function's overload group.

## Files touched

- `src/mcp/tools.ts`:
  - `codegraph_search` schema gains `groupOverloads`
  - `handleSearch()` groups results before formatting
  - `formatSearchResults()` knows how to print a grouped entry (existing single-result path stays for non-grouped entries)

## Test plan

Covered in `__tests__/search-filter-imports.test.ts` (shares the Pascal fixture with #2) and `__tests__/verify-against-live-index.mjs` (live-index smoke test).

The live-index smoke test confirms that `CrearQuery` (4 overloads in `VCL/DBdata/TableMax.Query.pas`) collapses into one entry, that `groupOverloads: false` restores per-signature listing, and that `limit` counts groups rather than raw rows.

## Backwards compatibility

- Grouping is purely formatting. The JSON-returned `SearchResult[]` from the underlying `searchNodes` is unchanged.
- The textual MCP response shape changes for the overload case. Agents parsing markdown headings (`###`) get **fewer** headings now — same information, denser presentation.
- `groupOverloads: false` restores the old per-overload format.
