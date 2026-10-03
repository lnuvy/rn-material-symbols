//! Source file listing — a port of `listSourceFiles` in `src/metro/scanProject.ts`.

use regex::Regex;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

/// Directories that are never app source (JS `IGNORED_DIRS`). Dot directories are skipped too.
const IGNORED_DIRS: [&str; 5] = ["node_modules", "ios", "android", "Pods", "coverage"];

/// JS `SOURCE_EXT`: `/\.(?:[cm]?[jt]sx?)$/`
fn source_ext() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\.(?:[cm]?[jt]sx?)$").unwrap())
}

/// Path as a `/`-separated string, like JS `.split(path.sep).join('/')`: only the platform
/// separator is converted. On Unix a backslash is an ordinary filename character and is kept.
pub fn to_slash(p: &Path) -> String {
    let s = p.to_string_lossy();
    if cfg!(windows) {
        s.replace('\\', "/")
    } else {
        s.into_owned()
    }
}

/// Node `path.resolve(s)`: absolute against the cwd, `.`/`..` and trailing separators removed
/// lexically (symlinks are not resolved).
pub fn resolve(s: &str) -> PathBuf {
    let p = Path::new(s);
    let abs = if p.is_absolute() { p.to_path_buf() } else { std::env::current_dir().unwrap_or_default().join(p) };
    let mut out = PathBuf::new();
    for c in abs.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// Compiles a JS `RegExp.prototype.source` (as produced by `globToRegExp`, no flags) with the
/// same matching behaviour in Rust's `regex`:
/// - an unescaped `.` outside a character class becomes `[^\n\r\u2028\u2029]`, because JS `.`
///   (without the `s` flag) excludes all four line terminators and Rust's `.` only excludes `\n`;
/// - `\/` (JS `.source` escapes every `/`) and the other escapes `globToRegExp` emits are
///   accepted by `regex` as-is.
pub fn compile_js_regex(source: &str) -> Result<Regex, regex::Error> {
    let mut out = String::with_capacity(source.len() + 16);
    let mut chars = source.chars();
    let mut in_class = false;
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                out.push('\\');
                if let Some(n) = chars.next() {
                    out.push(n);
                }
            }
            '[' if !in_class => {
                in_class = true;
                out.push(c);
            }
            ']' if in_class => {
                in_class = false;
                out.push(c);
            }
            '.' if !in_class => out.push_str(r"[^\n\r\x{2028}\x{2029}]"),
            _ => out.push(c),
        }
    }
    Regex::new(&out)
}

/// `source` must already be resolved (`resolve`) and known to exist.
///
/// Mirrors JS exactly: every entry below the root (directories and files) is tested against
/// the exclude regexes by its root-relative `/` path; ignored and dot directories are pruned;
/// symlinks are skipped (Node's `Dirent` reports them as neither file nor directory) except
/// the root itself, which `statSync` follows; a read error anywhere fails the listing (JS
/// `readdirSync` throws). A single-file source is tested by extension and by basename.
pub fn list_source_files(source: &Path, exclude: &[Regex]) -> Result<Vec<PathBuf>, String> {
    let excluded = |rel: &str| exclude.iter().any(|re| re.is_match(rel));
    let meta = std::fs::metadata(source)
        .map_err(|e| format!("[rn-material-symbols] cannot read source {}: {e}", source.display()))?;
    if meta.is_file() {
        let name = source.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        return Ok(if source_ext().is_match(&name) && !excluded(&name) { vec![source.to_path_buf()] } else { vec![] });
    }
    if !meta.is_dir() {
        // JS walks anything that is not a file and `readdirSync` throws ENOTDIR (e.g. a FIFO).
        return Err(format!("[rn-material-symbols] cannot read directory {}: not a directory", source.display()));
    }
    walk_dir(source, source, &excluded)
}

/// One directory level, subdirectories walked in parallel (rayon; inside `scan` this runs on
/// the scanner pool). Directory reads dominate a cold scan of a deep tree (~19k directories in
/// a private production monorepo: ~1 s serially), so they are spread across threads. Output
/// order is not meaningful (the caller sorts); the reported error is deterministic: the first
/// one in this directory's entry order, then the first failing subdirectory in that order.
/// With several I/O errors in one tree the reported one may differ from JS (Rust reads a whole
/// directory before recursing; JS `readdirSync` throws depth-first) — both fail the scan.
fn walk_dir(source: &Path, dir: &Path, excluded: &(dyn Fn(&str) -> bool + Sync)) -> Result<Vec<PathBuf>, String> {
    use rayon::prelude::*;
    let fail = |e: std::io::Error| format!("[rn-material-symbols] cannot read directory {}: {e}", dir.display());
    let mut files = Vec::new();
    let mut subdirs = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(fail)? {
        let entry = entry.map_err(fail)?;
        // Like Node's `Dirent` (and walkdir with follow_links(false)): the entry's own type, a
        // symlink is neither a file nor a directory.
        let ft = entry.file_type().map_err(fail)?;
        let path = entry.path();
        let rel = to_slash(path.strip_prefix(source).unwrap_or(&path));
        if excluded(&rel) {
            continue;
        }
        if ft.is_dir() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !(name.starts_with('.') || IGNORED_DIRS.contains(&name.as_ref())) {
                subdirs.push(path);
            }
        } else if ft.is_file() && source_ext().is_match(&entry.file_name().to_string_lossy()) {
            files.push(path);
        }
    }
    let nested: Vec<Result<Vec<PathBuf>, String>> = subdirs.par_iter().map(|d| walk_dir(source, d, excluded)).collect();
    for r in nested {
        files.extend(r?);
    }
    Ok(files)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::fs;

    /// Temp dir removed on drop (permissions are restored by each test before it returns).
    pub(crate) struct TmpDir(PathBuf);
    impl std::ops::Deref for TmpDir {
        type Target = Path;
        fn deref(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TmpDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// `true` when permission bits are not enforced (running as root, e.g. in CI containers):
    /// a 0o000 entry is still readable there, so permission-error tests cannot fail as intended.
    #[cfg(unix)]
    pub(crate) fn permissions_not_enforced(probe: &Path) -> bool {
        fs::read_dir(probe).is_ok() || fs::read(probe).is_ok()
    }

    pub(crate) fn tmp() -> TmpDir {
        let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        static SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let d = std::env::temp_dir().join(format!("rnms-walk-{}-{n}-{seq}", std::process::id()));
        fs::create_dir_all(&d).unwrap();
        TmpDir(d)
    }
    fn write(root: &Path, rel: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, "'info'").unwrap();
    }
    fn rels(root: &Path, files: Vec<PathBuf>) -> Vec<String> {
        let mut v: Vec<String> = files.iter().map(|f| to_slash(f.strip_prefix(root).unwrap())).collect();
        v.sort();
        v
    }
    fn res(sources: &[&str]) -> Vec<Regex> {
        sources.iter().map(|s| compile_js_regex(s).unwrap()).collect()
    }

    /// Every kind of regex JS `globToRegExp(glob).source` produces (sources and expected matches
    /// captured from Node via tsx on src/metro/scanProject.ts) must match the same paths in Rust.
    #[test]
    fn js_glob_regex_sources_match_like_js() {
        let paths = [
            "__tests__/a.ts", "x/__tests__/b.ts", "a/b.test.tsx", "b.test.tsx", "src/legacy/x/y.ts", "src/legacy",
            "legacy/x.ts", "c.stories.tsx", "d/c.stories.tsx", "build/a.js", "a.b+c?(d)/[x]{y}|z$^/q.ts",
            "aXb+c?(d)/[x]{y}|z$^/q.ts", "dir with space/a.ts", "q/node-mods/a.js", "q/node-mods/b/a.js",
            "anything/at/all", "x", "p/x", "~#&-%@!=,;:\"'<>/f.ts", "é/한글/f.ts", "line\nbreak/x", "a\u{2028}b/x",
            "cr\rx/y", "ps\u{2029}x/y",
        ];
        // (JS RegExp.prototype.source, paths JS matches)
        let table: &[(&str, &[&str])] = &[
            (r"^(?:.*\/)?__tests__\/.*$", &["__tests__/a.ts", "x/__tests__/b.ts"]),
            (r"^(?:.*\/)?[^/]*\.test\.tsx$", &["a/b.test.tsx", "b.test.tsx"]),
            (r"^src\/legacy\/.*$", &["src/legacy/x/y.ts"]),
            (r"^[^/]*\.stories\.tsx$", &["c.stories.tsx"]),
            (r"^build\/.*$", &["build/a.js"]),
            (r"^a\.b\+c\?\(d\)\/\[x\]\{y\}\|z\$\^\/.*$", &["a.b+c?(d)/[x]{y}|z$^/q.ts"]),
            (r"^dir with space\/.*$", &["dir with space/a.ts"]),
            (r"^(?:.*\/)?node-mods\/[^/]*\.js$", &["q/node-mods/a.js"]),
            (
                r"^.*$",
                &[
                    "__tests__/a.ts", "x/__tests__/b.ts", "a/b.test.tsx", "b.test.tsx", "src/legacy/x/y.ts", "src/legacy",
                    "legacy/x.ts", "c.stories.tsx", "d/c.stories.tsx", "build/a.js", "a.b+c?(d)/[x]{y}|z$^/q.ts",
                    "aXb+c?(d)/[x]{y}|z$^/q.ts", "dir with space/a.ts", "q/node-mods/a.js", "q/node-mods/b/a.js",
                    "anything/at/all", "x", "p/x", "~#&-%@!=,;:\"'<>/f.ts", "é/한글/f.ts",
                ],
            ),
            (r"^(?:.*\/)?x$", &["x", "p/x"]),
            (r#"^~#&-%@!=,;:"'<>\/.*$"#, &["~#&-%@!=,;:\"'<>/f.ts"]),
            (r"^é\/한글\/.*$", &["é/한글/f.ts"]),
            // a glob containing a line terminator: JS `.source` escapes it
            (r"^line\nbreak\/.*$", &["line\nbreak/x"]),
            // Node `.source` emits the 6-char escape text for U+2028/U+2029 (verified with node)
            (r"^a\u2028b\/.*$", &["a\u{2028}b/x"]),
            (r"^ps\u2029x\/.*$", &["ps\u{2029}x/y"]),
            (r"^cr\rx\/.*$", &["cr\rx/y"]),
        ];
        for (src, expected) in table {
            let re = compile_js_regex(src).unwrap_or_else(|e| panic!("{src}: {e}"));
            let got: Vec<&str> = paths.iter().copied().filter(|p| re.is_match(p)).collect();
            assert_eq!(&got, expected, "{src}");
        }
    }

    /// JS `.` (no `s` flag) never matches \n, \r, U+2028, U+2029; Rust's `.` only excludes \n.
    #[test]
    fn dot_excludes_js_line_terminators_but_not_inside_classes_or_escapes() {
        let re = compile_js_regex(r"^a.b$").unwrap();
        for s in ["a\rb", "a\u{2028}b", "a\u{2029}b", "a\nb"] {
            assert!(!re.is_match(s), "{s:?}");
        }
        assert!(re.is_match("axb"));
        assert!(compile_js_regex(r"^a\.b$").unwrap().is_match("a.b"));
        assert!(!compile_js_regex(r"^a\.b$").unwrap().is_match("axb"));
        assert!(compile_js_regex(r"^a[.]b$").unwrap().is_match("a.b"));
        assert!(!compile_js_regex(r"^a[.]b$").unwrap().is_match("axb"));
        assert!(compile_js_regex(r"^a[\].]b$").unwrap().is_match("a]b"));
        assert!(compile_js_regex(r"^a\\.b$").unwrap().is_match("a\\xb"));
    }

    #[test]
    fn walks_like_js_list_source_files() {
        let r = tmp();
        for f in [
            "a.ts", "b.tsx", "c.js", "d.jsx", "e.mjs", "f.cjs", "g.mts", "h.cts", "i.d.ts", "j.json", "k.md", "l.tsx.bak",
            ".eslintrc.js", // dot FILES are kept; only dot directories are skipped
            "lib/m.ts", "dist/n.ts", "build/o.ts", // not ignored (feature-sliced `lib/`)
            "node_modules/x.ts", "ios/x.ts", "android/x.ts", "Pods/x.ts", "coverage/x.ts", ".git/x.ts", ".expo/x.ts",
            "deep/node_modules/x.ts", "deep/Pods/x.ts",
        ] {
            write(&r, f);
        }
        // a FILE named like an ignored dir is still a candidate when it has a source extension
        write(&r, "node_modules.ts");
        let got = rels(&r, list_source_files(&r, &[]).unwrap());
        assert_eq!(
            got,
            vec![
                ".eslintrc.js", "a.ts", "b.tsx", "build/o.ts", "c.js", "d.jsx", "dist/n.ts", "e.mjs", "f.cjs",
                "g.mts", "h.cts", "i.d.ts", "lib/m.ts", "node_modules.ts",
            ]
        );
    }

    /// The walk is parallel per directory: a wide and deep tree must come back complete, with
    /// ignored/dot/excluded directories pruned at every level, regardless of thread scheduling.
    /// Called directly, this runs on the global rayon pool; the production path (the scanner pool
    /// via `scan_impl`) is covered end to end by test/parity/scan.parity.test.ts.
    #[test]
    fn parallel_walk_lists_a_wide_deep_tree_completely() {
        let r = tmp();
        let mut expected = Vec::new();
        for a in 0..12 {
            for b in 0..8 {
                let rel = format!("p{a}/f{b}/deep/er/x{a}_{b}.ts");
                write(&r, &rel);
                expected.push(rel);
                write(&r, &format!("p{a}/f{b}/node_modules/n.ts"));
                write(&r, &format!("p{a}/f{b}/.cache/c.ts"));
                write(&r, &format!("p{a}/f{b}/gen/g.ts"));
            }
        }
        expected.sort();
        for _ in 0..5 {
            let got = rels(&r, list_source_files(&r, &res(&[r"^(?:.*\/)?gen$"])).unwrap());
            assert_eq!(got, expected);
        }
    }

    #[test]
    fn exclude_applies_to_directories_and_files_by_root_relative_path() {
        let r = tmp();
        write(&r, "src/a.ts");
        write(&r, "src/gen/b.ts");
        write(&r, "src/c.test.ts");
        write(&r, "gen/d.ts");
        // `^src/gen$` only matches the DIRECTORY entry: JS tests dirs too, so it prunes the subtree
        let got = rels(&r, list_source_files(&r, &res(&[r"^src\/gen$", r"^(?:.*\/)?[^/]*\.test\.ts$"])).unwrap());
        assert_eq!(got, vec!["gen/d.ts", "src/a.ts"]);
    }

    #[test]
    fn single_file_source_uses_extension_and_basename_exclude() {
        let r = tmp();
        write(&r, "dir/a.ts");
        write(&r, "dir/b.md");
        let a = r.join("dir/a.ts");
        assert_eq!(list_source_files(&a, &[]).unwrap(), vec![a.clone()]);
        assert!(list_source_files(&r.join("dir/b.md"), &[]).unwrap().is_empty());
        // the basename, not the root-relative or absolute path, is tested
        assert!(list_source_files(&a, &res(&[r"^a\.ts$"])).unwrap().is_empty());
        assert_eq!(list_source_files(&a, &res(&[r"^dir\/a\.ts$"])).unwrap(), vec![a]);
    }

    /// `readdir({ withFileTypes: true })` reports symlinks as neither file nor directory, so JS
    /// skips symlinked files AND directories; a symlinked SOURCE root is followed (`statSync`).
    #[cfg(unix)]
    #[test]
    fn symlinks_are_skipped_but_a_symlinked_root_is_followed() {
        use std::os::unix::fs::symlink;
        let r = tmp();
        write(&r, "real/a.ts");
        write(&r, "outside/b.ts");
        symlink(r.join("outside/b.ts"), r.join("real/link.ts")).unwrap();
        symlink(r.join("outside"), r.join("real/linkdir")).unwrap();
        let got = rels(&r.join("real"), list_source_files(&r.join("real"), &[]).unwrap());
        assert_eq!(got, vec!["a.ts"]);
        symlink(r.join("real"), r.join("root-link")).unwrap();
        let got = list_source_files(&r.join("root-link"), &[]).unwrap();
        assert_eq!(got, vec![r.join("root-link").join("a.ts")]);
    }

    /// JS `readdirSync` throws on an unreadable directory; it must not be skipped silently.
    #[cfg(unix)]
    #[test]
    fn unreadable_directory_is_an_error() {
        use std::os::unix::fs::PermissionsExt;
        let r = tmp();
        write(&r, "a.ts");
        write(&r, "locked/b.ts");
        fs::set_permissions(r.join("locked"), fs::Permissions::from_mode(0o000)).unwrap();
        if permissions_not_enforced(&r.join("locked")) {
            fs::set_permissions(r.join("locked"), fs::Permissions::from_mode(0o755)).unwrap();
            eprintln!("skipped: permission bits are not enforced (root)");
            return;
        }
        let res = list_source_files(&r, &[]);
        fs::set_permissions(r.join("locked"), fs::Permissions::from_mode(0o755)).unwrap();
        let err = res.expect_err("must fail");
        assert!(err.contains("locked"), "{err}");
    }

    /// JS `path.relative(...).split(path.sep).join('/')` keeps a backslash on POSIX (verified with
    /// Node: `listSourceFiles(dir, [globToRegExp('foo/**')])` still returns `foo\\bar.ts`).
    #[cfg(unix)]
    #[test]
    fn backslash_in_a_unix_filename_is_kept_for_exclude_matching() {
        let r = tmp();
        write(&r, "foo\\bar.ts");
        write(&r, "foo/baz.ts");
        let got = rels(&r, list_source_files(&r, &res(&[r"^foo\/.*$"])).unwrap());
        assert_eq!(got, vec!["foo\\bar.ts"]);
        assert_eq!(to_slash(Path::new("a\\b/c")), "a\\b/c");
    }

    /// The filesystem root `path.resolve('/')` yields: `/` on POSIX, the cwd's drive root (`D:\`) on Windows, where a
    /// rooted path without a drive takes the current drive (Node `path.win32.resolve('/a')` is `D:\a`).
    fn cwd_root() -> PathBuf {
        std::env::current_dir().unwrap().components().take_while(|c| matches!(c, Component::Prefix(_) | Component::RootDir)).collect()
    }

    #[test]
    fn resolve_is_lexical_like_path_resolve() {
        let cwd = std::env::current_dir().unwrap();
        let root = cwd_root();
        assert_eq!(resolve("/a/b/../c/./d/"), root.join("a").join("c").join("d"));
        assert_eq!(resolve("/.."), root);
        assert_eq!(resolve("x/y/.."), cwd.join("x"));
        assert_eq!(resolve(""), cwd);
        #[cfg(unix)]
        assert_eq!(resolve("/a/b/../c/./d/"), PathBuf::from("/a/c/d"));
        #[cfg(windows)]
        {
            assert_eq!(resolve(r"C:\a\b\..\c/./d\"), PathBuf::from(r"C:\a\c\d"));
            assert_eq!(resolve(r"C:\.."), PathBuf::from(r"C:\"));
        }
    }
}
