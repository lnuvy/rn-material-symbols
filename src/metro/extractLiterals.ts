import { parse, type ParserPlugin } from '@babel/parser';

export const ICON_SHAPED = /^[a-z0-9_]+$/;
const REGEX_FALLBACK = /(['"`])([a-z0-9_]+)\1/g;

const TYPE_ONLY_NODES = new Set([
  'TSTypeAliasDeclaration',
  'TSInterfaceDeclaration',
  'TSDeclareFunction',
  'TSLiteralType',
  'TSImportType',
  'TSTypeAnnotation',
  'TSTypeParameterInstantiation',
  'TSTypeParameterDeclaration',
  'TSExpressionWithTypeArguments',
  'TSInterfaceHeritage',
  'TSClassImplements',
]);
const TYPE_KEYS = new Set(['typeAnnotation', 'typeParameters', 'typeArguments', 'returnType', 'superTypeParameters', 'implements']);
const SKIP_KEYS = new Set(['loc', 'start', 'end', 'extra', 'range', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'tokens', 'directives']);
const MODULE_NODES = new Set(['ImportDeclaration', 'ExportAllDeclaration']);

function pluginsFor(filename: string): ParserPlugin[] {
  if (/\.tsx$/.test(filename)) return ['typescript', 'jsx'];
  if (/\.[cm]?ts$/.test(filename)) return ['typescript'];
  return ['jsx', 'flow'];
}

function regexLiterals(code: string): Set<string> {
  const out = new Set<string>();
  for (const m of code.matchAll(REGEX_FALLBACK)) out.add(m[2]);
  return out;
}

type AnyNode = { type?: string; [key: string]: unknown };

export function extractLiterals(code: string, filename: string): { literals: Set<string>; parsed: boolean } {
  if (/\.d\.[cm]?ts$/.test(filename)) return { literals: new Set(), parsed: true };

  let program: AnyNode;
  try {
    const ast = parse(code, { sourceType: 'unambiguous', errorRecovery: true, plugins: pluginsFor(filename) });
    if (ast.errors && ast.errors.length > 0) return { literals: regexLiterals(code), parsed: false };
    program = ast.program as unknown as AnyNode;
  } catch {
    return { literals: regexLiterals(code), parsed: false };
  }

  const literals = new Set<string>();
  const stack: unknown[] = [program];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    if (Array.isArray(current)) {
      for (const child of current) stack.push(child);
      continue;
    }
    const node = current as AnyNode;
    const type = node.type;
    if (type && (TYPE_ONLY_NODES.has(type) || MODULE_NODES.has(type))) continue;
    if (type === 'StringLiteral') {
      const value = node.value as string;
      if (ICON_SHAPED.test(value)) literals.add(value);
      continue;
    }
    if (type === 'TemplateLiteral') {
      const expressions = node.expressions as unknown[];
      const quasis = node.quasis as Array<{ value: { cooked: string | null } }>;
      const cooked = quasis[0]?.value.cooked;
      if (expressions.length === 0) {
        if (cooked && ICON_SHAPED.test(cooked)) literals.add(cooked);
      } else {
        for (const expression of expressions) stack.push(expression);
      }
      continue;
    }
    for (const key of Object.keys(node)) {
      if (SKIP_KEYS.has(key) || TYPE_KEYS.has(key)) continue;
      if (key === 'source' && type === 'ExportNamedDeclaration') continue;
      const value = node[key];
      if (value && typeof value === 'object') stack.push(value);
    }
  }
  return { literals, parsed: true };
}
