use std::collections::BTreeMap;
use std::panic::{catch_unwind, AssertUnwindSafe};

use napi_derive::napi;

mod entities;
mod extract;
mod scan;
mod walk;

/// napi-rs 3 aborts the whole process when a `#[napi]` function panics, so every
/// exported function runs its body through this guard and turns a panic into a
/// regular JS `Error` that the caller can catch (and fall back from).
///
/// It only covers unwinding panics, and in `scan` it is the last resort: a panic while
/// extracting one file is already confined to that file (`scan::extract_guarded`, regex
/// fallback). A native stack overflow (SIGSEGV), an abort or an out-of-memory kill cannot be
/// caught and takes the process down; deep recursion is kept off the small stacks by
/// `stacker` (each parse runs on a stack sized from the file, `extract::with_stack_for`),
/// with the `extract::MAX_NESTING` prescan as a cheap first filter.
fn guard<T>(f: impl FnOnce() -> napi::Result<T>) -> napi::Result<T> {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(result) => result,
        Err(payload) => {
            let message = payload
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown panic".to_string());
            Err(napi::Error::from_reason(format!("rn-material-symbols native scanner panicked: {message}")))
        }
    }
}

#[napi]
pub fn version() -> napi::Result<String> {
    guard(|| Ok(env!("CARGO_PKG_VERSION").to_string()))
}

#[napi(object)]
pub struct JsExtracted {
    /// Icon-shaped literals, sorted.
    pub literals: Vec<String>,
    /// `false` when the file did not parse and the regex fallback produced `literals`.
    pub parsed: bool,
}

#[napi(js_name = "extractLiterals")]
pub fn extract_literals_js(code: String, filename: String) -> napi::Result<JsExtracted> {
    guard(|| {
        let r = extract::extract_literals(&code, &filename);
        Ok(JsExtracted { literals: r.literals.into_iter().collect(), parsed: r.parsed })
    })
}

#[napi(object)]
pub struct JsScanOptions {
    /// Files or directories; relative paths resolve against the process cwd.
    pub sources: Vec<String>,
    /// The icon name set; only these names are reported.
    pub names: Vec<String>,
    /// `globToRegExp(glob).source` strings, matched against root-relative `/` paths.
    pub exclude_regex: Vec<String>,
    /// Cache file (written best-effort). Omit to scan without a cache.
    pub cache_file: Option<String>,
    /// Cache key; a fingerprint of `names` is appended internally.
    pub cache_key: String,
}

#[napi(object)]
pub struct JsScanResult {
    /// All names found, sorted.
    pub names: Vec<String>,
    /// File → names found in it (sorted); only files with hits; keys in sorted path order.
    pub by_file: BTreeMap<String, Vec<String>>,
    /// Number of listed source files.
    pub files: u32,
    /// Files that did not parse and were scanned with the regex fallback, sorted.
    pub unparsed: Vec<String>,
    pub ms: f64,
}

/// Scans `sources` for icon names (parallel, cached). Throws on a missing source, an invalid
/// exclude pattern, any I/O error other than a file vanishing mid-scan, or a panic.
#[napi]
pub fn scan(options: JsScanOptions) -> napi::Result<JsScanResult> {
    guard(|| {
        let out = scan::scan_impl(&scan::ScanOptions {
            sources: options.sources,
            names: options.names,
            exclude_regex: options.exclude_regex,
            cache_file: options.cache_file,
            cache_key: options.cache_key,
        })
        .map_err(napi::Error::from_reason)?;
        Ok(JsScanResult {
            names: out.names,
            by_file: out.by_file.into_iter().collect(),
            files: out.files,
            unparsed: out.unparsed,
            ms: out.ms,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guard_turns_a_panic_into_an_error() {
        let err = guard(|| -> napi::Result<()> { panic!("boom {}", 1) }).unwrap_err();
        assert!(err.reason.contains("panicked: boom 1"), "{}", err.reason);
        let err = guard(|| -> napi::Result<()> { std::panic::panic_any(7_u8) }).unwrap_err();
        assert!(err.reason.contains("unknown panic"), "{}", err.reason);
        assert_eq!(guard(|| Ok(3)).unwrap(), 3);
    }

    /// Rayon re-raises a worker's panic on the thread that called `install`, so a panic in
    /// the parallel section of `scan` reaches `guard` like any other and becomes an error.
    #[test]
    fn guard_catches_a_panic_inside_the_scan_pool() {
        use rayon::prelude::*;
        let err = guard(|| -> napi::Result<()> {
            let pool = scan::pool().map_err(napi::Error::from_reason)?;
            pool.install(|| {
                (0..1000).into_par_iter().for_each(|i| {
                    if i == 777 {
                        panic!("worker boom {i}");
                    }
                })
            });
            Ok(())
        })
        .unwrap_err();
        assert!(err.reason.contains("panicked: worker boom 777"), "{}", err.reason);
        // the pool survives and keeps working
        assert_eq!(scan::pool().unwrap().install(|| (0..10).into_par_iter().sum::<i32>()), 45);
    }
}
