export type Variant = 'rounded' | 'outlined' | 'sharp';
export const VARIANTS: readonly Variant[] = ['rounded', 'outlined', 'sharp'];

export interface IconData {
  d: string;
  f?: string;
}

type ByVariant = Record<Variant, Record<string, IconData>>;

const keyOf = (icon: IconData) => `${icon.d}\n${icon.f ?? ''}`;

export function buildAliases(symbols: ByVariant, legacy: ByVariant): { aliases: Record<string, string>; standalone: ByVariant } {
  const index = Object.fromEntries(
    VARIANTS.map((variant) => {
      const map = new Map<string, string>();
      for (const name of Object.keys(symbols[variant]).sort()) {
        const k = keyOf(symbols[variant][name]);
        if (!map.has(k)) map.set(k, name);
      }
      return [variant, map];
    }),
  ) as Record<Variant, Map<string, string>>;

  const aliases: Record<string, string> = {};
  const standalone: ByVariant = { rounded: {}, outlined: {}, sharp: {} };
  const legacyNames = new Set(VARIANTS.flatMap((variant) => Object.keys(legacy[variant])));

  for (const name of [...legacyNames].sort()) {
    if (VARIANTS.some((variant) => name in symbols[variant])) continue;
    const targets = VARIANTS.map((variant) => {
      const icon = legacy[variant][name];
      return icon ? index[variant].get(keyOf(icon)) : undefined;
    });
    const first = targets[0];
    if (first && targets.every((t) => t === first)) {
      aliases[name] = first;
    } else {
      for (const variant of VARIANTS) {
        const icon = legacy[variant][name];
        if (icon) standalone[variant][name] = icon;
      }
    }
  }
  return { aliases, standalone };
}
