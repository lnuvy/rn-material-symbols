//! Project scan — a port of `scanProject` in `src/metro/scanProject.ts`, with the per-file
//! work (stat, cache check, read, pre-filter, parse) run in parallel.
//!
//! Differences from JS that are intentional and invisible to the caller: files, `byFile`
//! and `unparsed` come out sorted by path (JS: directory listing order) so that output is
//! byte-identical across runs whatever the thread scheduling.

use crate::extract::{any_regex_literal, extract_literals, regex_literals, Extracted};
use crate::walk::{compile_js_regex, list_source_files, resolve};
use rayon::prelude::*;
use rayon::ThreadPool;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::sync::OnceLock;
use std::time::{Duration, Instant, UNIX_EPOCH};

pub struct ScanOptions {
    pub sources: Vec<String>,
    pub names: Vec<String>,
    /// JS `RegExp.prototype.source` strings (from `globToRegExp`), matched against root-relative `/` paths.
    pub exclude_regex: Vec<String>,
    pub cache_file: Option<String>,
    /// The caller's key; a fingerprint of `names` is appended (as JS does) before use.
    pub cache_key: String,
}

#[derive(Debug)]
pub struct ScanOutput {
    pub names: Vec<String>,
    /// Files with at least one hit, sorted by path; names per file sorted.
    pub by_file: Vec<(String, Vec<String>)>,
    /// Listed files (JS `files.length`), including any that vanished before they were read.
    pub files: u32,
    pub unparsed: Vec<String>,
    pub ms: f64,
}

#[derive(Serialize, Deserialize, Clone)]
struct CacheEntry {
    #[serde(rename = "mtimeMs")]
    mtime_ms: f64,
    size: u64,
    names: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct CacheShape {
    key: String,
    files: BTreeMap<String, CacheEntry>,
}

/// Worker threads get a 64MB (virtual, lazily committed) stack, so `extract`'s stack guard
/// (`stacker`) almost never has to allocate a new segment. Built once; the global rayon pool
/// is left alone for whoever else shares the process.
pub(crate) fn pool() -> Result<&'static ThreadPool, String> {
    static POOL: OnceLock<Result<ThreadPool, String>> = OnceLock::new();
    POOL.get_or_init(|| {
        rayon::ThreadPoolBuilder::new()
            .thread_name(|i| format!("rnms-scan-{i}"))
            .stack_size(64 * 1024 * 1024)
            .build()
            .map_err(|e| format!("[rn-material-symbols] cannot start scanner threads: {e}"))
    })
    .as_ref()
    .map_err(Clone::clone)
}

/// JS `fs.Stats.mtimeMs` (float milliseconds). Deterministic for a given mtime.
fn duration_ms(d: Duration) -> f64 {
    d.as_secs() as f64 * 1000.0 + f64::from(d.subsec_nanos()) / 1_000_000.0
}

/// Signed milliseconds since the epoch: pre-1970 times are negative and stay distinct, like
/// JS `mtimeMs` (collapsing them to one value would let a same-size edit hit the cache).
fn system_time_ms(t: std::time::SystemTime) -> f64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => duration_ms(d),
        Err(e) => -duration_ms(e.duration()),
    }
}

/// `None` when the platform cannot report an mtime; such a file bypasses the cache entirely.
fn mtime_ms(meta: &fs::Metadata) -> Option<f64> {
    meta.modified().ok().map(system_time_ms)
}

/// JS `nameSetFingerprint`: `<size>:<hash of the sorted names>`. The hash is FNV-1a 64 rather
/// than SHA-1 (the native cache lives in its own file, so the key only has to be stable here).
fn name_set_fingerprint(names: &HashSet<String>) -> String {
    let mut sorted: Vec<&String> = names.iter().collect();
    sorted.sort();
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for n in sorted {
        for b in n.bytes().chain(std::iter::once(0)) {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    format!("{}:{h:016x}", names.len())
}

fn read_cache(file: Option<&str>, key: &str) -> HashMap<String, CacheEntry> {
    let Some(f) = file else { return HashMap::new() };
    let Ok(text) = fs::read_to_string(f) else { return HashMap::new() };
    match serde_json::from_str::<CacheShape>(&text) {
        Ok(c) if c.key == key => c.files.into_iter().collect(),
        _ => HashMap::new(),
    }
}

/// Best-effort, like JS `writeCache`: skipped when the content is unchanged, atomic via a
/// temp file + rename, and any failure is swallowed (and the temp file removed).
fn write_cache(file: &str, shape: &CacheShape) {
    let tmp = format!("{file}.{}.tmp", std::process::id());
    let attempt = || -> std::io::Result<()> {
        let text = serde_json::to_string(shape).map_err(std::io::Error::other)?;
        if fs::read_to_string(file).map(|old| old == text).unwrap_or(false) {
            return Ok(());
        }
        if let Some(dir) = Path::new(file).parent() {
            fs::create_dir_all(dir)?;
        }
        fs::write(&tmp, text)?;
        fs::rename(&tmp, file)
    };
    if attempt().is_err() {
        let _ = fs::remove_file(&tmp);
    }
}

enum FileResult {
    /// `cacheable` is false when the mtime is unknown: the file is never served from or stored in the cache.
    Hit { entry: CacheEntry, unparsed: bool, cacheable: bool },
    /// ENOENT only: the file vanished between listing and reading (e.g. an editor's atomic save).
    Gone,
    /// Any other I/O error. Never skipped silently: the scan fails so the JS side can retry.
    Error(String),
}

fn process(path: &str, cache: &HashMap<String, CacheEntry>, names: &HashSet<String>) -> FileResult {
    let fail = |e: std::io::Error| {
        if e.kind() == std::io::ErrorKind::NotFound {
            FileResult::Gone
        } else {
            FileResult::Error(format!("[rn-material-symbols] cannot read {path}: {e}"))
        }
    };
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(e) => return fail(e),
    };
    let (mtime, size) = (mtime_ms(&meta), meta.len());
    if let (Some(m), Some(c)) = (mtime, cache.get(path)) {
        if c.mtime_ms == m && c.size == size {
            return FileResult::Hit { entry: c.clone(), unparsed: false, cacheable: true };
        }
    }
    // JS `readFileSync(file, 'utf8')` replaces invalid UTF-8 instead of throwing.
    let code = match fs::read(path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(e) => return fail(e),
    };
    let (hits, unparsed) = if any_regex_literal(&code, |n| names.contains(n)) {
        let r = extract_guarded(&code, path);
        (r.literals.into_iter().filter(|n| names.contains(n)).collect(), !r.parsed)
    } else {
        (Vec::new(), false)
    };
    FileResult::Hit {
        entry: CacheEntry { mtime_ms: mtime.unwrap_or(0.0), size, names: hits },
        unparsed,
        // An unparsed file is never cached: the JS side re-extracts every file reported as unparsed (Babel parses
        // Flow, and decodes escapes the regex fallback cannot), so it must be reported on warm runs too.
        cacheable: mtime.is_some() && !unparsed,
    }
}

/// `extract_literals` with a panic in it (an oxc bug, or stacker failing to allocate a stack segment) confined to
/// this file: the file falls back to the regex (`parsed = false`) and the rest of the scan goes on.
///
/// The panic is recovered, but Rust's default panic hook has already printed `thread '…' panicked at …` to stderr
/// (Metro's terminal) by then. That is left as is on purpose: silencing it needs `std::panic::set_hook`, which is
/// process-global, and an addon must not replace the hook of the Node process (or of other addons) it is loaded into.
fn extract_guarded(code: &str, path: &str) -> Extracted {
    catch_unwind(AssertUnwindSafe(|| extract_literals(code, path)))
        .unwrap_or_else(|_| Extracted { literals: regex_literals(code), parsed: false })
}

struct Aggregate {
    names: Vec<String>,
    by_file: Vec<(String, Vec<String>)>,
    files: u32,
    unparsed: Vec<String>,
    next: BTreeMap<String, CacheEntry>,
}

/// Folds per-file results (same order as `files`) into the scan result. The first error in
/// path order fails the scan; vanished files are left out of the cache but still counted.
fn aggregate(files: &[String], results: Vec<FileResult>) -> Result<Aggregate, String> {
    let mut agg = Aggregate {
        names: Vec::new(),
        by_file: Vec::new(),
        files: u32::try_from(files.len()).unwrap_or(u32::MAX),
        unparsed: Vec::new(),
        next: BTreeMap::new(),
    };
    let mut all = BTreeSet::new();
    for (path, r) in files.iter().zip(results) {
        match r {
            FileResult::Error(e) => return Err(e),
            FileResult::Gone => {}
            FileResult::Hit { entry, unparsed, cacheable } => {
                if unparsed {
                    agg.unparsed.push(path.clone());
                }
                if !entry.names.is_empty() {
                    all.extend(entry.names.iter().cloned());
                    agg.by_file.push((path.clone(), entry.names.clone()));
                }
                if cacheable {
                    agg.next.insert(path.clone(), entry);
                }
            }
        }
    }
    agg.names = all.into_iter().collect();
    Ok(agg)
}

/// Bump when extraction results change (a new construct is recognised, a rule is fixed): it is part of
/// the cache key, so caches written by an older extractor are discarded instead of served stale.
pub const EXTRACT_REVISION: u32 = 1;

fn full_cache_key(caller_key: &str, name_set: &HashSet<String>, revision: u32) -> String {
    format!("{}:{}:rev{}", caller_key, name_set_fingerprint(name_set), revision)
}

pub fn scan_impl(opts: &ScanOptions) -> Result<ScanOutput, String> {
    let started = Instant::now();
    let name_set: HashSet<String> = opts.names.iter().cloned().collect();
    let cache_key = full_cache_key(&opts.cache_key, &name_set, EXTRACT_REVISION);

    // JS checks every source before listing any.
    // JS checks every source with `fs.existsSync(s)` on the raw string (so `""` is not found)
    // before listing any, and reports `path.resolve(s)`.
    for s in &opts.sources {
        if !Path::new(s).exists() {
            return Err(format!(
                "[rn-material-symbols] source not found: {} (check the 'sources' option)",
                resolve(s).display()
            ));
        }
    }
    let roots: Vec<_> = opts.sources.iter().map(|s| resolve(s)).collect();
    let exclude: Vec<Regex> = opts
        .exclude_regex
        .iter()
        .map(|s| compile_js_regex(s).map_err(|e| format!("[rn-material-symbols] invalid exclude pattern {s}: {e}")))
        .collect::<Result<_, _>>()?;

    let workers = pool()?;
    let mut files: Vec<String> = Vec::new();
    for root in &roots {
        let listed = workers.install(|| list_source_files(root, &exclude))?;
        files.extend(listed.into_iter().map(|p| p.to_string_lossy().into_owned()));
    }
    files.sort();
    files.dedup();

    let cache = read_cache(opts.cache_file.as_deref(), &cache_key);
    let results: Vec<FileResult> =
        workers.install(|| files.par_iter().map(|p| process(p, &cache, &name_set)).collect());
    let agg = aggregate(&files, results)?;

    if let Some(f) = &opts.cache_file {
        write_cache(f, &CacheShape { key: cache_key, files: agg.next });
    }
    Ok(ScanOutput {
        names: agg.names,
        by_file: agg.by_file,
        files: agg.files,
        unparsed: agg.unparsed,
        ms: started.elapsed().as_secs_f64() * 1000.0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    use crate::walk::tests::tmp;
    fn write(root: &std::path::Path, rel: &str, code: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, code).unwrap();
    }
    fn names() -> Vec<String> {
        ["info", "home", "settings", "search", "close", "check"].iter().map(|s| s.to_string()).collect()
    }
    fn opts(sources: Vec<String>, exclude: Vec<&str>, cache: Option<String>, key: &str) -> ScanOptions {
        ScanOptions { sources, names: names(), exclude_regex: exclude.into_iter().map(String::from).collect(), cache_file: cache, cache_key: key.to_string() }
    }

    #[test]
    fn walks_like_js_and_skips_ignored_dirs() {
        let r = tmp();
        write(&r, "src/App.tsx", "<I name='info'/>");
        write(&r, "src/pages/home/lib/status.ts", "export const a = 'home';");
        write(&r, "node_modules/dep/index.js", "'close'");
        write(&r, "ios/Pods/x.js", "'close'");
        write(&r, ".expo/a.js", "'close'");
        write(&r, "README.md", "'close'");
        let out = scan_impl(&opts(vec![r.to_string_lossy().into()], vec![], None, "k")).unwrap();
        assert_eq!(out.names, vec!["home", "info"]);
        assert_eq!(out.files, 2);
    }

    #[test]
    fn exclude_regex_is_relative_to_source_root() {
        let base = tmp();
        let r = base.join("__tests__").join("app");
        write(&r, "a.ts", "export const a = 'info';");
        write(&r, "__tests__/b.ts", "export const b = 'home';");
        // regex produced by JS globToRegExp('**/__tests__/**')
        let ex = r"^(?:.*/)?__tests__/.*$";
        let out = scan_impl(&opts(vec![r.to_string_lossy().into()], vec![ex], None, "k")).unwrap();
        assert_eq!(out.names, vec!["info"]);
        assert_eq!(out.files, 1);
    }

    #[test]
    fn single_file_source_and_missing_source() {
        let r = tmp();
        write(&r, "x.ts", "export const a = 'close';");
        let out = scan_impl(&opts(vec![r.join("x.ts").to_string_lossy().into()], vec![], None, "k")).unwrap();
        assert_eq!(out.names, vec!["close"]);
        let err = scan_impl(&opts(vec![r.join("nope").to_string_lossy().into()], vec![], None, "k")).err().unwrap();
        assert!(err.contains("source not found") && err.contains("check the 'sources' option"));
    }

    #[test]
    fn cache_is_reused_and_invalidated_by_key() {
        let r = tmp();
        write(&r, "a.ts", "export const a = 'info';");
        let cache = r.join(".c/cache.json").to_string_lossy().to_string();
        scan_impl(&opts(vec![r.to_string_lossy().into()], vec![], Some(cache.clone()), "k1")).unwrap();
        let mut v: serde_json::Value = serde_json::from_str(&fs::read_to_string(&cache).unwrap()).unwrap();
        let file = r.join("a.ts").to_string_lossy().to_string();
        v["files"][&file]["names"] = serde_json::json!(["home"]);
        fs::write(&cache, v.to_string()).unwrap();
        let hit = scan_impl(&opts(vec![r.to_string_lossy().into()], vec![], Some(cache.clone()), "k1")).unwrap();
        assert_eq!(hit.names, vec!["home"]);
        let miss = scan_impl(&opts(vec![r.to_string_lossy().into()], vec![], Some(cache), "k2")).unwrap();
        assert_eq!(miss.names, vec!["info"]);
    }

    #[test]
    fn cache_key_carries_the_extract_revision() {
        let r = tmp();
        write(&r, "a.ts", "export const a = 'info';");
        let cache = r.join(".c/cache.json").to_string_lossy().to_string();
        scan_impl(&opts(vec![r.to_string_lossy().into()], vec![], Some(cache.clone()), "k")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&fs::read_to_string(&cache).unwrap()).unwrap();
        assert!(v["key"].as_str().unwrap().ends_with(&format!(":rev{EXTRACT_REVISION}")));
        let names: HashSet<String> = HashSet::new();
        assert_ne!(full_cache_key("k", &names, EXTRACT_REVISION), full_cache_key("k", &names, EXTRACT_REVISION + 1));
    }

    #[test]
    fn output_is_deterministic() {
        let r = tmp();
        for i in 0..200 {
            write(&r, &format!("d{}/f{}.ts", i % 7, i), if i % 2 == 0 { "export const a = 'info';" } else { "export const a = 'home';" });
        }
        let a = scan_impl(&opts(vec![r.to_string_lossy().into()], vec![], None, "k")).unwrap();
        let b = scan_impl(&opts(vec![r.to_string_lossy().into()], vec![], None, "k")).unwrap();
        // compared as produced (not re-sorted): the order itself must be stable
        assert_eq!(a.by_file, b.by_file);
        assert_eq!(a.unparsed, b.unparsed);
        assert_eq!(a.names, b.names);
        assert_eq!(a.files, b.files);
        let mut sorted = a.by_file.clone();
        sorted.sort();
        assert_eq!(a.by_file, sorted, "by_file is in path order");
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_file_is_a_scan_error_not_a_silent_skip() {
        // Codex review 2026-10-02: only ENOENT may be skipped; any other I/O error must fail the scan
        // so that withMaterialSymbols' auto mode retries with the JS scanner (which throws on it too).
        use std::os::unix::fs::PermissionsExt;
        let r = tmp();
        write(&r, "a.ts", "export const a = 'info';");
        let f = r.join("a.ts");
        fs::set_permissions(&f, fs::Permissions::from_mode(0o000)).unwrap();
        if crate::walk::tests::permissions_not_enforced(&f) {
            fs::set_permissions(&f, fs::Permissions::from_mode(0o644)).unwrap();
            eprintln!("skipped: permission bits are not enforced (root)");
            return;
        }
        let res = scan_impl(&opts(vec![r.to_string_lossy().into()], vec![], None, "k"));
        fs::set_permissions(&f, fs::Permissions::from_mode(0o644)).unwrap();
        let err = res.expect_err("permission error must surface");
        assert!(err.contains("a.ts"), "error names the file: {err}");
    }

    #[test]
    fn unwritable_cache_does_not_fail_the_scan() {
        let r = tmp();
        write(&r, "a.ts", "export const a = 'info';");
        write(&r, "blocker", "x");
        let cache = r.join("blocker/cache.json").to_string_lossy().to_string();
        let out = scan_impl(&opts(vec![r.to_string_lossy().into()], vec![], Some(cache), "k")).unwrap();
        assert_eq!(out.names, vec!["info"]);
    }

    // ---- additions beyond the brief (controller rulings F2/F4 + divergences found vs JS) ----

    fn hit(names: &[&str]) -> FileResult {
        FileResult::Hit {
            entry: CacheEntry { mtime_ms: 1.5, size: 1, names: names.iter().map(|s| s.to_string()).collect() },
            unparsed: false,
            cacheable: true,
        }
    }

    /// F4: JS reports `files.length` (listed files), which still counts files that vanished (ENOENT).
    #[test]
    fn files_counts_listed_files_including_vanished_ones() {
        let files = vec!["/a.ts".to_string(), "/b.ts".to_string(), "/c.ts".to_string()];
        let agg = aggregate(&files, vec![hit(&["info"]), FileResult::Gone, hit(&[])]).unwrap();
        assert_eq!(agg.files, 3);
        assert_eq!(agg.names, vec!["info"]);
        assert_eq!(agg.by_file, vec![("/a.ts".to_string(), vec!["info".to_string()])]);
        // the vanished file is not cached (JS `continue`s before `nextCache.files[file] = …`)
        assert_eq!(agg.next.keys().cloned().collect::<Vec<_>>(), vec!["/a.ts", "/c.ts"]);
    }

    /// A file whose mtime the platform cannot report is reported but never cached.
    #[test]
    fn files_without_an_mtime_are_not_cached() {
        let files = vec!["/a.ts".to_string()];
        let r = FileResult::Hit {
            entry: CacheEntry { mtime_ms: 0.0, size: 1, names: vec!["info".into()] },
            unparsed: false,
            cacheable: false,
        };
        let agg = aggregate(&files, vec![r]).unwrap();
        assert_eq!(agg.names, vec!["info"]);
        assert!(agg.next.is_empty());
    }

    /// F2: the first error in sorted path order fails the scan.
    #[test]
    fn first_error_in_path_order_fails_the_scan() {
        let files = vec!["/a.ts".to_string(), "/b.ts".to_string(), "/c.ts".to_string()];
        let err = aggregate(&files, vec![hit(&["info"]), FileResult::Error("first".into()), FileResult::Error("second".into())])
            .err()
            .unwrap();
        assert_eq!(err, "first");
    }

    /// JS appends a fingerprint of the name set to the cache key, so a changed name set (new
    /// icon set version) never reuses old results under the same user key.
    #[test]
    fn changed_name_set_invalidates_the_cache() {
        let r = tmp();
        write(&r, "a.ts", "export const a = 'info';");
        let cache = r.join("c.json").to_string_lossy().to_string();
        scan_impl(&opts(vec![r.to_string_lossy().into()], vec![], Some(cache.clone()), "k")).unwrap();
        let mut v: serde_json::Value = serde_json::from_str(&fs::read_to_string(&cache).unwrap()).unwrap();
        let file = r.join("a.ts").to_string_lossy().to_string();
        v["files"][&file]["names"] = serde_json::json!(["home"]);
        fs::write(&cache, v.to_string()).unwrap();
        let mut o = opts(vec![r.to_string_lossy().into()], vec![], Some(cache), "k");
        o.names.push("extra_icon".into());
        assert_eq!(scan_impl(&o).unwrap().names, vec!["info"]);
    }

    /// mtimeMs must survive the JSON round trip bit-for-bit, or the cache never hits.
    #[test]
    fn mtime_survives_the_cache_round_trip() {
        let mut files = BTreeMap::new();
        let base = 1_727_900_000u64;
        for i in 0..20_000u64 {
            let d = std::time::Duration::new(base + i * 7919, ((i * 104_729_003) % 1_000_000_000) as u32);
            files.insert(format!("/f{i}"), CacheEntry { mtime_ms: duration_ms(d), size: i, names: vec![] });
        }
        let original: Vec<u64> = files.values().map(|e| e.mtime_ms.to_bits()).collect();
        let text = serde_json::to_string(&CacheShape { key: "k".into(), files }).unwrap();
        let back: CacheShape = serde_json::from_str(&text).unwrap();
        let parsed: Vec<u64> = back.files.values().map(|e| e.mtime_ms.to_bits()).collect();
        let lossy = original.iter().zip(&parsed).filter(|(a, b)| a != b).count();
        assert_eq!(lossy, 0, "{lossy} of {} mtimes changed in the JSON round trip", original.len());
    }

    /// End to end: a second run with the same inputs hits the cache for a file whose mtime
    /// has sub-millisecond precision, and the cache file is not rewritten.
    #[test]
    fn second_run_hits_the_cache_and_leaves_it_untouched() {
        let r = tmp();
        write(&r, "a.ts", "export const a = 'info';");
        let f = fs::File::options().write(true).open(r.join("a.ts")).unwrap();
        f.set_modified(std::time::UNIX_EPOCH + std::time::Duration::new(1_727_900_123, 456_789_123)).unwrap();
        drop(f);
        let cache = r.join("c.json").to_string_lossy().to_string();
        scan_impl(&opts(vec![r.to_string_lossy().into()], vec![], Some(cache.clone()), "k")).unwrap();
        let first = fs::read_to_string(&cache).unwrap();
        // mark the cache so a hit is observable
        let tampered = first.replace("[\"info\"]", "[\"home\"]");
        assert_ne!(first, tampered);
        fs::write(&cache, &tampered).unwrap();
        let old = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000_000);
        fs::File::options().write(true).open(&cache).unwrap().set_modified(old).unwrap();
        let out = scan_impl(&opts(vec![r.to_string_lossy().into()], vec![], Some(cache.clone()), "k")).unwrap();
        assert_eq!(out.names, vec!["home"], "cache hit");
        assert_eq!(fs::read_to_string(&cache).unwrap(), tampered);
        assert_eq!(fs::metadata(&cache).unwrap().modified().unwrap(), old, "identical content is not rewritten");
        assert!(fs::read_dir(&*r).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
    }

    /// JS reads with `readFileSync(file, 'utf8')`, which replaces invalid UTF-8 instead of throwing.
    #[test]
    fn invalid_utf8_is_decoded_lossily_like_node() {
        let r = tmp();
        fs::write(r.join("a.ts"), b"export const a = 'info'; // \xff\xfe broken\n").unwrap();
        let out = scan_impl(&opts(vec![r.to_string_lossy().into()], vec![], None, "k")).unwrap();
        assert_eq!(out.names, vec!["info"]);
    }

    /// JS checks every source exists before listing anything, and reports `path.resolve(s)`.
    #[test]
    fn missing_source_is_reported_before_listing_and_resolved() {
        let r = tmp();
        write(&r, "a.ts", "'info'");
        let missing = format!("{}/x/../nope", r.to_string_lossy());
        let err = scan_impl(&opts(vec![r.to_string_lossy().into(), missing], vec![], None, "k")).err().unwrap();
        assert_eq!(
            err,
            format!("[rn-material-symbols] source not found: {} (check the 'sources' option)", r.join("nope").to_string_lossy())
        );
    }

    /// Overlapping sources are deduplicated (JS `new Set`) and paths are normalized like `path.resolve`.
    #[test]
    fn overlapping_sources_are_deduplicated() {
        let r = tmp();
        write(&r, "src/a.ts", "export const a = 'info';");
        let s1 = r.to_string_lossy().to_string();
        let s2 = format!("{}/src/./", r.to_string_lossy());
        let out = scan_impl(&opts(vec![s1, s2], vec![], None, "k")).unwrap();
        assert_eq!(out.files, 1);
        assert_eq!(out.by_file.len(), 1);
        assert_eq!(out.by_file[0].0, r.join("src").join("a.ts").to_string_lossy());
    }

    /// Codex cross-check: a pre-1970 mtime used to collapse to 0.0, so the cache hit was decided
    /// by size alone and a same-size edit kept stale names. JS keeps distinct negative mtimeMs.
    #[test]
    fn pre_epoch_mtime_edits_are_not_served_from_the_cache() {
        let r = tmp();
        let file = r.join("a.ts");
        let set = |code: &str, secs_before: u64| {
            fs::write(&file, code).unwrap();
            let t = std::time::UNIX_EPOCH - std::time::Duration::new(secs_before, 123_000_000);
            fs::File::options().write(true).open(&file).unwrap().set_modified(t).unwrap();
        };
        let cache = r.join("c.json").to_string_lossy().to_string();
        set("export const a = 'info';", 1_000);
        let first = scan_impl(&opts(vec![r.to_string_lossy().into()], vec![], Some(cache.clone()), "k")).unwrap();
        assert_eq!(first.names, vec!["info"]);
        set("export const a = 'home';", 2_000); // same size, different (pre-1970) mtime
        let second = scan_impl(&opts(vec![r.to_string_lossy().into()], vec![], Some(cache), "k")).unwrap();
        assert_eq!(second.names, vec!["home"]);
    }

    #[test]
    fn signed_mtime_ms_of_pre_epoch_times_is_negative_and_distinct() {
        let a = system_time_ms(std::time::UNIX_EPOCH - std::time::Duration::from_millis(1_500));
        let b = system_time_ms(std::time::UNIX_EPOCH - std::time::Duration::from_millis(2_500));
        assert_eq!(a, -1_500.0);
        assert_eq!(b, -2_500.0);
        assert_eq!(system_time_ms(std::time::UNIX_EPOCH + std::time::Duration::from_micros(1_500)), 1.5);
    }

    /// JS `fs.existsSync('')` is false → "source not found" with `path.resolve('')` (the cwd).
    #[test]
    fn empty_source_string_is_not_found() {
        let err = scan_impl(&opts(vec![String::new()], vec![], None, "k")).err().unwrap();
        let cwd = std::env::current_dir().unwrap();
        assert_eq!(err, format!("[rn-material-symbols] source not found: {} (check the 'sources' option)", cwd.display()));
    }

    /// Codex cross-check: on Unix a backslash is an ordinary filename character. JS
    /// (`path.relative(...).split('/').join('/')`) keeps it, so `foo\bar.ts` is not under `foo/`.
    #[cfg(unix)]
    #[test]
    fn backslash_in_a_unix_filename_is_not_a_separator() {
        let r = tmp();
        write(&r, "foo\\bar.ts", "export const a = 'info';");
        let out = scan_impl(&opts(vec![r.to_string_lossy().into()], vec![r"^foo\/.*$"], None, "k")).unwrap();
        assert_eq!(out.names, vec!["info"]);
        assert_eq!(out.files, 1);
    }

    #[test]
    fn invalid_exclude_regex_is_an_error() {
        let r = tmp();
        let err = scan_impl(&opts(vec![r.to_string_lossy().into()], vec!["("], None, "k")).err().unwrap();
        assert!(err.contains("invalid exclude pattern"), "{err}");
    }

    /// The JS side re-extracts every unparsed file, so an unparsed file must be reported on every run: it is never
    /// written to the cache (a warm hit would report it as parsed and drop the names only Babel finds).
    #[test]
    fn unparsed_files_are_not_cached_and_reported_on_every_run() {
        let r = tmp();
        // Flow exact object type: oxc rejects it (Babel parses it); the escaped name is invisible to the regex
        write(&r, "a.js", "type Icon = {| name: string |}; const a = \"info\"; const b = \"ho\\u006de\";");
        write(&r, "b.ts", "export const b = 'close';");
        let cache = r.join("c.json").to_string_lossy().to_string();
        let o = || opts(vec![r.to_string_lossy().into()], vec![], Some(cache.clone()), "k");
        let a = r.join("a.js").to_string_lossy().to_string();
        for run in ["cold", "warm"] {
            let out = scan_impl(&o()).unwrap();
            assert_eq!(out.unparsed, vec![a.clone()], "{run}");
            assert_eq!(out.names, vec!["close", "info"], "{run}");
            let shape: CacheShape = serde_json::from_str(&fs::read_to_string(&cache).unwrap()).unwrap();
            assert!(!shape.files.contains_key(&a), "{run}: unparsed file cached");
            assert!(shape.files.contains_key(&r.join("b.ts").to_string_lossy().to_string()), "{run}");
        }
    }

    /// A panic while extracting one file (an oxc bug, stacker failing to allocate) only sends that file to the regex
    /// fallback; the scan itself succeeds.
    #[test]
    fn a_panic_in_one_file_falls_back_for_that_file_only() {
        let r = tmp();
        write(&r, "boom.ts", &format!("export const a = 'info'; // {}", crate::extract::TEST_PANIC_MARKER));
        write(&r, "ok.ts", "export const b = 'home';");
        let out = scan_impl(&opts(vec![r.to_string_lossy().into()], vec![], None, "k")).unwrap();
        assert_eq!(out.names, vec!["home", "info"]);
        assert_eq!(out.unparsed, vec![r.join("boom.ts").to_string_lossy().to_string()]);
        assert_eq!(out.files, 2);
    }
}
