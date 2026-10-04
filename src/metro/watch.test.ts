import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startWatcher } from './watch';

// every temp dir this file creates is removed after the file's tests
const createdTempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of createdTempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tmpProject() {
  const root = tempDir('rnms-watch-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
  return root;
}

test('debounces bursts of source changes into one call', async () => {
  const root = tmpProject();
  const onChange = jest.fn();
  // 300 ms, not 50: on a loaded macOS CI runner FSEvents delivered one synchronous burst in two batches more than
  // 50 ms apart (ci run on 03107cd), so a 50 ms window measured FSEvents batching rather than our debounce
  const stop = startWatcher([root], onChange, 300);
  // macOS FSEvents can deliver the fixture's own setup writes after the watch starts (seen as a second call under
  // load), so let the watcher settle and only count what the burst below causes
  await wait(500);
  onChange.mockClear();
  for (let i = 0; i < 3; i += 1) fs.writeFileSync(path.join(root, 'src', 'a.tsx'), `'info${i}'`);
  await wait(900);
  stop();
  expect(onChange).toHaveBeenCalledTimes(1);
});

test('ignores non-source files and node_modules', async () => {
  const root = tmpProject();
  const onChange = jest.fn();
  const stop = startWatcher([root], onChange, 50);
  await wait(300);
  onChange.mockClear(); // see the debounce test: only count what the writes below cause
  fs.writeFileSync(path.join(root, 'src', 'notes.md'), 'x');
  fs.writeFileSync(path.join(root, 'node_modules', 'x', 'index.js'), "'info'");
  await wait(400);
  stop();
  expect(onChange).not.toHaveBeenCalled();
});

test('callback errors do not kill the watcher', async () => {
  const root = tmpProject();
  let calls = 0;
  const stop = startWatcher([root], () => {
    calls += 1;
    throw new Error('boom');
  }, 50);
  await wait(300);
  calls = 0;
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), "'a'");
  await wait(300);
  // FSEvents may split one write into two batches more than the debounce apart, so count "at least" and require that
  // the write after a throwing callback still fires
  const afterFirst = calls;
  expect(afterFirst).toBeGreaterThanOrEqual(1);
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), "'b'");
  await wait(300);
  stop();
  expect(calls).toBeGreaterThan(afterFirst);
});

test('accepts a single file as a root', async () => {
  const root = tmpProject();
  const file = path.join(root, 'src', 'App.tsx');
  fs.writeFileSync(file, "'a'");
  const onChange = jest.fn();
  const stop = startWatcher([file], onChange, 50);
  await wait(300);
  onChange.mockClear(); // the fixture's own write above can arrive late
  fs.writeFileSync(file, "'b'");
  await wait(300);
  stop();
  expect(onChange).toHaveBeenCalledTimes(1);
});

test('an FSWatcher error is contained: no throw, watcher closed, onError called', async () => {
  const root = tmpProject();
  const real = fs.watch;
  const created: fs.FSWatcher[] = [];
  const spy = jest.spyOn(fs, 'watch').mockImplementation(((...args: unknown[]) => {
    const w = (real as (...a: unknown[]) => fs.FSWatcher)(...args);
    created.push(w);
    return w;
  }) as never);
  try {
    const onError = jest.fn();
    const stop = startWatcher([root], jest.fn(), 50, onError);
    expect(created.length).toBeGreaterThan(0);
    const closeSpy = jest.spyOn(created[0], 'close');
    const err = Object.assign(new Error('EMFILE'), { code: 'EMFILE' });
    expect(() => created[0].emit('error', err)).not.toThrow();
    expect(closeSpy).toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(err);
    stop();
  } finally {
    spy.mockRestore();
  }
});

test('an FSWatcher error without onError is still swallowed', () => {
  const root = tmpProject();
  const real = fs.watch;
  let w: fs.FSWatcher | undefined;
  const spy = jest.spyOn(fs, 'watch').mockImplementation(((...args: unknown[]) => {
    w = (real as (...a: unknown[]) => fs.FSWatcher)(...args);
    return w;
  }) as never);
  try {
    const stop = startWatcher([root], jest.fn(), 50);
    expect(() => w!.emit('error', new Error('boom'))).not.toThrow();
    stop();
  } finally {
    spy.mockRestore();
  }
});
