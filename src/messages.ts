import type { MaterialSymbolVariant, Registry } from './types';

export function missingIconMessage(registry: Registry, variant: MaterialSymbolVariant, name: string): string {
  if (!registry || typeof registry !== 'object' || !registry.icons) {
    return "the icon registry is malformed (rn-material-symbols/registry did not load as { mode, icons, aliases }); check the Metro setup.";
  }
  if (registry.mode === 'stub') {
    return 'withMaterialSymbols is not configured. Wrap your Metro config: ' +
      "module.exports = withMaterialSymbols(config) from 'rn-material-symbols/metro'.";
  }
  if (registry.mode === 'all') return `'${name}' is not a Material Symbols name.`;
  if (!registry.icons[variant]) {
    return `variant '${variant}' is not bundled. Add it to withMaterialSymbols({ variants: [...] }).`;
  }
  return (
    `'${name}' (${variant}) was not found as a string literal in your sources, or is not a Material Symbols name. ` +
    `If it comes from a server, add it to withMaterialSymbols({ include: ['${name}'] }).`
  );
}
