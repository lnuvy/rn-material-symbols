import fs from 'node:fs';
import path from 'node:path';

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;
// Mirrors the scanner: node_modules, native dirs, coverage and dot-dirs. lib/dist/build are real source in FSD apps.
const IGNORED_SEGMENT = /(^|[\\/])(node_modules|ios|android|Pods|coverage|\.[^\\/]+)[\\/]/;
const IGNORED_DIRS = new Set(['node_modules', 'ios', 'android', 'Pods', 'coverage']);

function listDirs(root: string): string[] {
  const out = [root];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
      out.push(...listDirs(path.join(root, entry.name)));
    }
  }
  return out;
}

export function startWatcher(roots: string[], onChange: () => void, debounceMs = 100, onError?: (error: Error) => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  const fire = () => {
    try {
      onChange();
    } catch {
      // the caller logs; a failing rescan must not stop watching
    }
  };
  /** `rel` is relative to the watched root, so ignore rules never match the root's own location. */
  const schedule = (rel: string | null) => {
    if (!rel || !SOURCE_EXT.test(rel) || IGNORED_SEGMENT.test(rel)) return;
    clearTimeout(timer);
    timer = setTimeout(fire, debounceMs);
    timer.unref();
  };

  const watchers: fs.FSWatcher[] = [];
  // An unhandled 'error' event on an FSWatcher is an uncaught exception and would take Metro down.
  const track = (w: fs.FSWatcher) => {
    w.on('error', (error) => {
      try {
        w.close();
      } catch {
        // already closed
      }
      try {
        onError?.(error);
      } catch {
        // reporting must not throw either
      }
    });
    watchers.push(w);
  };
  try {
    for (const root of roots) {
      if (fs.statSync(root).isFile()) {
        const base = path.basename(root);
        track(fs.watch(root, () => schedule(base)));
      } else if (process.platform === 'darwin' || process.platform === 'win32') {
        track(fs.watch(root, { recursive: true }, (_event, file) => schedule(file ? String(file) : null)));
      } else {
        // Linux: recursive fs.watch would also register node_modules; watch each source dir instead.
        for (const dir of listDirs(root)) {
          track(fs.watch(dir, (_event, file) => schedule(file ? path.relative(root, path.join(dir, String(file))) : null)));
        }
      }
    }
  } catch (error) {
    for (const w of watchers) w.close();
    throw error;
  }
  for (const w of watchers) w.unref();

  return () => {
    clearTimeout(timer);
    for (const w of watchers) w.close();
  };
}
