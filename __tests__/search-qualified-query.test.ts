/**
 * codegraph_search with a qualified query (`TClass.Method`, `Unit.Symbol`).
 *
 * Full-text search tokenises `.` away when it indexes, but a query term that
 * keeps its dot is matched as a phrase, so `Application.Initialize` only hits
 * text that spells exactly that and never reaches `TApplication::Initialize`.
 * codegraph_search now adds the hits of the dot-split words after the phrase
 * hits, and puts the exact qualified matches first, as codegraph_node does.
 * The split stays out of the shared search core: explore needs the phrase.
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

function pascalUnit(unitName: string, className: string): string {
  return [
    `unit ${unitName};`,
    'interface',
    'type',
    `  ${className} = class`,
    '  public',
    '    procedure Initialize;',
    '    procedure Run;',
    '  end;',
    'implementation',
    `procedure ${className}.Initialize; begin end;`,
    `procedure ${className}.Run; begin Initialize; end;`,
    'end.',
    '',
  ].join('\n');
}

describe.skipIf(!HAS_SQLITE)('codegraph_search — qualified queries', () => {
  let projectRoot: string;
  let cg: any;
  let handler: any;

  beforeEach(async () => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-search-qualified-'));
    // Several classes share the method name, so a bare-name ranking has to
    // choose among them and the qualifier is what decides. The `TApplication*`
    // siblings match the prefix term `"TApplication"*` just as well as
    // `TApplication` itself does (VCL's `TApplicationEvents` is the real case).
    for (const [unit, cls] of [
      ['Forms', 'TApplication'],
      ['AppEvnts', 'TApplicationEvents'],
      ['AppHelpers', 'TApplicationHelper'],
      ['AppHosts', 'TApplicationHost'],
      ['Panels', 'TAppletApplication'],
    ]) {
      fs.writeFileSync(path.join(projectRoot, `${unit}.pas`), pascalUnit(unit, cls));
    }
    // Plenty of unrelated classes with the same method, in units whose path
    // scores for the method name on its own: a full-text ranking of the bare
    // name fills every candidate slot with these, as the thousands of
    // `Initialize` methods of a Delphi tree do.
    for (let i = 0; i < 30; i++) {
      fs.writeFileSync(path.join(projectRoot, `InitializeWorker${i}.pas`), pascalUnit(`InitializeWorker${i}`, `TWorker${i}`));
    }

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

  /** The `**name** (kind)` + path pairs, in output order. */
  function hits(text: string): Array<{ name: string; kind: string; file: string }> {
    const lines = text.split('\n');
    const out: Array<{ name: string; kind: string; file: string }> = [];
    for (let i = 0; i < lines.length; i++) {
      const m = /^\*\*(.+)\*\* \((\w+)\)/.exec(lines[i]!);
      if (m && !lines[i]!.startsWith('**Search Results')) {
        out.push({ name: m[1]!, kind: m[2]!, file: lines[i + 1] ?? '' });
      }
    }
    return out;
  }

  it('puts the exact qualified definition first', async () => {
    // `::` is split into separate terms by the search core, so for that
    // spelling the `TApplication*` siblings tie with the method that was named.
    for (const query of ['TApplication.Initialize', 'TApplication::Initialize']) {
      for (const limit of [1, 10]) {
        const found = hits(await search({ query, limit }));
        expect(found.length).toBeGreaterThan(0);
        expect(found[0]!.name).toBe('Initialize');
        expect(found[0]!.file).toMatch(/^Forms\.pas:/);
      }
    }
  });

  it('honours the kind filter for the exact matches', async () => {
    const text = await search({ query: 'TApplication.Initialize', kind: 'class' });
    for (const h of hits(text)) expect(h.kind).toBe('class');
  });

  it('finds the methods for a qualifier that is not the stored class name', async () => {
    // `Application` is not `TApplication`, so neither the exact match nor the
    // phrase finds it; the classes whose name contains the qualifier come
    // first, ahead of the thirty unrelated `Initialize` methods.
    const found = hits(await search({ query: 'Application.Initialize', limit: 5 }));
    expect(found.length).toBe(5);
    for (const h of found) {
      expect(h.name).toBe('Initialize');
      expect(h.file).not.toMatch(/^InitializeWorker\d+\.pas:/);
    }
  });

  it('leaves a field filter alone', async () => {
    const text = await search({ query: 'path:Forms.pas' });
    expect(text).not.toMatch(/error/i);
  });
});
