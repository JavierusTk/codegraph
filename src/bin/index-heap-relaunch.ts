import { spawnSync } from 'child_process';

export const DEFAULT_INDEX_HEAP_MB = 8192;

const RELAUNCH_GUARD_ENV = 'CODEGRAPH_INDEX_HEAP_RELAUNCHED';
const HEAP_MB_ENV = 'CODEGRAPH_INDEX_HEAP_MB';

const INDEX_HEAVY_COMMANDS = new Set(['init', 'index', 'sync']);

export function commandNeedsIndexHeap(args: readonly string[] = process.argv.slice(2)): boolean {
  const command = args.find((arg) => !arg.startsWith('-'));
  return !!command && INDEX_HEAVY_COMMANDS.has(command);
}

export function processHasMaxOldSpaceSize(execArgv: readonly string[] = process.execArgv): boolean {
  return execArgv.some((arg) => arg === '--max-old-space-size' || arg.startsWith('--max-old-space-size='));
}

export function indexHeapMbFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env[HEAP_MB_ENV];
  if (!raw) return DEFAULT_INDEX_HEAP_MB;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INDEX_HEAP_MB;
}

export function buildIndexHeapRelaunchArgv(
  scriptPath: string,
  scriptArgs: readonly string[],
  execArgv: readonly string[] = process.execArgv,
  heapMb = DEFAULT_INDEX_HEAP_MB
): string[] {
  return [`--max-old-space-size=${heapMb}`, ...execArgv, scriptPath, ...scriptArgs];
}

export function relaunchWithIndexHeapIfNeeded(scriptPath: string): void {
  if (!commandNeedsIndexHeap()) return;
  if (processHasMaxOldSpaceSize()) return;
  if (process.env[RELAUNCH_GUARD_ENV]) return;
  if (process.env.CODEGRAPH_NO_RELAUNCH || process.env.CODEGRAPH_NO_INDEX_HEAP_RELAUNCH) return;

  const argv = buildIndexHeapRelaunchArgv(scriptPath, process.argv.slice(2), process.execArgv, indexHeapMbFromEnv());
  const result = spawnSync(process.execPath, argv, {
    stdio: 'inherit',
    env: { ...process.env, [RELAUNCH_GUARD_ENV]: '1' },
    windowsHide: true,
  });

  if (result.error) {
    return;
  }
  process.exit(result.status ?? (result.signal ? 1 : 0));
}
