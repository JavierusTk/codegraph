/**
 * The per-file size limit can be changed with CODEGRAPH_MAX_FILE_BYTES: some
 * hand-written sources run past 1 MB (Delphi's System.SysUtils.pas, a
 * maintained data module), and the fixed limit left them with no symbols.
 *
 * Changing the limit has to reach files whose bytes did not change. Sync skips
 * a file whose size and mtime match the index, so without its own check a file
 * stored unread as oversize stays empty after the limit is raised, and a file
 * parsed before keeps its symbols after the limit is lowered past it.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import {
  DEFAULT_MAX_SOURCE_FILE_SIZE_BYTES,
  MAX_SOURCE_FILE_SIZE_BYTES,
  crossedSizeLimit,
  oversizeStamp,
  resolveMaxSourceFileBytes,
} from '../src/file-limits';

describe('resolveMaxSourceFileBytes', () => {
  it('keeps the 1 MiB default when unset or not a positive integer', () => {
    expect(DEFAULT_MAX_SOURCE_FILE_SIZE_BYTES).toBe(1024 * 1024);
    for (const value of [undefined, '', '  ', 'abc', '0', '-5', '1.5', '4MB', '0x100']) {
      expect(resolveMaxSourceFileBytes(value)).toBe(DEFAULT_MAX_SOURCE_FILE_SIZE_BYTES);
    }
  });

  it('takes a positive integer number of bytes', () => {
    expect(resolveMaxSourceFileBytes('4194304')).toBe(4 * 1024 * 1024);
    expect(resolveMaxSourceFileBytes(' 2000 ')).toBe(2000);
    expect(resolveMaxSourceFileBytes('100')).toBe(100);
  });

  it('clamps an override to 64 MiB', () => {
    expect(resolveMaxSourceFileBytes('999999999999')).toBe(64 * 1024 * 1024);
  });
});

describe('CODEGRAPH_MAX_FILE_BYTES on index and sync', () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  /** The CodeGraph class from a fresh module graph, which reads the limit anew. */
  async function codeGraphWithLimit(limit: string) {
    vi.stubEnv('CODEGRAPH_MAX_FILE_BYTES', limit);
    vi.resetModules();
    return (await import('../src')).CodeGraph;
  }

  function project(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-max-file-bytes-'));
    roots.push(root);
    // ~3 KB: over a 2000-byte limit, far under the default.
    const padding = Array.from({ length: 60 }, (_, i) => `// padding line ${i} ${'x'.repeat(30)}`).join('\n');
    fs.writeFileSync(path.join(root, 'big.ts'), `export function bigTarget(): number {\n  return 1;\n}\n${padding}\n`);
    fs.writeFileSync(path.join(root, 'small.ts'), `export function smallOne(): number {\n  return 2;\n}\n`);
    return root;
  }

  function names(cg: { getNodesInFile(file: string): Array<{ name: string }> }, file: string): string[] {
    return cg.getNodesInFile(file).map((n) => n.name);
  }

  it('parses a file over the override only once the limit is raised', async () => {
    const root = project();

    let CodeGraph = await codeGraphWithLimit('2000');
    let cg = await CodeGraph.init(root, { index: true });
    try {
      expect(names(cg, 'small.ts')).toContain('smallOne');
      expect(names(cg, 'big.ts')).not.toContain('bigTarget');
    } finally {
      cg.close();
    }

    // Raised limit, same bytes, same mtime: the next sync parses the file.
    CodeGraph = await codeGraphWithLimit('');
    cg = await CodeGraph.open(root);
    try {
      await cg.sync();
      expect(names(cg, 'big.ts')).toContain('bigTarget');
    } finally {
      cg.close();
    }
  }, 60_000);

  it('drops the symbols of a file the lowered limit leaves out', async () => {
    const root = project();

    let CodeGraph = await codeGraphWithLimit('');
    let cg = await CodeGraph.init(root, { index: true });
    try {
      expect(names(cg, 'big.ts')).toContain('bigTarget');
    } finally {
      cg.close();
    }

    CodeGraph = await codeGraphWithLimit('2000');
    cg = await CodeGraph.open(root);
    try {
      await cg.sync();
      expect(names(cg, 'big.ts')).not.toContain('bigTarget');
      expect(names(cg, 'small.ts')).toContain('smallOne');
    } finally {
      cg.close();
    }
  }, 60_000);

});

describe('crossedSizeLimit', () => {
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const over = MAX_SOURCE_FILE_SIZE_BYTES + 1;

  it('lets the stat pre-filter skip a file on the side of the limit it was indexed on', () => {
    expect(crossedSizeLimit(100, hash('export const a = 1;'), hash)).toBe(false);
    expect(crossedSizeLimit(over, hash(oversizeStamp(over)), hash)).toBe(false);
  });

  it('flags a file indexed on the other side of the limit', () => {
    expect(crossedSizeLimit(100, hash(oversizeStamp(100)), hash)).toBe(true);
    expect(crossedSizeLimit(over, hash('parsed under a larger limit'), hash)).toBe(true);
  });
});
