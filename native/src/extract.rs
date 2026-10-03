//! Icon-shaped literal extraction — a port of `src/metro/extractLiterals.ts`.
//!
//! The JS implementation is the reference: whatever string literals Babel's AST walk keeps
//! there, this visitor keeps here. Comments on each override name the Babel rule it mirrors.

use std::collections::BTreeSet;
use std::sync::OnceLock;

use oxc_allocator::Allocator;
use oxc_ast::ast::*;
use oxc_ast_visit::{walk, Visit};
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;
use oxc_syntax::scope::ScopeFlags;
use regex::Regex;

use crate::entities::decode_jsx_attribute;

pub struct Extracted {
    pub literals: BTreeSet<String>,
    pub parsed: bool,
}

/// `^[a-z0-9_]+$`
pub fn is_icon_shaped(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

fn fallback_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // Same matches as JS `/(['"`])([a-z0-9_]+)\1/g` (the body cannot contain a quote, so the
    // back-reference is equivalent to one alternative per quote kind).
    RE.get_or_init(|| Regex::new(r#"'([a-z0-9_]+)'|"([a-z0-9_]+)"|`([a-z0-9_]+)`"#).unwrap())
}

pub fn regex_literals(code: &str) -> BTreeSet<String> {
    fallback_re()
        .captures_iter(code)
        .filter_map(|c| c.get(1).or_else(|| c.get(2)).or_else(|| c.get(3)))
        .map(|m| m.as_str().to_string())
        .collect()
}

/// `true` when any quoted icon-shaped string (same matches as `regex_literals`) satisfies
/// `wanted` — the scanner's pre-filter (JS `CANDIDATE` + `nameSet.has`), without allocating.
pub fn any_regex_literal(code: &str, wanted: impl Fn(&str) -> bool) -> bool {
    fallback_re()
        .captures_iter(code)
        .filter_map(|c| c.get(1).or_else(|| c.get(2)).or_else(|| c.get(3)))
        .any(|m| wanted(m.as_str()))
}

/// Bracket nesting above which a file is not parsed (regex fallback, `parsed = false`).
///
/// This is a parity rule more than a safety one. Babel recurses and the JS extractor falls
/// back when it throws `RangeError`; in a cold Node process that happens between ~300 and
/// ~400 levels (measured: `[` 350, `(` 400, `{a:` 300), so 300 stays close to where Babel
/// gives up. Stack safety comes from `with_stack_for` (stacker sizes the stack for each
/// parse from the file's bytes; scan workers start with 64MB); on a plain 2MB thread oxc
/// release builds survive ~940 levels of the worst construct (`{a:`), ~3x this limit.
pub const MAX_NESTING: usize = 300;

/// Maximum depth of `(` `[` `{` nesting, counted on raw bytes (strings and comments
/// included; unmatched closers never go below zero). Template `${` counts through its `{`.
pub fn max_nesting(code: &str) -> usize {
    let (mut depth, mut max) = (0usize, 0usize);
    for b in code.bytes() {
        match b {
            b'(' | b'[' | b'{' => {
                depth += 1;
                max = max.max(depth);
            }
            b')' | b']' | b'}' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    max
}

/// Stack the parse + semantic + visit of one file may need, estimated from its bytes.
///
/// oxc recurses once per nesting level, and many constructs nest without brackets, so the
/// `MAX_NESTING` prescan alone cannot bound the depth. Every construct that nests spends at
/// least one byte per level, and the cheap-in-bytes ones are punctuation (`!`, `[`/`]`,
/// `A<`/`>`, …) or keywords (`new `, `keyof `, `typeof `, …). So each ASCII punctuation
/// byte is charged `STACK_PER_PUNCT_BYTE` and every other byte `STACK_PER_OTHER_BYTE`.
///
/// Measured stack per nesting level without this guard (2MB threads, oxc 0.146,
/// release / debug), and the headroom the weights give over it (≥ 2x everywhere):
///   `A<A<…>>` generics   1,648 / 3,505 B   (2 punct + 1 other) → 2.6x / 2.0x
///   `[[…]]`, `((…))`     1,999 / 3,021 B   (2 punct)           → 2.0x / 2.0x
///   bracket nesting with a closer in a string per level (`[']',`, `{a:"}",b:`, a
///   string of 200 closers every 200 levels), i.e. invisible to the prescan
///                        1,984–2,287 / 2,621–3,464 B           → ≥ 3.1x / ≥ 3.1x
///   `new new …`            447 / 1,499 B   (4 other)           → 2.3x / 2.7x
///   `!!!…`, `a!!!…`        127 / 1,264 B   (1 punct)           → 16x / 2.4x
///   `keyof keyof …`        543 / 1,215 B   (6 other)           → 2.8x / 5.1x
///   `a = a = …`            914 / 1,231 B   (1 punct + 3 other) → 3.1x / 5.0x
///   `.b` / `()` / `[0]` / `T[]` chains, `?:`, `=>`, `**`, `+`, `typeof`, `void`, `await`,
///   `as`, `if`, `else if`, `do`, labels, conditional types, JSX: ≥ 2.4x
/// (`A | A | …` unions never overflowed: oxc parses them iteratively.)
/// The table is pinned by `nesting_constructs_do_not_overflow_a_2mb_worker_stack`.
const STACK_BASE: usize = 2 << 20;
const STACK_PER_PUNCT_BYTE: usize = if cfg!(debug_assertions) { 3_072 } else { 2_048 };
const STACK_PER_OTHER_BYTE: usize = if cfg!(debug_assertions) { 1_024 } else { 256 };
/// Upper bound for one grown stack segment. It is virtual: on Unix only touched pages are
/// committed (real use stays far below the estimate — e.g. 20MB for a 1MB `a()()…` chain).
/// On Windows stacker uses a fiber whose size is committed up front; if that allocation
/// fails stacker panics, which `guard()` turns into a JS error (→ JS scanner fallback).
const STACK_MAX: usize = 2 << 30;

fn stack_needed(code: &str) -> usize {
    let punct = code.bytes().filter(u8::is_ascii_punctuation).count();
    let other = code.len() - punct;
    STACK_BASE
        .saturating_add(punct.saturating_mul(STACK_PER_PUNCT_BYTE))
        .saturating_add(other.saturating_mul(STACK_PER_OTHER_BYTE))
}

/// Runs `f` on the current stack if enough of it is left for `code`, otherwise on a freshly
/// allocated segment (stacker), so deep recursion cannot overflow a small rayon/Node stack.
/// `None` when even `STACK_MAX` would not be a safe bound (sources over roughly 1–8MB,
/// depending on punctuation density): the caller then falls back to the regex instead of
/// risking a crash.
fn with_stack_for<R>(code: &str, f: impl FnOnce() -> R) -> Option<R> {
    let needed = stack_needed(code);
    if needed > STACK_MAX {
        return None;
    }
    Some(match stacker::remaining_stack() {
        Some(remaining) if remaining >= needed => f(),
        _ => stacker::grow(needed, f),
    })
}

/// JS: `/\.d\.[cm]?ts$/`
fn declaration_file(filename: &str) -> bool {
    filename.ends_with(".d.ts") || filename.ends_with(".d.mts") || filename.ends_with(".d.cts")
}

/// Mirrors JS `pluginsFor`: `.tsx` → TypeScript + JSX, `.ts/.mts/.cts` → TypeScript only,
/// everything else → JS + JSX.
///
/// Babel's `sourceType: 'unambiguous'` parses as a module first and, with `errorRecovery`,
/// keeps module-grammar (strict mode) errors even when the file turns out to have no
/// import/export — so `with`, legacy octal or `var await` make the JS side fall back. oxc's
/// `with_unambiguous` parses those files as sloppy scripts instead, so module grammar is
/// used for every file to get the same accept/reject decision.
fn source_type(filename: &str) -> SourceType {
    let typescript = [".ts", ".mts", ".cts", ".tsx"].iter().any(|ext| filename.ends_with(ext));
    let base = SourceType::from_path(filename).unwrap_or_else(|_| SourceType::jsx());
    let base = if typescript { base } else { base.with_jsx(true) };
    base.with_module(true)
}

#[derive(Default)]
struct Collector {
    out: BTreeSet<String>,
    /// Syntax oxc accepts but Babel (called without extra plugins) rejects: decorators,
    /// `accessor` fields and source/defer import phases. Also set when Babel would throw
    /// while lexing (a JSX attribute entity above U+10FFFF). The JS side falls back on these.
    babel_rejects: bool,
}

impl Collector {
    fn add(&mut self, s: &str) {
        if is_icon_shaped(s) {
            self.out.insert(s.to_string());
        }
    }
}

impl<'a> Visit<'a> for Collector {
    fn visit_string_literal(&mut self, it: &StringLiteral<'a>) {
        self.add(&it.value);
    }

    // JS: a template without expressions contributes its cooked text; otherwise only the
    // expressions are walked.
    fn visit_template_literal(&mut self, it: &TemplateLiteral<'a>) {
        if it.expressions.is_empty() {
            if let Some(cooked) = it.quasis.first().and_then(|q| q.value.cooked.as_ref()) {
                self.add(cooked);
            }
        } else {
            for e in &it.expressions {
                self.visit_expression(e);
            }
        }
    }

    // Babel decodes XHTML entities in JSX attribute strings (`name="ho&#109;e"` → `home`); oxc
    // keeps the raw text. A numeric entity above U+10FFFF makes Babel throw (JS falls back).
    fn visit_jsx_attribute_value(&mut self, it: &JSXAttributeValue<'a>) {
        match it {
            JSXAttributeValue::StringLiteral(s) => match decode_jsx_attribute(&s.value) {
                Some(value) => self.add(&value),
                None => self.babel_rejects = true,
            },
            _ => walk::walk_jsx_attribute_value(self, it),
        }
    }

    // ---- syntax Babel rejects without a plugin ----
    fn visit_decorator(&mut self, _: &Decorator<'a>) {
        self.babel_rejects = true;
    }

    fn visit_accessor_property(&mut self, _: &AccessorProperty<'a>) {
        self.babel_rejects = true;
    }

    fn visit_import_expression(&mut self, it: &ImportExpression<'a>) {
        if it.phase.is_some() {
            self.babel_rejects = true;
        }
        walk::walk_import_expression(self, it);
    }

    // ---- JS TYPE_ONLY_NODES / TYPE_KEYS: never descend ----
    fn visit_ts_type(&mut self, _: &TSType<'a>) {}
    fn visit_ts_type_annotation(&mut self, _: &TSTypeAnnotation<'a>) {}
    fn visit_ts_type_alias_declaration(&mut self, _: &TSTypeAliasDeclaration<'a>) {}
    fn visit_ts_interface_declaration(&mut self, _: &TSInterfaceDeclaration<'a>) {}
    fn visit_ts_type_parameter_instantiation(&mut self, _: &TSTypeParameterInstantiation<'a>) {}
    fn visit_ts_type_parameter_declaration(&mut self, _: &TSTypeParameterDeclaration<'a>) {}
    fn visit_ts_class_implements(&mut self, _: &TSClassImplements<'a>) {}

    // JS: TSDeclareFunction (`declare function` and overload signatures) is type-only.
    fn visit_function(&mut self, it: &Function<'a>, flags: ScopeFlags) {
        if it.r#type == FunctionType::TSDeclareFunction {
            return;
        }
        walk::walk_function(self, it, flags);
    }

    // ---- JS MODULE_NODES, `source` of ExportNamedDeclaration, and `directives` ----
    fn visit_import_declaration(&mut self, it: &ImportDeclaration<'a>) {
        if it.phase.is_some() {
            self.babel_rejects = true;
        }
    }

    // Babel models `export * as x from 'm'` as an ExportNamedDeclaration (exported name and
    // attributes walked, source skipped); only a bare `export * from 'm'` is skipped whole.
    fn visit_export_all_declaration(&mut self, it: &ExportAllDeclaration<'a>) {
        if let Some(exported) = &it.exported {
            self.visit_module_export_name(exported);
            if let Some(with_clause) = &it.with_clause {
                self.visit_with_clause(with_clause);
            }
        }
    }

    // `export { a as 'b' } from 'm'`: specifiers and attributes are walked, the source is not.
    // (oxc 0.146 splits Babel's ExportNamedDeclaration into ExportDeclaration,
    // ExportNamedDeclaration and ExportFromDeclaration; only the last one carries a source.)
    fn visit_export_from_declaration(&mut self, it: &ExportFromDeclaration<'a>) {
        for s in &it.specifiers {
            self.visit_export_specifier(s);
        }
        if let Some(with_clause) = &it.with_clause {
            self.visit_with_clause(with_clause);
        }
    }

    fn visit_directive(&mut self, _: &Directive<'a>) {}

    // Babel's tsParseModuleBlock parses no directives: a leading string in a
    // `namespace`/`module` block is an ordinary expression statement there, so keep it.
    fn visit_ts_module_block(&mut self, it: &TSModuleBlock<'a>) {
        for d in &it.directives {
            self.visit_string_literal(&d.expression);
        }
        self.visit_statements(&it.body);
    }
}

/// Test-only: a file containing this marker makes `extract_literals` panic, to exercise the per-file panic guard.
#[cfg(test)]
pub(crate) const TEST_PANIC_MARKER: &str = "__rnms_test_panic__";

pub fn extract_literals(code: &str, filename: &str) -> Extracted {
    #[cfg(test)]
    if code.contains(TEST_PANIC_MARKER) {
        panic!("injected extract panic");
    }
    if declaration_file(filename) {
        return Extracted { literals: BTreeSet::new(), parsed: true };
    }
    let fallback = || Extracted { literals: regex_literals(code), parsed: false };
    if max_nesting(code) > MAX_NESTING {
        return fallback();
    }

    with_stack_for(code, || parse_and_collect(code, filename)).flatten().unwrap_or_else(fallback)
}

/// `None` when Babel would have failed to parse (→ regex fallback).
fn parse_and_collect(code: &str, filename: &str) -> Option<Extracted> {
    let allocator = Allocator::default();
    let ret = Parser::new(&allocator, code, source_type(filename)).parse();
    if ret.panicked || ret.diagnostics.has_errors() {
        return None;
    }
    // Babel reports early errors (redeclarations, strict-mode violations, `break` outside a
    // loop, duplicate `__proto__`, exporting an undeclared name, …) while parsing; oxc's
    // parser leaves them to the semantic pass, so run its syntax checks too.
    let semantic = SemanticBuilder::new().with_check_syntax_error(true).build(&ret.program);
    if semantic.diagnostics.has_errors() {
        return None;
    }
    let mut c = Collector::default();
    c.visit_program(&ret.program);
    if c.babel_rejects {
        return None;
    }
    Some(Extracted { literals: c.out, parsed: true })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lits(code: &str, file: &str) -> Vec<String> {
        extract_literals(code, file).literals.into_iter().collect()
    }

    #[test]
    fn jsx_and_ternaries() {
        assert_eq!(
            lits("<MaterialIcon name='info' /> ; <X name={'close'} /> ; <Y name={on ? 'check' : 'remove'} />", "a.tsx"),
            vec!["check", "close", "info", "remove"]
        );
    }

    #[test]
    fn object_configs() {
        assert_eq!(lits("export const MENU = [{ iconName: 'home' }, { iconName: \"settings\" }];", "menu.ts"), vec!["home", "settings"]);
    }

    #[test]
    fn skips_type_positions() {
        let code = "type Name = 'home' | 'search';\ninterface P { icon: 'close'; }\nfunction f(n: 'check'): 'done' { return x; }\nconst g = (n: Array<'apps'>) => n;\nlet h: { a: 'menu' };\nclass C implements I<'star'> {}";
        assert!(lits(code, "types.ts").is_empty());
    }

    #[test]
    fn keeps_value_side_of_ts_constructs() {
        let code = "const a = 'info' as Name;\nconst b = { x: 'close' } satisfies Cfg;\nenum E { A = 'home' }\nconst m = { 'search': 1 };\nconst t = ['check', 'remove'] as const;";
        assert_eq!(lits(code, "v.ts"), vec!["check", "close", "home", "info", "remove", "search"]);
    }

    #[test]
    fn namespace_values_are_kept() {
        assert_eq!(lits("namespace N { export const a = 'home' }", "ns.ts"), vec!["home"]);
    }

    #[test]
    fn pinned_value_positions() {
        assert_eq!(lits("function f(n: Name = 'home') {}", "a.ts"), vec!["home"]);
        assert_eq!(lits("class C { x: Name = 'close' }", "a.ts"), vec!["close"]);
        assert_eq!(lits("const a: Name = 'info'", "a.ts"), vec!["info"]);
        assert_eq!(lits("useState<Name>('check')", "a.tsx"), vec!["check"]);
        assert_eq!(lits("<Foo<Name> name='star' />", "a.tsx"), vec!["star"]);
    }

    #[test]
    fn template_literals() {
        assert_eq!(lits("const a = `info`; const b = `${x}_filled`;", "tpl.ts"), vec!["info"]);
        assert_eq!(lits("const a = `${open ? 'expand_less' : 'expand_more'}`", "t.ts"), vec!["expand_less", "expand_more"]);
    }

    #[test]
    fn ignores_module_specifiers_directives_and_non_icon_strings() {
        let code = "'use strict'; import x from 'react'; export * from 'home'; const a = 'Home'; const b = 'arrow-back'; const c = 'two words';";
        assert!(lits(code, "i.js").is_empty());
    }

    #[test]
    fn declaration_files_contribute_nothing() {
        for f in ["x.d.ts", "x.d.mts", "x.d.cts"] {
            let r = extract_literals("export const b = 'info';", f);
            assert!(r.literals.is_empty() && r.parsed);
        }
    }

    #[test]
    fn syntax_error_falls_back_to_regex() {
        let r = extract_literals("const a = 'info'; <div name='close' ", "broken.tsx");
        assert!(!r.parsed);
        assert_eq!(r.literals.into_iter().collect::<Vec<_>>(), vec!["close", "info"]);
    }

    #[test]
    fn ts_generics_without_jsx() {
        assert_eq!(lits("const f = <T,>(x: T) => x; const a = f('home');", "g.ts"), vec!["home"]);
    }

    // ---- extra parity cases; expectations come from running the JS extractor ----

    #[test]
    fn enum_member_names_and_template_initializers() {
        assert_eq!(lits("enum E { 'home' = 1, info = 'close' }", "a.ts"), vec!["close", "home"]);
        assert_eq!(lits("enum E { A = `home`, B = 'info'.length }", "a.ts"), vec!["home", "info"]);
    }

    #[test]
    fn string_export_names_are_values() {
        assert_eq!(lits("const a = 1; export { a as 'home' };", "a.ts"), vec!["home"]);
        assert_eq!(lits("export { a as 'home', 'info' as b } from 'x';", "a.ts"), vec!["home", "info"]);
        assert_eq!(lits("export * as 'home' from 'x';", "a.ts"), vec!["home"]);
        assert!(lits("export * as ns from 'x';", "a.ts").is_empty());
    }

    #[test]
    fn import_attributes_follow_babel_node_shapes() {
        // Babel: `export … from` and `export * as ns from` are ExportNamedDeclaration (attributes walked);
        // `export * from` and `import` are skipped whole.
        assert_eq!(lits("export { a } from 'x' with { type: 'json' };", "a.ts"), vec!["json"]);
        assert_eq!(lits("export * as ns from 'x' with { type: 'json' };", "a.ts"), vec!["json"]);
        assert!(lits("export * from 'x' with { type: 'json' };", "a.ts").is_empty());
        assert!(lits("import x from 'y' with { type: 'json' };", "a.ts").is_empty());
    }

    #[test]
    fn ambient_declarations() {
        assert_eq!(lits("declare module 'home' { export const x = 'info'; }", "a.ts"), vec!["home", "info"]);
        assert_eq!(lits("declare module 'home';", "a.ts"), vec!["home"]);
        assert!(lits("declare global { const x: 'menu'; }", "a.ts").is_empty());
        assert_eq!(lits("declare const x: 'home'; declare const y = 'info';", "a.ts"), vec!["info"]);
        assert_eq!(
            lits("declare function f(x: 'home'): void; function g(a: 'b'): void; function g(a) { return 'info'; }", "a.ts"),
            vec!["info"]
        );
    }

    #[test]
    fn other_module_references_are_values() {
        assert_eq!(lits("import x = require('home'); export = 'info';", "a.ts"), vec!["home", "info"]);
        assert_eq!(lits("const m = import('home'); const r = require('info');", "a.ts"), vec!["home", "info"]);
        assert_eq!(lits("const a = 'info'; type T = import('home');", "a.ts"), vec!["info"]);
    }

    #[test]
    fn tagged_templates() {
        assert_eq!(lits("const t = tag`home`; const u = tag`${a}menu`;", "a.ts"), vec!["home"]);
    }

    #[test]
    fn class_members_and_type_arguments() {
        assert_eq!(lits("abstract class A { abstract 'home'(x: 'b'): void; 'info' = 1; [k: string]: 'z'; }", "a.ts"), vec!["home", "info"]);
        assert!(lits("class C extends B<'home'> { m(this: 'x') { return f<'info'>; } }", "a.ts").is_empty());
        assert!(lits("const a = <'home'>x; const b = x!; const c = y as unknown as 'info';", "a.ts").is_empty());
        assert_eq!(lits("class C { constructor(private readonly x: 'a' = 'home') {} }", "a.ts"), vec!["home"]);
        assert!(lits("function f<T extends 'home' = 'info'>() {}", "a.ts").is_empty());
        assert_eq!(lits("const f = function <T,>(x: T = 'home' as T) {}", "a.tsx"), vec!["home"]);
    }

    #[test]
    fn function_directives_are_skipped() {
        assert_eq!(lits("function f() { 'use strict'; 'home'; return 'info'; }", "a.ts"), vec!["info"]);
    }

    #[test]
    fn jsx_in_plain_js_extensions() {
        for f in ["a.js", "a.mjs", "a.cjs", "a.jsx"] {
            let r = extract_literals("const a = 'info'; <div name='close' />", f);
            assert!(r.parsed, "{f}");
            assert_eq!(r.literals.into_iter().collect::<Vec<_>>(), vec!["close", "info"], "{f}");
        }
        assert_eq!(lits("<a b=\"home\">info</a>", "a.jsx"), vec!["home"]);
    }

    #[test]
    fn jsx_attribute_entities_are_decoded_like_babel() {
        // JS (Babel): {home, info} — oxc's raw attribute text is `ho&#109;e`
        for f in ["a.tsx", "a.jsx", "a.js"] {
            let r = extract_literals("const marker = \"info\"; const icon = <MaterialIcon name=\"ho&#109;e\" />;", f);
            assert!(r.parsed, "{f}");
            assert_eq!(r.literals.into_iter().collect::<Vec<_>>(), vec!["home", "info"], "{f}");
        }
        assert_eq!(lits("<I a='ho&#x6d;e' b=\"arrow&#95;back\" x:c=\"&#109;enu\" />", "a.tsx"), vec!["arrow_back", "home", "menu"]);
        // named entities never decode to an icon-shaped character; invalid forms keep the `&`
        assert!(lits("<I a=\"home&amp;\" b=\"ho&foo;me\" c=\"ho&#109e\" d=\"&#X6d;\" />", "a.tsx").is_empty());
        // only attribute strings are decoded: `{"…"}` is a JS string, text children are not collected
        assert_eq!(lits("<I name={\"ho&#109;e\"}>ho&#109;e</I>; const a = 'info'", "a.tsx"), vec!["info"]);
    }

    #[test]
    fn jsx_attribute_entity_beyond_unicode_falls_back_like_babel() {
        // Babel's String.fromCodePoint throws a RangeError → JS: regex fallback, parsed=false
        for code in ["<I a=\"&#x110000;\" b=\"home\" />", "<I a=\"&#99999999;\" b=\"home\" />"] {
            let r = extract_literals(code, "a.tsx");
            assert!(!r.parsed, "{code}");
            assert_eq!(r.literals.into_iter().collect::<Vec<_>>(), vec!["home"], "{code}");
        }
    }

    #[test]
    fn decorators_fall_back_like_babel() {
        // Babel is called without the decorators plugin, so any decorator is a parse error there.
        let r = extract_literals("@dec('home') class C { @prop('info') x: 'menu' = 1 }", "a.ts");
        assert!(!r.parsed);
        assert_eq!(r.literals.into_iter().collect::<Vec<_>>(), vec!["home", "info", "menu"]);
    }

    #[test]
    fn other_syntax_babel_rejects_falls_back() {
        for (code, file) in [
            ("class A { accessor x = 'home' }", "a.js"),
            ("import source x from 'home'; const s = 'info';", "a.ts"),
            ("const y = import.defer('home'); const s = 'info';", "a.ts"),
        ] {
            let r = extract_literals(code, file);
            assert!(!r.parsed, "{code}");
            assert_eq!(r.literals, regex_literals(code), "{code}");
        }
    }

    #[test]
    fn early_errors_fall_back_like_babel() {
        // Babel reports these while parsing (JS: parsed=false); oxc needs its semantic checks.
        for (code, file) in [
            ("let a = 1; let a = 2; const b = 'info';", "a.ts"),
            ("export const a = 1; export const a = 2; const s = 'info';", "a.ts"),
            ("const s = 'info'; break;", "a.js"),
            ("const s = 'info'; label: label: x;", "a.js"),
            ("const s = 'info'; super.x;", "a.js"),
            ("const s = 'info'; x = { __proto__: 1, __proto__: 2 };", "a.js"),
            ("const s = 'info'; class A { constructor(){} constructor(){} }", "a.js"),
            ("const s = 'info'; export { undefinedThing };", "a.js"),
        ] {
            let r = extract_literals(code, file);
            assert!(!r.parsed, "{code}");
            assert_eq!(r.literals.into_iter().collect::<Vec<_>>(), vec!["info"], "{code}");
        }
        let r = extract_literals("const s = 'info'; import a from 'x'; import a from 'y';", "a.js");
        assert!(!r.parsed);
        assert_eq!(r.literals.into_iter().collect::<Vec<_>>(), vec!["info", "x", "y"]);
    }

    #[test]
    fn module_grammar_even_without_import_export() {
        // Babel 'unambiguous' + errorRecovery keeps module (strict) errors for script-looking files.
        for code in [
            "with (a) { 'home' }",
            "const o = 0777; const s = 'home';",
            "var await = 1; const s = 'home';",
            "const s = 'home'; delete x;",
            "function f(a, a) { return 'home' }",
        ] {
            let r = extract_literals(code, "a.js");
            assert!(!r.parsed, "{code}");
            assert_eq!(r.literals.into_iter().collect::<Vec<_>>(), vec!["home"], "{code}");
        }
        // ...while top-level await is accepted (JS: parsed, ["info"]).
        let r = extract_literals("await x; const s = 'info';", "a.js");
        assert!(r.parsed);
        assert_eq!(r.literals.into_iter().collect::<Vec<_>>(), vec!["info"]);
    }

    #[test]
    fn leading_strings_in_namespace_blocks_are_values() {
        // Babel's tsParseModuleBlock parses no directives, so these are plain expression statements.
        assert_eq!(lits("namespace N { 'home'; export const a = 1 }", "a.ts"), vec!["home"]);
        assert_eq!(lits("module N { 'home' }", "a.ts"), vec!["home"]);
        assert_eq!(lits("declare module 'm' { 'home'; }", "a.ts"), vec!["home", "m"]);
    }

    fn nested(kind: &str, depth: usize) -> String {
        let (open, close) = match kind {
            "[" => ("[", "]"),
            "(" => ("(", ")"),
            "{" => ("{a:", "}"),
            "${" => ("`${", "}`"),
            "fn" => ("function f(){", "}"),
            _ => unreachable!(),
        };
        format!("const s='home'; x = {}1{};", open.repeat(depth), close.repeat(depth))
    }

    fn assert_deep_falls_back() {
        for kind in ["[", "(", "{", "${", "fn"] {
            for depth in [MAX_NESTING + 1, 5_000, 200_000] {
                let r = extract_literals(&nested(kind, depth), "a.ts");
                assert!(!r.parsed, "{kind} {depth}");
                assert_eq!(r.literals.into_iter().collect::<Vec<_>>(), vec!["home"], "{kind} {depth}");
            }
        }
    }

    #[test]
    fn deep_nesting_falls_back_without_overflowing_the_stack() {
        assert_deep_falls_back();
    }

    #[test]
    fn deep_nesting_falls_back_on_a_2mb_worker_stack() {
        std::thread::Builder::new()
            .stack_size(2 << 20)
            .spawn(assert_deep_falls_back)
            .unwrap()
            .join()
            .unwrap();
    }

    #[test]
    fn nesting_at_the_cap_still_parses_on_a_2mb_worker_stack() {
        std::thread::Builder::new()
            .stack_size(2 << 20)
            .spawn(|| {
                for kind in ["[", "(", "{", "${", "fn"] {
                    let r = extract_literals(&nested(kind, MAX_NESTING), "a.ts");
                    assert!(r.parsed, "{kind}");
                    assert_eq!(r.literals.into_iter().collect::<Vec<_>>(), vec!["home"], "{kind}");
                }
            })
            .unwrap()
            .join()
            .unwrap();
    }

    /// One input per nesting construct; `n` is the nesting depth.
    fn construct(kind: &str, n: usize) -> (String, &'static str) {
        let r = |s: &str| s.repeat(n);
        // closers hidden in a string: 200 openers, then a 200-closer string, repeated
        let reset = |open: &str, close: &str, sep: &str| {
            let chunks = n / 200 + 1;
            format!("{}B{}", (open.repeat(200) + "'" + &close.repeat(200) + "'" + sep).repeat(chunks), close.repeat(chunks * 200))
        };
        let body = match kind {
            "?" => format!("x = {}1", r("a ? 1 : ")),
            "=" => format!("x = {}1", r("a = ")),
            "=>" => format!("x = {}1", r("() => ")),
            "!" => format!("x = {}1", r("!")),
            "~" => format!("x = {}1", r("~")),
            "-" => format!("x = {}1", r("- ")),
            "+" => format!("x = 1{}", r(" + 1")),
            "**" => format!("x = 1{}", r(" ** 1")),
            "." => format!("x = a{}", r(".b")),
            "?." => format!("x = a{}", r("?.b")),
            "call" => format!("x = a{}", r("()")),
            "index" => format!("x = a{}", r("[0]")),
            "new" => format!("x = {}a", r("new ")),
            "typeof" => format!("x = {}a", r("typeof ")),
            "void" => format!("x = {}a", r("void ")),
            "await" => format!("x = {}a", r("await ")),
            "nonnull" => format!("x = a{}", r("!")),
            "as" => format!("x = a{}", r(" as T")),
            "elseif" => format!("if (a) 1; {}", r("else if (a) 1; ")),
            "if" => format!("{}1", r("if (a) ")),
            "label" => format!("{}1", (0..n).map(|i| format!("l{i}: ")).collect::<String>()),
            "do" => format!("{}x;{}", r("do "), r(" while (a);")),
            "gen" => format!("let x: {}B{}", r("A<"), r(">")),
            "genval" => format!("x = f<{}B{}>()", r("A<"), r(">")),
            "arrty" => format!("let x: T{}", r("[]")),
            "keyof" => format!("let x: {}A", r("keyof ")),
            "condty" => format!("type X = {}D", r("A extends B ? C : ")),
            "jsx" => format!("x = {}{}", r("<a>"), r("</a>")),
            "[" => format!("x = {}1{}", r("["), r("]")),
            "(" => format!("x = {}1{}", r("("), r(")")),
            "{" => format!("x = {}1{}", r("{a:"), r("}")),
            "tpl" => format!("x = {}1{}", r("`${"), r("}`")),
            "{str" => format!("x = {}1{}", r("{a:\"}\",b:"), r("}")),
            "[str" => format!("x = {}1{}", r("[']',"), r("]")),
            "(str" => format!("x = {}1{}", r("(')',"), r(")")),
            "[reset" => format!("x = {}", reset("[", "]", ",")),
            "(reset" => format!("x = {}", reset("(", ")", ",")),
            "tyobjstr" => format!("let x: {}B{}", r("{a:'}';b:"), r("}")),
            "tyreset" => format!("let x: {}", reset("(", ")", " | ")),
            "jsxstr" => format!("x = {}<a/>{}", r("<a>{'}' && "), r("}</a>")),
            "arrowstr" => format!("x = {}1{}", r("(a=')') => ("), r(")")),
            _ => unreachable!("{kind}"),
        };
        (format!("const s='home'; {body};"), if kind.starts_with("jsx") { "a.tsx" } else { "a.ts" })
    }

    /// (construct, depth at which oxc overflowed a 2MB thread without the stack guard,
    /// release, debug) — measured by binary search with `stacker` bypassed.
    const OVERFLOW_AT_2MB: &[(&str, usize, usize)] = &[
        ("?", 2_320, 1_709), ("=", 2_320, 1_709), ("=>", 1_831, 1_510), ("!", 16_601, 1_709),
        ("~", 16_601, 1_709), ("-", 16_601, 1_709), ("+", 26_366, 1_678), ("**", 7_813, 1_465),
        (".", 19_042, 1_587), ("?.", 19_042, 1_587), ("call", 26_366, 1_709), ("index", 19_042, 1_617),
        ("new", 4_700, 1_404), ("typeof", 16_601, 1_709), ("void", 16_601, 1_709), ("await", 14_648, 1_678),
        ("nonnull", 26_366, 1_678), ("as", 26_366, 1_678), ("elseif", 5_310, 2_076), ("if", 5_310, 2_076),
        ("label", 4_578, 2_076), ("do", 5_310, 2_076), ("gen", 1_282, 603), ("genval", 1_282, 603),
        ("arrty", 26_366, 1_739), ("keyof", 3_907, 1_739), ("condty", 5_493, 1_739), ("jsx", 4_578, 1_770),
        ("[", 1_053, 794), ("(", 1_053, 694), ("{", 931, 603), ("tpl", 946, 733),
        ("{str", 931, 603), ("[str", 1_053, 794), ("(str", 1_053, 694), ("[reset", 1_007, 603),
        ("(reset", 1_007, 603), ("tyobjstr", 1_297, 603), ("tyreset", 1_800, 809), ("jsxstr", 961, 496),
        ("arrowstr", 672, 458),
    ];

    #[test]
    fn construct_inputs_are_valid_at_small_depth() {
        for &(kind, _, _) in OVERFLOW_AT_2MB {
            let (code, file) = construct(kind, 50);
            let r = extract_literals(&code, file);
            assert!(r.parsed, "{kind}");
            assert_eq!(r.literals.into_iter().collect::<Vec<_>>(), vec!["home"], "{kind}");
        }
    }

    /// Runs every construct at 10x the depth that overflowed a 2MB thread in this build
    /// profile (`cargo test` → debug depths, `cargo test --release` → release depths).
    #[test]
    fn nesting_constructs_do_not_overflow_a_2mb_worker_stack() {
        std::thread::Builder::new()
            .stack_size(2 << 20)
            .spawn(|| {
                for &(kind, release, debug) in OVERFLOW_AT_2MB {
                    let depth = 10 * if cfg!(debug_assertions) { debug } else { release };
                    let (code, file) = construct(kind, depth);
                    let prescan_rejects = max_nesting(&code) > MAX_NESTING;
                    // the stack guard must be what makes this pass, not the size fallback
                    assert!(stack_needed(&code) <= STACK_MAX, "{kind}: test input exceeds STACK_MAX");
                    let r = extract_literals(&code, file);
                    assert_eq!(r.parsed, !prescan_rejects, "{kind} {depth}");
                    assert_eq!(r.literals.into_iter().collect::<Vec<_>>(), vec!["home"], "{kind} {depth}");
                }
            })
            .unwrap()
            .join()
            .unwrap();
    }

    #[test]
    fn sources_too_large_for_a_safe_stack_bound_fall_back() {
        // all punctuation: the cheapest way to exceed STACK_MAX
        let n = (STACK_MAX - STACK_BASE) / STACK_PER_PUNCT_BYTE / 2 + 1;
        let code = format!("const s='home'; x = a{};", "()".repeat(n));
        assert!(stack_needed(&code) > STACK_MAX);
        let r = extract_literals(&code, "a.ts");
        assert!(!r.parsed);
        assert_eq!(r.literals.into_iter().collect::<Vec<_>>(), vec!["home"]);
    }

    #[test]
    fn stack_estimate_weights_punctuation() {
        assert_eq!(stack_needed(""), STACK_BASE);
        assert_eq!(stack_needed("a!"), STACK_BASE + STACK_PER_OTHER_BYTE + STACK_PER_PUNCT_BYTE);
        assert_eq!(stack_needed("한"), STACK_BASE + 3 * STACK_PER_OTHER_BYTE);
    }

    #[test]
    fn nesting_depth_scan() {
        assert_eq!(max_nesting("a(b[c{d}]) ) ) ([{"), 3);
        assert_eq!(max_nesting(""), 0);
    }

    #[test]
    fn flow_annotations_in_js_fall_back_to_regex() {
        // Known, accepted difference: Babel parses Flow (JS result: ["info"], parsed); oxc cannot,
        // so Rust falls back to the regex and over-includes the annotation literal.
        let r = extract_literals("const a: 'home' = 'info';", "a.js");
        assert!(!r.parsed);
        assert_eq!(r.literals.into_iter().collect::<Vec<_>>(), vec!["home", "info"]);
    }

    #[test]
    fn regex_fallback_and_icon_shape() {
        assert_eq!(
            regex_literals("'a' \"b_1\" `c` 'D' 'e-f' `${g}`").into_iter().collect::<Vec<_>>(),
            vec!["a", "b_1", "c"]
        );
        assert!(is_icon_shaped("arrow_back_2"));
        assert!(!is_icon_shaped(""));
        assert!(!is_icon_shaped("Home"));
    }
}
