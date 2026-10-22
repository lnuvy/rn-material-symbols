import fs from 'node:fs';
import path from 'node:path';
import type { FileSummary, SummaryCache } from './usage';

/** Bump when summarizeFile's output changes, so summaries from an older analyzer are not reused. */
export const USAGE_REVISION = 1;

interface Entry {
  mtimeMs: number;
  size: number;
  /** wrapper-name set (joined) → summary */
  summaries: Record<string, FileSummary>;
}

interface Shape {
  key: string;
  files: Record<string, Entry>;
}

/**
 * Per-file analyzer summaries keyed by mtime and size, persisted next to the scan cache. Best-effort: a missing or
 * corrupt file starts empty, and a failed write is ignored (the next run recomputes).
 */
export function fileSummaryCache(file: string, version: string): SummaryCache & { save(): void } {
  const key = `${version}:usage${USAGE_REVISION}`;
  let data: Shape = { key, files: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Shape;
    if (parsed.key === key) data = parsed;
  } catch {
    // no cache yet
  }
  const used = new Set<string>();
  let dirty = false;
  const stat = (f: string) => {
    try {
      const s = fs.statSync(f);
      return { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      return null;
    }
  };
  return {
    get(f, wrapperKey) {
      const entry = data.files[f];
      const now = stat(f);
      if (!entry || !now || entry.mtimeMs !== now.mtimeMs || entry.size !== now.size) return undefined;
      const summary = entry.summaries[wrapperKey];
      if (summary) used.add(f);
      return summary;
    },
    set(f, wrapperKey, summary) {
      const now = stat(f);
      if (!now) return;
      const entry = data.files[f];
      const fresh = entry && entry.mtimeMs === now.mtimeMs && entry.size === now.size ? entry : { ...now, summaries: {} };
      fresh.summaries[wrapperKey] = summary;
      data.files[f] = fresh;
      used.add(f);
      dirty = true;
    },
    save() {
      // keep only files touched in this run, so deleted files do not accumulate
      const next: Shape = { key, files: {} };
      for (const f of used) if (data.files[f]) next.files[f] = data.files[f];
      if (!dirty && Object.keys(next.files).length === Object.keys(data.files).length) return;
      data = next;
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(next));
        fs.renameSync(tmp, file);
      } catch {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          // ignore
        }
      }
      dirty = false;
      used.clear();
    },
  };
}
