export interface NativeScanOutput {
  names: string[];
  byFile: Record<string, string[]>;
  files: number;
  unparsed: string[];
  ms: number;
}

export interface NativeBinding {
  version(): string;
  scan(options: {
    sources: string[];
    names: string[];
    excludeRegex: string[];
    cacheFile?: string;
    cacheKey: string;
  }): NativeScanOutput;
  extractLiterals(code: string, filename: string): { literals: string[]; parsed: boolean };
}

export type ScannerMode = 'auto' | 'js' | 'native';

let cached: { binding: NativeBinding | null; error?: unknown } | undefined;

/**
 * Loads the native binding once and memoizes the outcome, failure included. On success returns the binding; if the
 * require fails it THROWS the memoized load error (use `isNotAvailable` to tell "no binary here" from "broken
 * install"). The `null` return is only for injected loaders (`ScanOptions.loadNative`) that mean "not available".
 */
export function loadNative(): NativeBinding | null {
  if (cached === undefined) {
    try {
      cached = { binding: require('rn-material-symbols-scanner-native') as NativeBinding };
    } catch (error) {
      cached = { binding: null, error };
    }
  }
  if (cached.error !== undefined) throw cached.error;
  return cached.binding;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const firstLine = (e: unknown) => errorMessage(e).split('\n')[0];

/** Walks the `cause` chain (the napi loader links one message-only Error per failed candidate). */
function causeChain(e: unknown): unknown[] {
  const out: unknown[] = [];
  for (let cur: unknown = e, i = 0; cur !== undefined && cur !== null && i < 32; i += 1) {
    out.push(cur);
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
}

/**
 * A "missing" chain entry: Cannot find module for a candidate binding path (./scanner.*.node|cjs|js) or for a platform
 * package (rn-material-symbols-scanner-native-*). Any other missing module (e.g. a runtime dependency of an installed
 * candidate) is NOT a missing binary. Shared with test/parity/loadNative.ts.
 */
export const CANDIDATE_MISSING =
  /^Cannot find module '(?:\.\/scanner\.[\w.-]+\.(?:node|cjs|js)|rn-material-symbols-scanner-native(?:-[\w-]+)?(?:\/package\.json)?)'/;

const NAPI_TOP = 'Cannot find native binding';
const MAX_DESCRIPTION_CHARS = 600;

/**
 * Describes a load error for humans. Reports the top message first, then the entries that are NOT plain missing
 * candidates (e.g. a dlopen error buried among six "Cannot find module" entries); pure missing entries are only listed
 * when nothing else explains the failure. Capped by characters, not entry count.
 */
export function describeLoadError(e: unknown): string {
  const [top, ...rest] = causeChain(e).map(firstLine);
  const unique = [...new Set(rest)].filter((l) => l !== top);
  const informative = unique.filter((l) => !CANDIDATE_MISSING.test(l));
  const shown = [top, ...(informative.length > 0 ? informative : unique)].join(' <- ');
  return shown.length > MAX_DESCRIPTION_CHARS ? `${shown.slice(0, MAX_DESCRIPTION_CHARS - 1)}…` : shown;
}

/**
 * True only when the failure means "no binary for this platform": the package itself is missing, or the napi loader is
 * installed and EVERY chain entry is a missing candidate (strict match). A dlopen error, a missing non-candidate module,
 * or an unexpected error shape is a real problem and must be surfaced. "Unsupported OS/architecture" is the napi loader's
 * own message for platforms it has no candidate for; it counts as not-available only when it is the sole reason.
 */
export function isNotAvailable(e: unknown): boolean {
  const top = e as { code?: string } | null | undefined;
  const topLine = firstLine(e);
  if (top?.code === 'MODULE_NOT_FOUND' && /^Cannot find module 'rn-material-symbols-scanner-native'/.test(topLine)) return true;
  if (!topLine.startsWith(NAPI_TOP)) return false;
  const chain = causeChain(e).slice(1);
  if (chain.some((c) => Array.isArray(c) || (c as { errors?: unknown })?.errors)) return false; // unexpected shape: do not guess
  const reasons = chain.map(firstLine);
  if (reasons.length === 0) return false;
  if (reasons.length === 1 && /^Unsupported (?:OS|architecture)/.test(reasons[0])) return true;
  return reasons.every((r) => CANDIDATE_MISSING.test(r));
}

export function nativeCacheFile(cacheFile: string | undefined): string | undefined {
  if (!cacheFile) return undefined;
  return `${cacheFile.replace(/\.json$/, '')}.native.json`;
}

/** Spec 6.5: native and package must agree on major.minor. Returns a warning message, or undefined when compatible. */
export function versionMismatch(nativeVersion: string, packageVersion: string): string | undefined {
  const mm = (v: string) => v.split('.').slice(0, 2).join('.');
  if (mm(nativeVersion) === mm(packageVersion)) return undefined;
  return `rn-material-symbols-scanner-native ${nativeVersion} does not match rn-material-symbols ${packageVersion} (major.minor differ); using it anyway`;
}
