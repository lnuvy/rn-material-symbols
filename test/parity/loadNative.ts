export interface NativeExtract {
  extractLiterals(code: string, file: string): { literals: string[]; parsed: boolean };
}

import { describeLoadError, isNotAvailable } from '../../src/metro/nativeScanner';

// Gate: `pnpm build:native && pnpm test` (CI builds the binary fresh). A stale .node is deliberately not detected.
// Skip ONLY when the production classifier (src/metro/nativeScanner.ts isNotAvailable) says every candidate binding is
// missing; dlopen failures, corrupt/wrong-arch binaries and any other error rethrow.
// RNMS_REQUIRE_NATIVE=1 turns even a genuine "not found" into a failure.

export function loadNative<T = NativeExtract>(): T | null {
  try {
    return require('../../native') as T;
  } catch (e) {
    if (!isNotAvailable(e)) throw e;
    const why = describeLoadError(e);
    if (process.env.RNMS_REQUIRE_NATIVE === '1') {
      throw new Error(`RNMS_REQUIRE_NATIVE=1 but the native binary is unavailable: ${why}`);
    }
    console.warn(`[parity] native binary not found, skipping native parity tests (run pnpm build:native): ${why}`);
    return null;
  }
}
