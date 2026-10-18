import * as fs from 'fs';
import * as fsp from 'fs/promises';

/**
 * Default for {@link MAX_SOURCE_FILE_SIZE_BYTES}. Generated bundles, minified
 * sources, and dependency archives above this limit provide no useful symbols;
 * 1 MB covers essentially all hand-written source.
 */
export const DEFAULT_MAX_SOURCE_FILE_SIZE_BYTES = 1024 * 1024;

/**
 * Ceiling for a `CODEGRAPH_MAX_FILE_BYTES` override. Every file under the limit
 * is decoded to one JS string and handed whole to a WASM parser, so a limit in
 * the hundreds of MB brings back the `Invalid string length` failures and RSS
 * spikes the limit exists to prevent (#1910).
 */
const MAX_SOURCE_FILE_SIZE_CEILING_BYTES = 64 * 1024 * 1024;

/**
 * Resolve the per-file size limit from the `CODEGRAPH_MAX_FILE_BYTES` override.
 * Some hand-written sources do run past 1 MB (a language runtime's core unit,
 * a generated-then-maintained data module); a positive integer raises or lowers
 * the limit, clamped to 64 MiB. Unset, blank, or anything else keeps the default.
 */
export function resolveMaxSourceFileBytes(envVal: string | undefined): number {
  if (envVal !== undefined && /^\d+$/.test(envVal.trim())) {
    const n = Number(envVal.trim());
    if (n > 0) return Math.min(n, MAX_SOURCE_FILE_SIZE_CEILING_BYTES);
  }
  return DEFAULT_MAX_SOURCE_FILE_SIZE_BYTES;
}

/**
 * Largest source file CodeGraph will parse or read during resolution
 * (`CODEGRAPH_MAX_FILE_BYTES`, default 1 MB). Read once per process and per
 * worker thread, which inherit the environment, so every process that writes
 * one index — the CLI, a daemon, an MCP server's watcher — must see the same
 * value, or each sync re-classifies the files between the two limits.
 */
export const MAX_SOURCE_FILE_SIZE_BYTES = resolveMaxSourceFileBytes(process.env.CODEGRAPH_MAX_FILE_BYTES);

/**
 * What stands in for the content of a file over MAX_SOURCE_FILE_SIZE_BYTES. Such a file is
 * never parsed, so its bytes are never needed — reading them only to hash and
 * discard cost multi-GB RSS spikes on committed video/blob fixtures and could
 * fail outright with `Invalid string length` (#1910). The stamp is a function
 * of size alone: change detection compares it to the stored hash, so a
 * same-size rewrite of an oversize file is not a change (nothing about it is
 * indexed), while crossing the limit in either direction is.
 */
export function oversizeStamp(size: number): string {
  return `codegraph:oversize:${size}`;
}

/**
 * The text whose hash the index stores for a file of `size` bytes: its content
 * within the limit, the size stamp over it. Anything that checks a file on disk
 * against its stored `contentHash` has to hash this, or every unchanged file
 * over the limit reads as drifted. `content` is only read within the limit.
 */
export function indexedHashInput(size: number, content: () => string): string {
  return size > MAX_SOURCE_FILE_SIZE_BYTES ? oversizeStamp(size) : content();
}

/**
 * Whether an indexed file sits on the wrong side of the current limit: stored
 * as its size stamp (unread) although it now fits, or parsed although it is now
 * over. Only a change of `CODEGRAPH_MAX_FILE_BYTES` gets a file there, and its
 * size and mtime are unchanged, so a stat-only "unchanged" check must not skip
 * it: the file has to be read and re-indexed under the new limit.
 */
export function crossedSizeLimit(
  size: number,
  contentHash: string,
  hash: (text: string) => string
): boolean {
  const storedAsStamp = contentHash === hash(oversizeStamp(size));
  return storedAsStamp !== size > MAX_SOURCE_FILE_SIZE_BYTES;
}

/** A source file's stats, and its bytes when they are within the limit (null = oversize). */
export interface BoundedSource {
  stats: fs.Stats;
  bytes: Buffer | null;
}

const READ_CHUNK_BYTES = 64 * 1024;

function assertRegularFile(stats: fs.Stats): void {
  if (!stats.isFile()) throw new Error('Source path is not a regular file');
}

/**
 * Read a source file without ever holding more than the limit plus one byte.
 * A stat before the read is not enough: the file can grow between the stat
 * and the read (a log, a download, a build output being written), so the
 * descriptor is re-checked after opening and the read itself stops one byte
 * past the limit. Returns `bytes: null` for an oversize file.
 */
export async function readBoundedSource(file: string): Promise<BoundedSource> {
  const initial = await fsp.stat(file);
  assertRegularFile(initial);
  if (initial.size > MAX_SOURCE_FILE_SIZE_BYTES) return { stats: initial, bytes: null };
  const handle = await fsp.open(file, 'r');
  try {
    let stats = await handle.stat();
    assertRegularFile(stats);
    if (stats.size > MAX_SOURCE_FILE_SIZE_BYTES) return { stats, bytes: null };
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= MAX_SOURCE_FILE_SIZE_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, MAX_SOURCE_FILE_SIZE_BYTES + 1 - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, size);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      size += bytesRead;
    }
    stats = await handle.stat();
    if (size > MAX_SOURCE_FILE_SIZE_BYTES || stats.size > MAX_SOURCE_FILE_SIZE_BYTES) {
      stats.size = Math.max(size, stats.size);
      return { stats, bytes: null };
    }
    return { stats, bytes: Buffer.concat(chunks, size) };
  } finally {
    await handle.close();
  }
}

/** Synchronous {@link readBoundedSource}. */
export function readBoundedSourceSync(file: string): BoundedSource {
  const initial = fs.statSync(file);
  assertRegularFile(initial);
  if (initial.size > MAX_SOURCE_FILE_SIZE_BYTES) return { stats: initial, bytes: null };
  const fd = fs.openSync(file, 'r');
  try {
    let stats = fs.fstatSync(fd);
    assertRegularFile(stats);
    if (stats.size > MAX_SOURCE_FILE_SIZE_BYTES) return { stats, bytes: null };
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= MAX_SOURCE_FILE_SIZE_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, MAX_SOURCE_FILE_SIZE_BYTES + 1 - size));
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, size);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      size += bytesRead;
    }
    stats = fs.fstatSync(fd);
    if (size > MAX_SOURCE_FILE_SIZE_BYTES || stats.size > MAX_SOURCE_FILE_SIZE_BYTES) {
      stats.size = Math.max(size, stats.size);
      return { stats, bytes: null };
    }
    return { stats, bytes: Buffer.concat(chunks, size) };
  } finally {
    fs.closeSync(fd);
  }
}
