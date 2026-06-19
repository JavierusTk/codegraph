import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INDEX_HEAP_MB,
  buildIndexHeapRelaunchArgv,
  commandNeedsIndexHeap,
  indexHeapMbFromEnv,
  processHasMaxOldSpaceSize,
} from '../src/bin/index-heap-relaunch';

describe('index heap relaunch', () => {
  it('only targets commands that build or update the index', () => {
    expect(commandNeedsIndexHeap(['index', '/repo'])).toBe(true);
    expect(commandNeedsIndexHeap(['init', '/repo'])).toBe(true);
    expect(commandNeedsIndexHeap(['sync', '/repo'])).toBe(true);

    expect(commandNeedsIndexHeap(['status', '/repo'])).toBe(false);
    expect(commandNeedsIndexHeap(['query', 'User'])).toBe(false);
    expect(commandNeedsIndexHeap([])).toBe(false);
  });

  it('detects user-supplied old-space flags', () => {
    expect(processHasMaxOldSpaceSize(['--max-old-space-size=12288'])).toBe(true);
    expect(processHasMaxOldSpaceSize(['--max-old-space-size', '12288'])).toBe(true);
    expect(processHasMaxOldSpaceSize(['--liftoff-only'])).toBe(false);
  });

  it('uses a sane default heap with an env override', () => {
    expect(indexHeapMbFromEnv({})).toBe(DEFAULT_INDEX_HEAP_MB);
    expect(indexHeapMbFromEnv({ CODEGRAPH_INDEX_HEAP_MB: '12288' })).toBe(12288);
    expect(indexHeapMbFromEnv({ CODEGRAPH_INDEX_HEAP_MB: 'not-a-number' })).toBe(DEFAULT_INDEX_HEAP_MB);
  });

  it('prepends the heap flag while preserving existing runtime flags', () => {
    expect(
      buildIndexHeapRelaunchArgv('/x/codegraph.js', ['index', '/repo'], ['--liftoff-only'], 8192)
    ).toEqual([
      '--max-old-space-size=8192',
      '--liftoff-only',
      '/x/codegraph.js',
      'index',
      '/repo',
    ]);
  });
});
