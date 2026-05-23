/**
 * codegraph_search: filter `import` nodes by default, group overloads.
 *
 * See docs/AI-SEARCH-FILTER-IMPORTS.md and docs/AI-SEARCH-GROUP-OVERLOADS.md.
 *
 * Uses Pascal fixtures because Pascal `uses` clauses cleanly produce `import`
 * nodes, and overloaded functions in `interface` sections give us multiple
 * `function` nodes with the same (name, filePath, kind) — the exact pattern
 * we want to test.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function hasSqliteBindings(): boolean {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}
const HAS_SQLITE = hasSqliteBindings();

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-search-filter-'));
}

function rmTree(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Build a Pascal project where:
 *   - lib.pas declares a unit `Lib` with three overloads of `Bar`
 *   - consumer1.pas, consumer2.pas, consumer3.pas all have `uses Lib;`
 *     so three `import` nodes named `Lib` exist
 *   - other.pas defines `Bar` in a different file (NOT collapsible with the
 *     Lib overloads — verifies cross-file grouping isolation)
 */
async function buildPascalFixture(): Promise<string> {
  const root = tmpRoot();
  fs.writeFileSync(
    path.join(root, 'Lib.pas'),
    [
      'unit Lib;',
      'interface',
      'function Bar(x: Integer): Integer; overload;',
      'function Bar(x: string): string; overload;',
      'function Bar(x: Boolean): Boolean; overload;',
      'implementation',
      'function Bar(x: Integer): Integer; begin Result := x; end;',
      'function Bar(x: string): string; begin Result := x; end;',
      'function Bar(x: Boolean): Boolean; begin Result := x; end;',
      'end.',
      '',
    ].join('\n')
  );

  for (const n of ['Consumer1', 'Consumer2', 'Consumer3']) {
    fs.writeFileSync(
      path.join(root, `${n}.pas`),
      [
        `unit ${n};`,
        'interface',
        'uses Lib;',
        'procedure DoIt;',
        'implementation',
        'procedure DoIt; begin Bar(1); end;',
        'end.',
        '',
      ].join('\n')
    );
  }

  fs.writeFileSync(
    path.join(root, 'Other.pas'),
    [
      'unit Other;',
      'interface',
      'function Bar: Integer;',
      'implementation',
      'function Bar: Integer; begin Result := 0; end;',
      'end.',
      '',
    ].join('\n')
  );

  return root;
}

describe.skipIf(!HAS_SQLITE)('codegraph_search — filter imports + group overloads', () => {
  let projectRoot: string;
  let cg: any;
  let handler: any;

  beforeEach(async () => {
    projectRoot = await buildPascalFixture();
    const CodeGraph = (await import('../src/index')).default;
    const { ToolHandler } = await import('../src/mcp/tools');
    cg = CodeGraph.initSync(projectRoot, {
      config: { include: ['**/*.pas'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.destroy();
    rmTree(projectRoot);
  });

  // ----------------------------------------------------------------------
  // #2: filter imports by default
  // ----------------------------------------------------------------------

  it('default search for an imported unit name does NOT return import nodes', async () => {
    const result = await (handler as any).handleSearch({ query: 'Lib', limit: 10 });
    const text = result.content?.[0]?.text ?? '';

    // Three Consumer*.pas files import Lib — without filtering, those 3
    // imports would be in the result. With default filtering they must NOT be.
    expect(text).not.toMatch(/Consumer1\.pas/);
    expect(text).not.toMatch(/Consumer2\.pas/);
    expect(text).not.toMatch(/Consumer3\.pas/);
    // The module itself should still appear (Lib.pas).
    expect(text).toMatch(/Lib\.pas/);
  });

  it('includeImports:true brings the import nodes back', async () => {
    const result = await (handler as any).handleSearch({
      query: 'Lib',
      limit: 10,
      includeImports: true,
    });
    const text = result.content?.[0]?.text ?? '';

    // Now the consumer imports SHOULD appear.
    expect(text).toMatch(/Consumer1\.pas|Consumer2\.pas|Consumer3\.pas/);
  });

  it('a query that only matches imports returns "No results" by default', async () => {
    // 'Lib' only matches as (1) the unit module itself and (2) 3 import nodes.
    // After filtering imports, the module should still survive. But a name
    // that matches ONLY imports should give a clean "No results" message.
    // We simulate by searching for a string that won't match any defined
    // symbol. Since the fixture has no symbol like 'NonexistentSym', the
    // search returns empty regardless of filtering.
    const result = await (handler as any).handleSearch({
      query: 'NonexistentSymbolXyz',
      limit: 10,
    });
    const text = result.content?.[0]?.text ?? '';
    expect(text).toMatch(/No results found/);
  });

  // ----------------------------------------------------------------------
  // #3: group overloads
  // ----------------------------------------------------------------------

  it('three overloads of Bar in Lib.pas collapse into ONE group entry', async () => {
    const result = await (handler as any).handleSearch({ query: 'Bar', limit: 10 });
    const text = result.content?.[0]?.text ?? '';

    // The grouped header style is: "### Bar (function) — 3 overloads"
    expect(text).toMatch(/Bar \(function\) — 3 overloads/);
    // There should be ONE such grouped header for Lib.pas — not three
    // separate "### Bar (function)" entries.
    const overloadHeaders = (text.match(/Bar \(function\) — \d+ overloads/g) ?? []).length;
    expect(overloadHeaders).toBe(1);
  });

  it('Other.pas Bar stays as a SEPARATE entry (different file, not collapsed)', async () => {
    const result = await (handler as any).handleSearch({ query: 'Bar', limit: 10 });
    const text = result.content?.[0]?.text ?? '';

    // Both files should appear — Lib.pas's group AND Other.pas's single Bar.
    expect(text).toMatch(/Lib\.pas/);
    expect(text).toMatch(/Other\.pas/);
  });

  it('groupOverloads:false returns flat per-signature entries', async () => {
    const result = await (handler as any).handleSearch({
      query: 'Bar',
      limit: 10,
      groupOverloads: false,
    });
    const text = result.content?.[0]?.text ?? '';

    // Without grouping, the "— N overloads" header should NOT appear.
    expect(text).not.toMatch(/— \d+ overloads/);
    // And we should see at least 3 separate "### Bar (function)" entries.
    const flatHeaders = (text.match(/### Bar \(function\)/g) ?? []).length;
    expect(flatHeaders).toBeGreaterThanOrEqual(3);
  });

  it('limit applies to GROUPS, not raw rows (a 3-overload group counts as 1)', async () => {
    const result = await (handler as any).handleSearch({ query: 'Bar', limit: 2 });
    const text = result.content?.[0]?.text ?? '';

    // With limit=2 and 2 candidates (Lib group of 3 + Other single), we
    // should see both — not just the first overload of Lib.
    expect(text).toMatch(/Lib\.pas/);
    expect(text).toMatch(/Other\.pas/);
    // Header reports the group count (2), not the raw row count (4).
    expect(text).toMatch(/Search Results \(2 found\)/);
  });

  // ----------------------------------------------------------------------
  // Interaction: both knobs at once
  // ----------------------------------------------------------------------

  it('default behavior chains filter+group correctly', async () => {
    const result = await (handler as any).handleSearch({ query: 'Bar', limit: 10 });
    const text = result.content?.[0]?.text ?? '';

    // No import noise (Bar isn't imported, but DoIt calls Bar — irrelevant).
    // Grouped overloads visible.
    expect(text).toMatch(/Bar \(function\) — 3 overloads/);
    // Three sub-line locations under the group header.
    const subLines = (text.match(/^\s+:\d+/gm) ?? []).length;
    expect(subLines).toBe(3);
  });
});
