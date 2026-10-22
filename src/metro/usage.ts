/**
 * Usage-based collection: which icon names, variants and shapes the app actually renders.
 *
 * Per file (Babel AST, single JS implementation) it records
 *   - every `<MaterialIcon …>` / `React.createElement(MaterialIcon, {…})` whose binding comes from rn-material-symbols
 *     (named import, alias, namespace, local re-binding, re-export),
 *   - the `name`, `variant` and `filled` of each use as an abstract value (literals, conditionals, consts, object and
 *     array maps, imports, and component props),
 *   - wrapper components: a component whose MaterialIcon props come from its own props,
 *   - exported constant tables other files import.
 * analyzeUsage() then resolves imports across files, follows wrappers to their call sites (to a fixed point), and turns
 * anything it cannot resolve into a conservative inclusion (the icon-shaped literals of that file and the files it
 * imports) plus a diagnostic, so nothing is dropped silently.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse, type ParserPlugin } from '@babel/parser';

export const LIBRARY = 'rn-material-symbols';

// ---------------------------------------------------------------------------------------------------------------
// Abstract values

export type AV =
  | { k: 'str'; v: string[] }
  | { k: 'bool'; v: boolean[] }
  | { k: 'undef' }
  | { k: 'obj'; props: Record<string, AV>; rest?: AV }
  | { k: 'arr'; items: AV[] }
  | { k: 'union'; of: AV[] }
  /** a value imported from another module, then `path` member accesses ('*' = any key) */
  | { k: 'import'; source: string; imported: string; path: string[] }
  /** a prop of the enclosing component `fn` (prop null = the whole props object) */
  | { k: 'param'; fn: string; prop: string | null; path: string[]; dflt?: AV }
  | { k: 'unknown'; why: string };

const UNKNOWN = (why: string): AV => ({ k: 'unknown', why });
const UNDEF: AV = { k: 'undef' };

function union(values: AV[]): AV {
  const flat: AV[] = [];
  for (const v of values) {
    if (v.k === 'union') flat.push(...v.of);
    else flat.push(v);
  }
  return flat.length === 1 ? flat[0] : { k: 'union', of: flat };
}

function member(base: AV, key: string | null): AV {
  switch (base.k) {
    case 'obj': {
      if (key === null) return union([...Object.values(base.props), ...(base.rest ? [member(base.rest, null)] : [])].concat(Object.keys(base.props).length === 0 && !base.rest ? [UNDEF] : []));
      if (Object.prototype.hasOwnProperty.call(base.props, key)) return base.props[key];
      return base.rest ? member(base.rest, key) : UNDEF;
    }
    case 'arr': {
      if (key !== null && /^\d+$/.test(key)) return base.items[Number(key)] ?? UNDEF;
      if (key === 'length') return UNKNOWN('array length');
      return base.items.length === 0 ? UNDEF : union(base.items);
    }
    case 'union':
      return union(base.of.map((v) => member(v, key)));
    case 'import':
      return { ...base, path: [...base.path, key ?? '*'] };
    case 'param':
      if (base.prop === null && base.path.length === 0 && key !== null) return { ...base, prop: key };
      return { ...base, path: [...base.path, key ?? '*'] };
    case 'unknown':
      return base;
    default:
      return UNDEF;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Per-file summary

export interface ImportRecord {
  local: string;
  /** 'default', '*' or the exported name */
  imported: string;
  source: string;
}

export interface Site {
  line: number;
  /** what is rendered: the library MaterialIcon, or a wrapper identified by its defining file + export name */
  target: { kind: 'lib' } | { kind: 'wrapper'; ref: WrapperRef };
  /** undefined = attribute absent */
  name?: AV;
  variant?: AV;
  filled?: AV;
  /** a `{...x}` spread that may supply attributes not written explicitly */
  spread?: AV;
  /** wrapper call sites: every prop written, since a wrapper may map any prop (`iconName`) to MaterialIcon's */
  props?: Record<string, AV>;
  /** set when this use sits inside a wrapper and reads its props: it is evaluated from the wrapper's call sites */
  inWrapper?: string;
}

/** a wrapper as seen from a call site: by the import it came through, or by its local definition */
export type WrapperRef = { via: 'import'; source: string; imported: string } | { via: 'local'; fn: string };

export interface WrapperDef {
  fn: string;
  /** names this component is exported under ('default' included) */
  exports: string[];
  /** the MaterialIcon uses inside it (their AVs may contain `param` values of this fn) */
  sites: Site[];
}

export interface Diagnostic {
  file: string;
  line: number;
  message: string;
}

export interface FileSummary {
  imports: ImportRecord[];
  exports: Record<string, AV>;
  /** `export { x } from './y'` and `export * from './y'` */
  reexports: Array<{ exported: string; imported: string; source: string }>;
  sites: Site[];
  wrappers: WrapperDef[];
  diagnostics: Diagnostic[];
  /** icon-shaped string literals in value positions, used for conservative inclusion */
  literals: string[];
  parsed: boolean;
}

type Node = { type: string; [key: string]: unknown };
const isNode = (v: unknown): v is Node => !!v && typeof v === 'object' && typeof (v as Node).type === 'string';
const ICON_SHAPED = /^[a-z0-9_]+$/;

function pluginsFor(filename: string): ParserPlugin[] {
  if (/\.tsx$/.test(filename)) return ['typescript', 'jsx'];
  if (/\.[cm]?ts$/.test(filename)) return ['typescript'];
  return ['jsx', 'flow'];
}

const TYPE_ONLY = new Set([
  'TSTypeAliasDeclaration',
  'TSInterfaceDeclaration',
  'TSDeclareFunction',
  'TSTypeAnnotation',
  'TSTypeParameterInstantiation',
  'TSTypeParameterDeclaration',
  'TSExpressionWithTypeArguments',
  'TSInterfaceHeritage',
  'TSClassImplements',
  'TSLiteralType',
  'TSImportType',
  'TypeAnnotation',
  'TypeAlias',
  'OpaqueType',
  'InterfaceDeclaration',
  'DeclareModule',
]);
const SKIP_KEYS = new Set(['loc', 'start', 'end', 'extra', 'range', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'tokens', 'directives', 'typeAnnotation', 'typeParameters', 'typeArguments', 'returnType', 'superTypeParameters', 'implements']);

type Binding =
  | { kind: 'const'; init: Node | null; pattern: Node[]; scope: Scope }
  | { kind: 'mutable' }
  | { kind: 'import'; source: string; imported: string }
  | { kind: 'param'; fn: string; path: Node[]; dflt?: Node; scope: Scope; component: boolean }
  | { kind: 'function'; fn: string };

interface Scope {
  parent: Scope | null;
  vars: Map<string, Binding>;
}

/**
 * The path from a declarator's id down to one bound identifier: each step is a property key (or index) read on the
 * way, plus the default value of an AssignmentPattern on the way.
 */
type PatternStep = { key: string | null; dflt?: Node };

function bindPattern(pattern: Node, onBind: (name: string, steps: PatternStep[], dflt?: Node) => void, steps: PatternStep[] = []): void {
  switch (pattern.type) {
    case 'Identifier':
      onBind(pattern.name as string, steps);
      break;
    case 'AssignmentPattern':
      if (isNode(pattern.left) && pattern.left.type === 'Identifier') onBind(pattern.left.name as string, steps, pattern.right as Node);
      else bindPattern(pattern.left as Node, onBind, steps);
      break;
    case 'ObjectPattern':
      for (const prop of pattern.properties as Node[]) {
        if (prop.type === 'RestElement') {
          bindPattern(prop.argument as Node, onBind, [...steps, { key: '...' }]);
          continue;
        }
        const key = prop.computed ? null : keyName(prop.key as Node);
        bindPattern(prop.value as Node, onBind, [...steps, { key }]);
      }
      break;
    case 'ArrayPattern':
      (pattern.elements as Array<Node | null>).forEach((el, i) => {
        if (!el) return;
        if (el.type === 'RestElement') bindPattern(el.argument as Node, onBind, [...steps, { key: null }]);
        else bindPattern(el, onBind, [...steps, { key: String(i) }]);
      });
      break;
    default:
      break;
  }
}

function keyName(key: Node): string | null {
  if (key.type === 'Identifier') return key.name as string;
  if (key.type === 'StringLiteral') return key.value as string;
  if (key.type === 'NumericLiteral') return String(key.value);
  return null;
}

interface SummarizeOptions {
  /** wrapper export names to look for at call sites (from the previous round) */
  wrapperNames?: ReadonlySet<string>;
}

/** Parses one file and records everything analyzeUsage needs. Never throws. */
export function summarizeFile(code: string, file: string, options: SummarizeOptions = {}): FileSummary {
  const summary: FileSummary = { imports: [], exports: {}, reexports: [], sites: [], wrappers: [], diagnostics: [], literals: [], parsed: true };
  let program: Node;
  try {
    const ast = parse(code, { sourceType: 'unambiguous', errorRecovery: true, plugins: pluginsFor(file) });
    if (ast.errors && ast.errors.length > 0) throw new Error(String(ast.errors[0]));
    program = ast.program as unknown as Node;
  } catch {
    summary.parsed = false;
    for (const m of code.matchAll(/(['"`])([a-z0-9_]+)\1/g)) summary.literals.push(m[2]);
    if (code.includes(LIBRARY)) {
      summary.diagnostics.push({ file, line: 1, message: 'could not parse this file; its icon-shaped strings and imports are included' });
      summary.sites.push({ line: 1, target: { kind: 'lib' }, name: UNKNOWN('unparsed file') });
    }
    summary.literals = [...new Set(summary.literals)].sort();
    return summary;
  }
  const wrapperNames = options.wrapperNames ?? new Set<string>();
  const literals = new Set<string>();
  const lineOf = (n: Node) => ((n.loc as { start?: { line?: number } } | undefined)?.start?.line ?? 0);

  // ---------- bindings
  const root: Scope = { parent: null, vars: new Map() };
  let fnCounter = 0;
  const fnIds = new WeakMap<Node, string>();
  const fnId = (fn: Node) => {
    let id = fnIds.get(fn);
    if (!id) {
      fnCounter += 1;
      id = `${file}#${fnCounter}@${lineOf(fn)}`;
      fnIds.set(fn, id);
    }
    return id;
  };
  /** component functions: top-level function declarations / const arrows (optionally inside memo/forwardRef) */
  const componentOf = new Map<string, { local: string | null }>();

  const declare = (scope: Scope, stmt: Node) => {
    switch (stmt.type) {
      case 'ImportDeclaration': {
        if (stmt.importKind === 'type' || stmt.importKind === 'typeof') return;
        const source = (stmt.source as Node).value as string;
        for (const spec of stmt.specifiers as Node[]) {
          if (spec.importKind === 'type') continue;
          const local = (spec.local as Node).name as string;
          const imported =
            spec.type === 'ImportDefaultSpecifier' ? 'default' : spec.type === 'ImportNamespaceSpecifier' ? '*' : (keyName(spec.imported as Node) ?? 'default');
          scope.vars.set(local, { kind: 'import', source, imported });
          summary.imports.push({ local, imported, source });
        }
        return;
      }
      case 'VariableDeclaration': {
        const kind = stmt.kind as string;
        for (const decl of stmt.declarations as Node[]) {
          const id = decl.id as Node;
          const init = (decl.init as Node | null) ?? null;
          if (init && isFunction(init) && id.type === 'Identifier') {
            componentOf.set(fnId(init), { local: id.name as string });
            scope.vars.set(id.name as string, { kind: 'function', fn: fnId(init) });
            continue;
          }
          const wrapped = init ? unwrapHoc(init) : null;
          if (wrapped && id.type === 'Identifier') {
            componentOf.set(fnId(wrapped), { local: id.name as string });
            scope.vars.set(id.name as string, { kind: 'function', fn: fnId(wrapped) });
            continue;
          }
          bindPattern(id, (name, steps, dflt) => {
            if (kind !== 'const') scope.vars.set(name, { kind: 'mutable' });
            else scope.vars.set(name, { kind: 'const', init, pattern: steps.map((s) => ({ type: 'Step', key: s.key, dflt: s.dflt }) as unknown as Node).concat(dflt ? [{ type: 'Default', node: dflt } as unknown as Node] : []), scope });
          });
        }
        return;
      }
      case 'FunctionDeclaration':
        if (isNode(stmt.id)) {
          componentOf.set(fnId(stmt), { local: (stmt.id as Node).name as string });
          scope.vars.set((stmt.id as Node).name as string, { kind: 'function', fn: fnId(stmt) });
        }
        return;
      case 'ClassDeclaration':
        if (isNode(stmt.id)) scope.vars.set((stmt.id as Node).name as string, { kind: 'mutable' });
        return;
      case 'ExportNamedDeclaration':
      case 'ExportDefaultDeclaration':
        if (isNode(stmt.declaration)) declare(scope, stmt.declaration as Node);
        return;
      default:
        return;
    }
  };

  const lookup = (scope: Scope | null, name: string): Binding | undefined => {
    for (let s = scope; s; s = s.parent) {
      const b = s.vars.get(name);
      if (b) return b;
    }
    return undefined;
  };

  // ---------- evaluation
  const evaluating = new Set<Node>();
  const evaluate = (node: Node | null | undefined, scope: Scope, depth = 0): AV => {
    if (!node) return UNDEF;
    if (depth > 40) return UNKNOWN('expression too deep');
    switch (node.type) {
      case 'StringLiteral':
        return { k: 'str', v: [node.value as string] };
      case 'BooleanLiteral':
        return { k: 'bool', v: [node.value as boolean] };
      case 'NullLiteral':
        return UNDEF;
      case 'NumericLiteral':
        return { k: 'str', v: [String(node.value)] };
      case 'TemplateLiteral': {
        const quasis = (node.quasis as Node[]).map((q) => ((q.value as { cooked: string | null }).cooked ?? ''));
        let acc: string[] = [quasis[0]];
        const exprs = node.expressions as Node[];
        for (let i = 0; i < exprs.length; i += 1) {
          const parts = strings(evaluate(exprs[i], scope, depth + 1));
          if (!parts) return UNKNOWN('template with a value that is not a known string');
          const next: string[] = [];
          for (const a of acc) for (const p of parts) next.push(`${a}${p}${quasis[i + 1]}`);
          if (next.length > 256) return UNKNOWN('template with too many combinations');
          acc = next;
        }
        return { k: 'str', v: acc };
      }
      case 'Identifier': {
        const name = node.name as string;
        if (name === 'undefined') return UNDEF;
        const b = lookup(scope, name);
        if (!b) return UNKNOWN(`'${name}' is not declared in this file`);
        return fromBinding(b, name, depth);
      }
      case 'ConditionalExpression':
        return union([evaluate(node.consequent as Node, scope, depth + 1), evaluate(node.alternate as Node, scope, depth + 1)]);
      case 'LogicalExpression': {
        const left = evaluate(node.left as Node, scope, depth + 1);
        const right = evaluate(node.right as Node, scope, depth + 1);
        return union([left, right]);
      }
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSNonNullExpression':
      case 'TSTypeAssertion':
      case 'TypeCastExpression':
      case 'ParenthesizedExpression':
        return evaluate(node.expression as Node, scope, depth + 1);
      case 'SequenceExpression': {
        const list = node.expressions as Node[];
        return evaluate(list[list.length - 1], scope, depth + 1);
      }
      case 'MemberExpression':
      case 'OptionalMemberExpression': {
        const base = evaluate(node.object as Node, scope, depth + 1);
        let key: string | null = null;
        const prop = node.property as Node;
        if (!node.computed) key = keyName(prop);
        else {
          const k = evaluate(prop, scope, depth + 1);
          const ks = strings(k);
          if (ks && ks.length === 1) key = ks[0];
          else if (ks) return union(ks.map((one) => member(base, one)));
        }
        return member(base, key);
      }
      case 'ObjectExpression': {
        const props: Record<string, AV> = {};
        const rests: AV[] = [];
        for (const p of node.properties as Node[]) {
          if (p.type === 'SpreadElement') {
            rests.push(evaluate(p.argument as Node, scope, depth + 1));
            continue;
          }
          if (p.type !== 'ObjectProperty') continue;
          const key = p.computed ? null : keyName(p.key as Node);
          const value = evaluate(p.value as Node, scope, depth + 1);
          if (key === null) rests.push({ k: 'obj', props: {}, rest: value });
          else props[key] = value;
        }
        return { k: 'obj', props, ...(rests.length > 0 ? { rest: union(rests) } : {}) };
      }
      case 'ArrayExpression':
        return { k: 'arr', items: (node.elements as Array<Node | null>).map((el) => (el ? (el.type === 'SpreadElement' ? member(evaluate(el.argument as Node, scope, depth + 1), null) : evaluate(el, scope, depth + 1)) : UNDEF)) };
      case 'CallExpression':
      case 'OptionalCallExpression':
        return UNKNOWN(`the result of a function call (line ${lineOf(node)})`);
      default:
        return UNKNOWN(`a ${node.type} (line ${lineOf(node)})`);
    }
  };

  const fromBinding = (b: Binding, name: string, depth: number): AV => {
    switch (b.kind) {
      case 'import':
        return { k: 'import', source: b.source, imported: b.imported, path: [] };
      case 'mutable':
        return UNKNOWN(`'${name}' is reassignable (let/var/class)`);
      case 'function':
        return UNKNOWN(`'${name}' is a function`);
      case 'param': {
        if (!b.component) return UNKNOWN(`'${name}' is a parameter of a function that is not a component (a callback?)`);
        let av: AV = { k: 'param', fn: b.fn, prop: null, path: [] };
        for (const step of b.path as unknown as PatternStep[]) {
          if (step.key === '...') continue; // rest of props: same props object minus the named keys
          av = member(av, step.key);
        }
        if (b.dflt && av.k === 'param') av = { ...av, dflt: evaluate(b.dflt, b.scope, depth + 1) };
        return av;
      }
      case 'const': {
        if (!b.init) return UNDEF;
        if (evaluating.has(b.init)) return UNKNOWN(`'${name}' refers to itself`);
        evaluating.add(b.init);
        try {
          let av = evaluate(b.init, b.scope, depth + 1);
          let dflt: AV | undefined;
          for (const step of b.pattern) {
            if (step.type === 'Default') {
              dflt = evaluate((step as unknown as { node: Node }).node, b.scope, depth + 1);
              continue;
            }
            const s = step as unknown as PatternStep;
            if (s.key === '...') continue;
            av = member(av, s.key);
            if (s.dflt) av = union([av, evaluate(s.dflt, b.scope, depth + 1)]);
          }
          return dflt ? union([av, dflt]) : av;
        } finally {
          evaluating.delete(b.init);
        }
      }
      default:
        return UNKNOWN(`'${name}'`);
    }
  };

  // ---------- which identifiers render MaterialIcon (or a known wrapper)
  type Tag = { kind: 'lib' } | { kind: 'wrapper'; ref: WrapperRef } | null;
  const tagOf = (nameNode: Node, scope: Scope): Tag => {
    if (nameNode.type === 'JSXIdentifier' || nameNode.type === 'Identifier') {
      const name = nameNode.name as string;
      const b = lookup(scope, name);
      if (!b) return null;
      if (b.kind === 'import') {
        if (b.source === LIBRARY && b.imported === 'MaterialIcon') return { kind: 'lib' };
        if (b.source !== LIBRARY && (wrapperNames.has(b.imported) || (b.imported === 'default' && wrapperNames.has(`default:${b.source}`)))) {
          return { kind: 'wrapper', ref: { via: 'import', source: b.source, imported: b.imported } };
        }
        return null;
      }
      if (b.kind === 'const' && b.init && (b.init.type === 'Identifier' || b.init.type === 'MemberExpression' || b.init.type === 'JSXMemberExpression')) {
        return tagOf(b.init, b.scope);
      }
      if (b.kind === 'function') return localWrappers.has(b.fn) ? { kind: 'wrapper', ref: { via: 'local', fn: b.fn } } : null;
      return null;
    }
    if (nameNode.type === 'JSXMemberExpression' || nameNode.type === 'MemberExpression') {
      const obj = nameNode.object as Node;
      const prop = nameNode.property as Node;
      if (obj.type === 'JSXIdentifier' || obj.type === 'Identifier') {
        const b = lookup(scope, obj.name as string);
        const propName = prop.name as string;
        if (b && b.kind === 'import' && b.imported === '*') {
          if (b.source === LIBRARY && propName === 'MaterialIcon') return { kind: 'lib' };
          if (b.source !== LIBRARY && wrapperNames.has(propName)) return { kind: 'wrapper', ref: { via: 'import', source: b.source, imported: propName } };
        }
      }
    }
    return null;
  };

  /** local functions found to wrap MaterialIcon (filled in by the first pass, used by the second) */
  const localWrappers = new Set<string>();

  const readAttrs = (attrs: Node[], scope: Scope, line: number, target: Site['target']): Site => {
    const site: Site = { line, target };
    for (const attr of attrs) {
      if (attr.type === 'JSXSpreadAttribute') {
        site.spread = site.spread ? union([site.spread, evaluate(attr.argument as Node, scope)]) : evaluate(attr.argument as Node, scope);
        continue;
      }
      if (attr.type !== 'JSXAttribute') continue;
      const key = (attr.name as Node).name as string;
      const value = attr.value as Node | null;
      const isIconKey = key === 'name' || key === 'variant' || key === 'filled';
      if (!isIconKey && target.kind !== 'wrapper') continue;
      const av: AV = value === null ? { k: 'bool', v: [true] } : value.type === 'JSXExpressionContainer' ? evaluate(value.expression as Node, scope) : evaluate(value, scope);
      if (isIconKey) site[key as 'name' | 'variant' | 'filled'] = av;
      if (target.kind === 'wrapper') site.props = { ...(site.props ?? {}), [key]: av };
    }
    return site;
  };

  const readObjectProps = (obj: Node | undefined, scope: Scope, line: number, target: Site['target']): Site => {
    const site: Site = { line, target };
    if (!obj) return site;
    if (obj.type !== 'ObjectExpression') {
      site.spread = evaluate(obj, scope);
      return site;
    }
    for (const p of obj.properties as Node[]) {
      if (p.type === 'SpreadElement') {
        site.spread = site.spread ? union([site.spread, evaluate(p.argument as Node, scope)]) : evaluate(p.argument as Node, scope);
        continue;
      }
      if (p.type !== 'ObjectProperty' || p.computed) continue;
      const key = keyName(p.key as Node);
      if (key === null) continue;
      const av = evaluate(p.value as Node, scope);
      if (key === 'name' || key === 'variant' || key === 'filled') site[key] = av;
      if (target.kind === 'wrapper') site.props = { ...(site.props ?? {}), [key]: av };
    }
    return site;
  };

  // ---------- walk
  const enclosingComponent: string[] = [];
  const sitesByFn = new Map<string, Site[]>();

  const walk = (node: unknown, scope: Scope, parent: Node | null, parentKey: string | null): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child, scope, parent, parentKey);
      return;
    }
    if (!isNode(node)) return;
    if (TYPE_ONLY.has(node.type)) return;
    if (node.type === 'ImportDeclaration') return;
    if (node.type === 'ExportAllDeclaration' || (node.type === 'ExportNamedDeclaration' && node.source)) return;

    if (node.type === 'StringLiteral') {
      if (ICON_SHAPED.test(node.value as string)) literals.add(node.value as string);
      return;
    }
    if (node.type === 'TemplateLiteral' && (node.expressions as Node[]).length === 0) {
      const cooked = ((node.quasis as Node[])[0]?.value as { cooked: string | null }).cooked;
      if (cooked && ICON_SHAPED.test(cooked)) literals.add(cooked);
      return;
    }

    if (node.type === 'Program' || node.type === 'BlockStatement' || node.type === 'StaticBlock' || node.type === 'TSModuleBlock') {
      const inner: Scope = node.type === 'Program' ? scope : { parent: scope, vars: new Map() };
      for (const stmt of node.body as Node[]) declare(inner, stmt);
      for (const stmt of node.body as Node[]) walk(stmt, inner, node, 'body');
      return;
    }

    if (isFunction(node)) {
      const id = fnId(node);
      const inner: Scope = { parent: scope, vars: new Map() };
      const params = node.params as Node[];
      const isComponent = componentOf.has(id) && params.length <= 2;
      params.forEach((param, index) => {
        bindPattern(param, (name, steps, dflt) => {
          inner.vars.set(name, { kind: 'param', fn: id, path: steps as unknown as Node[], ...(dflt ? { dflt } : {}), scope: inner, component: isComponent && index === 0 });
        });
      });
      if (isNode(node.id) && node.type === 'FunctionExpression') inner.vars.set((node.id as Node).name as string, { kind: 'function', fn: id });
      enclosingComponent.push(id);
      const body = node.body as Node;
      if (body.type === 'BlockStatement') walk(body, inner, node, 'body');
      else walk(body, inner, node, 'body');
      walk(params, inner, node, 'params');
      enclosingComponent.pop();
      return;
    }

    if (node.type === 'CatchClause' || node.type === 'ForStatement' || node.type === 'ForInStatement' || node.type === 'ForOfStatement') {
      const inner: Scope = { parent: scope, vars: new Map() };
      if (node.type === 'CatchClause' && isNode(node.param)) bindPattern(node.param as Node, (name) => inner.vars.set(name, { kind: 'mutable' }));
      const left = (node.left ?? node.init) as Node | undefined;
      if (isNode(left) && left.type === 'VariableDeclaration') {
        for (const d of left.declarations as Node[]) bindPattern(d.id as Node, (name) => inner.vars.set(name, { kind: 'mutable' }));
      }
      for (const key of Object.keys(node)) if (!SKIP_KEYS.has(key)) walk(node[key], inner, node, key);
      return;
    }

    if (node.type === 'JSXElement') {
      const opening = node.openingElement as Node;
      const tag = tagOf(opening.name as Node, scope);
      if (tag) record(readAttrs(opening.attributes as Node[], scope, lineOf(node), tag));
    }
    if (node.type === 'CallExpression') {
      const callee = node.callee as Node;
      const isCreate =
        (callee.type === 'MemberExpression' && keyName(callee.property as Node) === 'createElement') ||
        (callee.type === 'Identifier' && ['createElement', 'jsx', 'jsxs', '_jsx', '_jsxs'].includes(callee.name as string));
      const args = node.arguments as Node[];
      if (isCreate && args[0]) {
        const tag = tagOf(args[0], scope);
        if (tag) record(readObjectProps(args[1], scope, lineOf(node), tag));
      }
    }
    // An icon component used as a value (passed as a prop, stored in an object, called) escapes analysis: its props
    // cannot be traced, so the file falls back to conservative inclusion with a diagnostic.
    if (node.type === 'Identifier' && parentKey !== null && parent && !isDeclarationId(parent, parentKey) && !isCreateElementTag(parent, parentKey, node) && !isAliasInit(parent, parentKey)) {
      const tag = tagOf(node, scope);
      if (tag) {
        const what = tag.kind === 'lib' ? 'MaterialIcon' : `the icon wrapper '${node.name as string}'`;
        summary.diagnostics.push({ file, line: lineOf(node), message: `${what} is used as a value here, so its props cannot be traced` });
        record({ line: lineOf(node), target: { kind: 'lib' }, name: UNKNOWN(`${what} used as a value`) });
      }
    }

    for (const key of Object.keys(node)) {
      if (SKIP_KEYS.has(key)) continue;
      walk(node[key], scope, node, key);
    }
  };

  const record = (site: Site) => {
    const fn = enclosingComponent[enclosingComponent.length - 1];
    if (fn) {
      const list = sitesByFn.get(fn) ?? [];
      list.push(site);
      sitesByFn.set(fn, list);
    }
    summary.sites.push(site);
  };

  // pass 1: find local wrappers (components whose MaterialIcon props read their own props); pass 2 records sites with
  // local wrapper call sites recognized
  walk(program, root, null, null);
  // a use reads the component's props through name/variant/filled, a `{...props}` spread, or (for a wrapper of a
  // wrapper) any prop it passes on
  const isWrapperSite = (s: Site, fn: string) =>
    [s.name, s.variant, s.filled, ...Object.values(s.props ?? {})].some((av) => av !== undefined && mentionsParam(av, fn)) ||
    (s.spread !== undefined && mentionsParam(s.spread, fn, true));
  for (const [fn, sites] of sitesByFn) {
    if (componentOf.has(fn) && sites.some((s) => s.target.kind === 'lib' || s.target.kind === 'wrapper') && sites.some((s) => isWrapperSite(s, fn))) localWrappers.add(fn);
  }
  if (localWrappers.size > 0) {
    summary.sites = [];
    summary.diagnostics = [];
    sitesByFn.clear();
    literals.clear();
    root.vars.clear();
    walk(program, root, null, null);
  }

  // ---------- exports
  const exportedFns = new Map<string, string[]>();
  const addExport = (exported: string, av: AV, fn?: string) => {
    summary.exports[exported] = av;
    if (fn) exportedFns.set(fn, [...(exportedFns.get(fn) ?? []), exported]);
  };
  for (const stmt of program.body as Node[]) {
    if (stmt.type === 'ExportNamedDeclaration') {
      const decl = stmt.declaration as Node | null;
      if (decl) {
        if (decl.type === 'VariableDeclaration') {
          for (const d of decl.declarations as Node[]) {
            bindPattern(d.id as Node, (name) => {
              const b = root.vars.get(name);
              addExport(name, b ? fromBinding(b, name, 0) : UNKNOWN(name), b && b.kind === 'function' ? b.fn : undefined);
            });
          }
        } else if (decl.type === 'FunctionDeclaration' && isNode(decl.id)) {
          addExport((decl.id as Node).name as string, UNKNOWN('function'), fnId(decl));
        }
        continue;
      }
      const source = stmt.source ? ((stmt.source as Node).value as string) : null;
      for (const spec of stmt.specifiers as Node[]) {
        const exported = keyName(spec.exported as Node) ?? 'default';
        if (spec.type === 'ExportNamespaceSpecifier') {
          if (source) summary.reexports.push({ exported, imported: '*', source });
          continue;
        }
        const local = keyName(spec.local as Node) ?? 'default';
        if (source) {
          summary.reexports.push({ exported, imported: local, source });
          continue;
        }
        const b = root.vars.get(local);
        addExport(exported, b ? fromBinding(b, local, 0) : UNKNOWN(local), b && b.kind === 'function' ? b.fn : undefined);
        if (b && b.kind === 'import') summary.reexports.push({ exported, imported: b.imported, source: b.source });
      }
    } else if (stmt.type === 'ExportAllDeclaration') {
      summary.reexports.push({ exported: '*', imported: '*', source: (stmt.source as Node).value as string });
    } else if (stmt.type === 'ExportDefaultDeclaration') {
      const decl = stmt.declaration as Node;
      if (isFunction(decl)) addExport('default', UNKNOWN('function'), fnId(decl));
      else if (decl.type === 'Identifier') {
        const b = root.vars.get(decl.name as string);
        addExport('default', b ? fromBinding(b, decl.name as string, 0) : UNKNOWN('default'), b && b.kind === 'function' ? b.fn : undefined);
        if (b && b.kind === 'import') summary.reexports.push({ exported: 'default', imported: b.imported, source: b.source });
      } else {
        const inner = unwrapHoc(decl);
        if (inner) addExport('default', UNKNOWN('component'), fnId(inner));
        else addExport('default', evaluate(decl, root));
      }
    }
  }

  // ---------- re-exports of MaterialIcon itself (barrels, `export const Icon = MaterialIcon`): a pass-through wrapper
  const aliasNames = new Set<string>();
  for (const re of summary.reexports) {
    if (re.source !== LIBRARY) continue;
    if (re.imported === 'MaterialIcon') aliasNames.add(re.exported);
    if (re.imported === '*' && re.exported === '*') aliasNames.add('MaterialIcon');
  }
  for (const [exported, av] of Object.entries(summary.exports)) {
    if (av.k === 'import' && av.source === LIBRARY && av.imported === 'MaterialIcon' && av.path.length === 0) aliasNames.add(exported);
  }
  for (const exported of aliasNames) {
    const fn = `${file}#alias:${exported}`;
    const param = (prop: string): AV => ({ k: 'param', fn, prop, path: [] });
    summary.wrappers.push({ fn, exports: [exported], sites: [{ line: 1, target: { kind: 'lib' }, name: param('name'), variant: param('variant'), filled: param('filled') }] });
  }

  // ---------- wrappers
  for (const fn of localWrappers) {
    const sites = (sitesByFn.get(fn) ?? []).filter((s) => isWrapperSite(s, fn));
    for (const site of sites) site.inWrapper = fn;
    summary.wrappers.push({ fn, exports: exportedFns.get(fn) ?? [], sites });
  }

  summary.literals = [...literals].sort();
  return summary;
}

function isFunction(n: Node): boolean {
  return n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression';
}

/** memo(fn), forwardRef(fn), React.memo(forwardRef(fn)) → fn */
function unwrapHoc(n: Node): Node | null {
  if (isFunction(n)) return n;
  if (n.type !== 'CallExpression') return null;
  const callee = n.callee as Node;
  const name = callee.type === 'Identifier' ? callee.name : callee.type === 'MemberExpression' ? keyName(callee.property as Node) : null;
  if (name !== 'memo' && name !== 'forwardRef') return null;
  const arg = (n.arguments as Node[])[0];
  return arg ? unwrapHoc(arg) : null;
}

function isCreateElementTag(parent: Node, key: string, node: Node): boolean {
  if (parent.type !== 'CallExpression' || key !== 'arguments' || (parent.arguments as Node[])[0] !== node) return false;
  const callee = parent.callee as Node;
  return (callee.type === 'MemberExpression' && keyName(callee.property as Node) === 'createElement') || (callee.type === 'Identifier' && ['createElement', 'jsx', 'jsxs', '_jsx', '_jsxs'].includes(callee.name as string));
}

/** `const Icon = MaterialIcon` re-binds the tag; uses of Icon are traced through it */
function isAliasInit(parent: Node, key: string): boolean {
  return parent.type === 'VariableDeclarator' && key === 'init' && isNode(parent.id) && (parent.id as Node).type === 'Identifier';
}

function isDeclarationId(parent: Node, key: string): boolean {
  if (key === 'id' || key === 'params' || key === 'label') return true;
  if ((parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier' || parent.type === 'ImportNamespaceSpecifier') && (key === 'local' || key === 'imported')) return true;
  if ((parent.type === 'ExportSpecifier' && (key === 'local' || key === 'exported'))) return true;
  if ((parent.type === 'ObjectProperty' || parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') && key === (parent.type === 'ObjectProperty' ? 'key' : 'property') && !parent.computed) return true;
  if (parent.type === 'CallExpression' && key === 'arguments') return false;
  return false;
}

function mentionsParam(av: AV, fn: string, wholeProps = false): boolean {
  switch (av.k) {
    case 'param':
      // `props.name` or a destructured prop; a whole first parameter used as the value (`(name) => …`) is a helper,
      // not a component, and stays unresolved. A spread of the whole props object (`{...props}`) does forward props.
      return av.fn === fn && (av.prop !== null || wholeProps);
    case 'union':
      return av.of.some((v) => mentionsParam(v, fn, wholeProps));
    case 'obj':
      return Object.values(av.props).some((v) => mentionsParam(v, fn, wholeProps)) || (av.rest ? mentionsParam(av.rest, fn, wholeProps) : false);
    case 'arr':
      return av.items.some((v) => mentionsParam(v, fn, wholeProps));
    default:
      return false;
  }
}

/** finite strings an AV can be, or null if it may be anything */
export function strings(av: AV): string[] | null {
  switch (av.k) {
    case 'str':
      return av.v;
    case 'bool':
    case 'undef':
      return [];
    case 'union': {
      const out: string[] = [];
      for (const v of av.of) {
        const s = strings(v);
        if (!s) return null;
        out.push(...s);
      }
      return out;
    }
    case 'obj':
    case 'arr':
      return [];
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Project-level resolution

export type ShapeSet = Set<'d' | 'f'>;

export interface UsageResult {
  /** variant → name (as written; aliases not resolved) → shapes; variant '*' = every configured variant */
  uses: Map<string, Map<string, ShapeSet>>;
  diagnostics: Diagnostic[];
  /** files whose icon-shaped strings were included conservatively */
  fallbackFiles: string[];
  sites: number;
  wrappers: number;
  filesAnalyzed: number;
}

export interface AnalyzeOptions {
  /** files that mention the library module name (candidates for MaterialIcon imports) */
  markedFiles: string[];
  /** files with icon-name string literals and those names (from the literal scan) */
  byFile: Map<string, string[]>;
  nameSet: ReadonlySet<string>;
  /** finds files that contain any of the given identifiers (wrapper call sites); engine-backed */
  findFilesContaining: (tokens: string[]) => string[];
  readFile?: (file: string) => string;
  /** per-file summary cache; key must change when the analyzer changes */
  cache?: SummaryCache;
}

export interface SummaryCache {
  get(file: string, wrapperKey: string): FileSummary | undefined;
  set(file: string, wrapperKey: string, summary: FileSummary): void;
}

const MAX_ROUNDS = 8;

export function analyzeUsage(options: AnalyzeOptions): UsageResult {
  const readFile = options.readFile ?? ((f: string) => fs.readFileSync(f, 'utf8'));
  const summaries = new Map<string, FileSummary>();
  const diagnostics: Diagnostic[] = [];
  const fallbackFiles = new Set<string>();
  const uses = new Map<string, Map<string, ShapeSet>>();
  const literalFiles = [...options.byFile.keys()];
  let wrapperNames = new Set<string>();

  const summaryOf = (file: string): FileSummary | null => {
    const key = [...wrapperNames].sort().join(',');
    const cached = summaries.get(`${file}\0${key}`) ?? options.cache?.get(file, key);
    if (cached) {
      summaries.set(`${file}\0${key}`, cached);
      return cached;
    }
    let code: string;
    try {
      code = readFile(file);
    } catch {
      return null;
    }
    const s = summarizeFile(code, file, { wrapperNames });
    summaries.set(`${file}\0${key}`, s);
    options.cache?.set(file, key, s);
    return s;
  };

  // ---- resolve an import specifier to candidate files among the files we know (literal files and analyzed files)
  const knownFiles = () => [...new Set([...literalFiles, ...options.markedFiles])];
  const resolveSource = (fromFile: string, source: string): string[] => {
    if (source === LIBRARY) return [];
    const exts = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
    if (source.startsWith('.')) {
      const base = path.resolve(path.dirname(fromFile), source);
      const hit = exts.map((e) => base + e).find((f) => {
        try {
          return fs.statSync(f).isFile();
        } catch {
          return false;
        }
      });
      return hit ? [hit] : [];
    }
    // alias or package: match by trailing path (`@/shared/icons` → …/shared/icons(.ts|/index.ts))
    const rest = source.replace(/^(?:[@~#]\/|@[^/]+\/)/, '');
    const suffixes = [rest, `${rest}/index`];
    return knownFiles().filter((f) => {
      const noExt = f.replace(/\.[cm]?[jt]sx?$/, '');
      return suffixes.some((s) => noExt.endsWith(`/${s}`));
    });
  };

  const exportProviders = (name: string): string[] =>
    // a table of icon names has icon-shaped literals, so it is among the literal files
    literalFiles.filter((f) => {
      try {
        return readFile(f).includes(name);
      } catch {
        return false;
      }
    });

  // ---- resolve AVs to finite name sets (null = unresolved)
  type Ctx = { file: string; seen: Set<string> };
  const resolveImport = (av: Extract<AV, { k: 'import' }>, ctx: Ctx): AV => {
    const key = `${ctx.file}|${av.source}|${av.imported}`;
    if (ctx.seen.has(key)) return UNKNOWN('circular import');
    const seen = new Set(ctx.seen).add(key);
    const direct = resolveSource(ctx.file, av.source);
    const candidates = av.imported === 'default' || av.imported === '*' ? direct : [...new Set([...direct, ...(direct.length === 0 ? exportProviders(av.imported) : [])])];
    const found: AV[] = [];
    for (const f of candidates) {
      const s = summaryOf(f);
      if (!s) continue;
      if (av.imported === '*') {
        found.push({ k: 'obj', props: s.exports });
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(s.exports, av.imported)) {
        found.push(deepResolve(s.exports[av.imported], { file: f, seen }));
        continue;
      }
      for (const re of s.reexports) {
        if (re.exported === av.imported || re.exported === '*') {
          found.push(deepResolve({ k: 'import', source: re.source, imported: re.exported === '*' ? av.imported : re.imported, path: [] }, { file: f, seen }));
        }
      }
    }
    if (found.length === 0) return UNKNOWN(`could not find '${av.imported}' exported from '${av.source}'`);
    let out: AV = union(found);
    for (const step of av.path) out = member(out, step === '*' ? null : step);
    return out;
  };

  /** replace imports inside an AV with their resolved values */
  const deepResolve = (av: AV, ctx: Ctx): AV => {
    switch (av.k) {
      case 'import':
        return resolveImport(av, ctx);
      case 'union':
        return union(av.of.map((v) => deepResolve(v, ctx)));
      case 'obj':
        return { k: 'obj', props: Object.fromEntries(Object.entries(av.props).map(([k, v]) => [k, deepResolve(v, ctx)])), ...(av.rest ? { rest: deepResolve(av.rest, ctx) } : {}) };
      case 'arr':
        return { k: 'arr', items: av.items.map((v) => deepResolve(v, ctx)) };
      default:
        return av;
    }
  };

  // ---- conservative inclusion: literals of the file and of the files it imports
  const includeFallback = (file: string, variants: string[], shapes: ShapeSet, line: number, why: string) => {
    const s = summaryOf(file);
    const files = [file, ...(s ? s.imports.flatMap((i) => resolveSource(file, i.source)) : [])];
    for (const f of files) {
      const names = options.byFile.get(f) ?? (f === file && s ? s.literals.filter((l) => options.nameSet.has(l)) : []);
      if (names.length === 0) continue;
      fallbackFiles.add(f);
      for (const n of names) addUse(variants, n, shapes);
    }
    diagnostics.push({ file, line, message: `${why}; included the icon names written in this file and the files it imports. List the names in withMaterialSymbols({ include }) to make this exact.` });
  };

  const addUse = (variants: string[], name: string, shapes: ShapeSet) => {
    if (!options.nameSet.has(name)) return;
    for (const v of variants) {
      const byName = uses.get(v) ?? new Map<string, ShapeSet>();
      const set = byName.get(name) ?? new Set();
      for (const sh of shapes) set.add(sh);
      byName.set(name, set);
      uses.set(v, byName);
    }
  };

  const shapesOf = (av: AV | undefined): ShapeSet | null => {
    if (av === undefined) return new Set(['d']);
    const out: ShapeSet = new Set();
    const visit = (v: AV): boolean => {
      switch (v.k) {
        case 'bool':
          for (const b of v.v) out.add(b ? 'f' : 'd');
          return true;
        case 'undef':
          out.add('d');
          return true;
        case 'str':
          for (const s of v.v) out.add(s ? 'f' : 'd');
          return true;
        case 'union':
          return v.of.every(visit);
        default:
          return false;
      }
    };
    return visit(av) ? out : null;
  };

  const variantsOf = (av: AV | undefined): string[] | null => {
    if (av === undefined) return ['rounded'];
    const s = strings(av);
    if (!s) return null;
    const out = new Set<string>();
    if (s.length === 0 || containsUndef(av)) out.add('rounded');
    for (const v of s) out.add(v);
    return [...out];
  };

  // ---- one use: resolve name/variant/filled, with wrapper params bound to the call site's props
  type Bound = { name?: AV; variant?: AV; filled?: AV; spread?: AV; props?: Record<string, AV> };
  const bindParams = (av: AV | undefined, fn: string, args: Record<string, AV>, spread: AV | undefined): AV | undefined => {
    if (av === undefined) return undefined;
    const sub = (v: AV): AV => {
      switch (v.k) {
        case 'param': {
          if (v.fn !== fn) return v;
          if (v.prop === null) return v.path.length === 0 ? { k: 'obj', props: args, ...(spread ? { rest: spread } : {}) } : UNKNOWN('props object');
          let value: AV | undefined = Object.prototype.hasOwnProperty.call(args, v.prop) ? args[v.prop] : undefined;
          if (value === undefined && spread) value = member(spread, v.prop);
          if (value === undefined) value = v.dflt ?? UNDEF;
          else if (v.dflt && containsUndef(value)) value = union([value, v.dflt]);
          for (const step of v.path) value = member(value, step === '*' ? null : step);
          return value;
        }
        case 'union':
          return union(v.of.map(sub));
        case 'obj':
          return { k: 'obj', props: Object.fromEntries(Object.entries(v.props).map(([k, x]) => [k, sub(x)])), ...(v.rest ? { rest: sub(v.rest) } : {}) };
        case 'arr':
          return { k: 'arr', items: v.items.map(sub) };
        default:
          return v;
      }
    };
    return sub(av);
  };
  const bindSite = (inner: Site, fn: string, args: Record<string, AV>, spread: AV | undefined): Bound => ({
    name: bindParams(inner.name, fn, args, spread),
    variant: bindParams(inner.variant, fn, args, spread),
    filled: bindParams(inner.filled, fn, args, spread),
    spread: bindParams(inner.spread, fn, args, spread),
    ...(inner.props ? { props: Object.fromEntries(Object.entries(inner.props).map(([k, v]) => [k, bindParams(v, fn, args, spread) as AV])) } : {}),
  });

  const wrappersByExport = new Map<string, Array<{ file: string; def: WrapperDef }>>();
  const wrappersByFn = new Map<string, { file: string; def: WrapperDef }>();
  const callsByFn = new Map<string, number>();

  const useSite = (file: string, site: Site, bound: Bound, depth: number) => {
    const ctx: Ctx = { file, seen: new Set() };
    // attribute value: explicit, else from a spread, else absent
    const attr = (key: 'name' | 'variant' | 'filled'): AV | undefined => {
      const explicit = bound[key];
      if (explicit !== undefined) return explicit;
      if (bound.spread) return member(bound.spread, key);
      return undefined;
    };

    if (site.target.kind === 'wrapper') {
      // a call site of a wrapper: bind the wrapper's props to what this site passes, then evaluate its inner uses
      const ref = site.target.ref;
      const defs =
        ref.via === 'local'
          ? [wrappersByFn.get(ref.fn)].filter((x): x is { file: string; def: WrapperDef } => !!x)
          : (wrappersByExport.get(ref.imported === 'default' ? `default:${ref.source}` : ref.imported) ?? []);
      if (defs.length === 0) {
        includeFallback(file, ['*'], new Set(['d', 'f']), site.line, 'an icon wrapper could not be located');
        return;
      }
      const args = Object.fromEntries(Object.entries(bound.props ?? {}).map(([k, v]) => [k, deepResolve(v, ctx)]));
      const spread = bound.spread ? deepResolve(bound.spread, ctx) : undefined;
      for (const { file: wFile, def } of defs) {
        callsByFn.set(def.fn, (callsByFn.get(def.fn) ?? 0) + 1);
        if (depth > 6) {
          includeFallback(file, ['*'], new Set(['d', 'f']), site.line, 'icon wrappers nest too deeply');
          continue;
        }
        for (const inner of def.sites) useSite(wFile, inner, bindSite(inner, def.fn, args, spread), depth + 1);
      }
      return;
    }

    const nameAv = attr('name');
    const variantAv = attr('variant');
    const filledAv = attr('filled');
    const resolvedName = nameAv === undefined ? UNDEF : deepResolve(nameAv, ctx);
    const resolvedVariant = variantAv === undefined ? undefined : deepResolve(variantAv, ctx);
    const resolvedFilled = filledAv === undefined ? undefined : deepResolve(filledAv, ctx);
    const variantList = variantsOf(resolvedVariant);
    const shapeSet = shapesOf(resolvedFilled);
    if (variantList === null) diagnostics.push({ file, line: site.line, message: `variant could not be resolved (${why(resolvedVariant)}); every configured variant is included` });
    if (shapeSet === null) diagnostics.push({ file, line: site.line, message: `filled could not be resolved (${why(resolvedFilled)}); both shapes are included` });
    const variants = variantList ?? ['*'];
    const shapes = shapeSet ?? new Set<'d' | 'f'>(['d', 'f']);
    const names = strings(resolvedName);
    if (names === null) {
      includeFallback(file, variants, shapes, site.line, `name could not be resolved (${why(resolvedName)})`);
      return;
    }
    for (const n of names) addUse(variants, n, shapes);
  };

  // ---- rounds: analyze the files that import the library, then the call sites of the wrappers they define (and of
  // wrappers of wrappers) until no new wrapper name appears
  const register = (file: string, s: FileSummary, names: Set<string>) => {
    for (const w of s.wrappers) {
      const entry = { file, def: w };
      wrappersByFn.set(w.fn, entry);
      for (const e of w.exports) {
        const key = e === 'default' ? `default:${file}` : e;
        const list = wrappersByExport.get(key) ?? [];
        if (!list.some((x) => x.def.fn === w.fn)) list.push(entry);
        wrappersByExport.set(key, list);
        if (e !== 'default') names.add(e);
      }
    }
  };
  let files = new Set(options.markedFiles);
  const analyzed = new Set<string>();
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const next = new Set(wrapperNames);
    for (const file of files) {
      const s = summaryOf(file);
      if (!s) continue;
      analyzed.add(file);
      register(file, s, next);
    }
    // default-exported wrappers: their importers name the file in the import source
    for (const [key, list] of [...wrappersByExport]) {
      if (!key.startsWith('default:/')) continue;
      for (const { file } of list) {
        const base = path.basename(file).replace(/\.[cm]?[jt]sx?$/, '');
        const stem = base === 'index' ? path.basename(path.dirname(file)) : base;
        for (const f of options.findFilesContaining([stem])) {
          if (f === file) continue;
          const s = summaryOf(f);
          if (!s) continue;
          for (const imp of s.imports) {
            if (imp.imported === 'default' && resolveSource(f, imp.source).includes(file)) {
              const k = `default:${imp.source}`;
              if (!wrappersByExport.has(k)) wrappersByExport.set(k, list);
              next.add(k);
            }
          }
          files.add(f);
        }
      }
    }
    if (next.size === wrapperNames.size) break;
    wrapperNames = next;
    const tokens = [...wrapperNames].map((n) => (n.startsWith('default:') ? '' : n)).filter(Boolean);
    files = new Set([...analyzed, ...files, ...(tokens.length > 0 ? options.findFilesContaining(tokens) : [])]);
  }

  // final pass with the final wrapper set, so every call site is recorded
  let siteCount = 0;
  const finalSummaries: Array<[string, FileSummary]> = [];
  for (const file of new Set([...analyzed, ...files])) {
    const s = summaryOf(file);
    if (!s) continue;
    analyzed.add(file);
    register(file, s, new Set());
    finalSummaries.push([file, s]);
  }
  for (const [file, s] of finalSummaries) {
    diagnostics.push(...s.diagnostics);
    for (const site of s.sites) {
      // uses inside a wrapper that read its props are evaluated from the wrapper's call sites
      if (site.inWrapper) continue;
      siteCount += 1;
      useSite(file, site, { name: site.name, variant: site.variant, filled: site.filled, spread: site.spread, ...(site.props ? { props: site.props } : {}) }, 0);
    }
  }
  // a wrapper nobody calls in a traceable way: say so (an untraced call would otherwise render a blank icon)
  for (const [fn, { file, def }] of wrappersByFn) {
    if ((callsByFn.get(fn) ?? 0) > 0) continue;
    const label = def.exports.length > 0 ? def.exports.join(', ') : 'a local component';
    diagnostics.push({ file, line: def.sites[0]?.line ?? 0, message: `icon wrapper (${label}) has no call sites that could be traced; names it renders are not included unless listed in withMaterialSymbols({ include })` });
  }

  return {
    uses,
    diagnostics: dedupeDiagnostics(diagnostics),
    fallbackFiles: [...fallbackFiles].sort(),
    sites: siteCount,
    wrappers: wrappersByFn.size,
    filesAnalyzed: analyzed.size,
  };
}

function containsUndef(av: AV): boolean {
  if (av.k === 'undef') return true;
  if (av.k === 'union') return av.of.some(containsUndef);
  return false;
}

function why(av: AV | undefined): string {
  if (!av) return 'absent';
  if (av.k === 'unknown') return av.why;
  if (av.k === 'param') return `a prop '${av.prop ?? 'props'}' of a component that is not a recognized wrapper`;
  if (av.k === 'import') return `'${av.imported}' imported from '${av.source}'`;
  if (av.k === 'union') {
    const bad = av.of.find((v) => strings(v) === null);
    return bad ? why(bad) : 'mixed values';
  }
  return av.k;
}

function dedupeDiagnostics(list: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return list.filter((d) => {
    const key = `${d.file}:${d.line}:${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
