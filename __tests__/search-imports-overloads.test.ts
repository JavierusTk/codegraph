/**
 * codegraph_search: import/export sites left out by default, same-file
 * overloads folded into one entry.
 *
 * Pascal makes both visible at once. Every `uses` clause becomes one `import`
 * node per unit it names, each carrying the whole clause as its signature, so
 * a search for a much-imported unit lists the clause over and over and the
 * unit's own definition has to compete with it. And the overloads of one
 * function are separate nodes, so three `Bar` overloads took three of the
 * `limit` slots and three headings for what is one symbol.
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

function rmTree(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * - Lib.pas: unit `Lib` with three overloads of `Bar`.
 * - Consumer1..3.pas: `uses SysUtils, Classes, Lib;` — nine import nodes, and
 *   no definition of `SysUtils` anywhere in the project.
 * - Other.pas: a `Bar` of its own, which must stay a separate entry.
 */
function buildPascalFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-search-imports-'));
  fs.writeFileSync(path.join(root, 'Lib.pas'), [
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
  ].join('\n'));
  for (const n of ['Consumer1', 'Consumer2', 'Consumer3']) {
    fs.writeFileSync(path.join(root, `${n}.pas`), [
      `unit ${n};`,
      'interface',
      'uses',
      '  SysUtils, Classes,',
      '  Lib;',
      'procedure DoIt;',
      'implementation',
      'procedure DoIt; begin Bar(1); end;',
      'end.',
      '',
    ].join('\n'));
  }
  fs.writeFileSync(path.join(root, 'Other.pas'), [
    'unit Other;',
    'interface',
    'function Bar: Integer;',
    'implementation',
    'function Bar: Integer; begin Result := 0; end;',
    'end.',
    '',
  ].join('\n'));
  return root;
}

describe.skipIf(!HAS_SQLITE)('codegraph_search — import sites and overloads', () => {
  let projectRoot: string;
  let cg: any;
  let handler: any;

  beforeEach(async () => {
    projectRoot = buildPascalFixture();
    const CodeGraph = (await import('../src/index')).default;
    const { ToolHandler } = await import('../src/mcp/tools');
    cg = CodeGraph.initSync(projectRoot, { config: { include: ['**/*.pas'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.destroy();
    rmTree(projectRoot);
  });

  async function search(args: Record<string, unknown>): Promise<string> {
    const res = await handler.execute('codegraph_search', args);
    return res.content?.[0]?.text ?? '';
  }

  it('leaves the uses-clause import sites out of a search for a unit', async () => {
    const text = await search({ query: 'Lib' });
    expect(text).not.toMatch(/\(import\)/);
    expect(text).not.toMatch(/Consumer\d\.pas/);
    expect(text).toMatch(/\*\*Lib\*\* \(module\)/);
  });

  it('lists them again with includeImports: true', async () => {
    const text = await search({ query: 'Lib', includeImports: true });
    expect(text).toMatch(/\(import\)/);
    expect(text).toMatch(/Consumer\d\.pas/);
  });

  it('says why when only import sites matched', async () => {
    // SysUtils is named in every uses clause and defined nowhere in the project.
    expect(await search({ query: 'SysUtils', includeImports: true })).toMatch(/\(import\)/);
    const text = await search({ query: 'SysUtils' });
    expect(text).toMatch(/No results found/);
    expect(text).toMatch(/includeImports: true/);
  });

  it('folds the three overloads of Bar in Lib.pas into one entry', async () => {
    const text = await search({ query: 'Bar' });
    expect((text.match(/\*\*Bar\*\* \(function\) — 3 overloads/g) ?? []).length).toBe(1);
    // One indented line per overload, in source order.
    const overloadLines = text.match(/^ {2}:\d+.*$/gm) ?? [];
    expect(overloadLines.length).toBe(3);
    const lines = overloadLines.map((l) => Number(/:(\d+)/.exec(l)![1]));
    expect([...lines].sort((a, b) => a - b)).toEqual(lines);
    expect(text).toMatch(/\(x: string\): string/);
  });

  it('keeps the Bar of another file as its own entry', async () => {
    const text = await search({ query: 'Bar' });
    expect(text).toMatch(/^Lib\.pas$/m);
    expect(text).toMatch(/^Other\.pas:\d+$/m);
    expect(text).toMatch(/Search Results \(2 found\)/);
  });

  it('lists each signature on its own with groupOverloads: false', async () => {
    const text = await search({ query: 'Bar', groupOverloads: false });
    expect(text).not.toMatch(/overloads/);
    expect((text.match(/\*\*Bar\*\* \(function\)/g) ?? []).length).toBe(4);
  });

  it('finds a dotted unit that more import sites name than there are candidates', async () => {
    // The Delphi RTL shape: `unit System.SysUtils;` is imported everywhere as
    // plain `uses SysUtils;`. Each one-word import outranks the two-word unit
    // name, so when import sites were dropped AFTER the search, every candidate
    // was one and `SysUtils` answered "No results" on a real Delphi tree.
    fs.writeFileSync(path.join(projectRoot, 'System.Kit.pas'), [
      'unit System.Kit;', 'interface', 'procedure Tool;',
      'implementation', 'procedure Tool; begin end;', 'end.', '',
    ].join('\n'));
    for (let i = 0; i < 160; i++) {
      fs.writeFileSync(path.join(projectRoot, `Client${i}.pas`), [
        `unit Client${i};`, 'interface', 'uses', '  Kit;', 'procedure Go;',
        'implementation', 'procedure Go; begin end;', 'end.', '',
      ].join('\n'));
    }
    await cg.indexAll();
    expect(await search({ query: 'Kit', limit: 3 })).toMatch(/\*\*System\.Kit\*\* \(module\)/);
  });

  it('counts an overload group as one entry of the limit', async () => {
    // Four Bar nodes, two entries: limit 2 must show both files.
    const text = await search({ query: 'Bar', limit: 2 });
    expect(text).toMatch(/^Lib\.pas$/m);
    expect(text).toMatch(/^Other\.pas:\d+$/m);
  });
});
