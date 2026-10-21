import * as React from 'react';
import Svg, { Path } from 'react-native-svg';
import registryModule from 'rn-material-symbols/registry';
import { VIEW_BOX } from './constants';
import { missingIconMessage } from './messages';
import type { IconData, MaterialIconProps, MaterialSymbolVariant, Registry } from './types';

const registry = registryModule as Registry;
const warned = new Set<string>();

/**
 * Dev only: how long a missing icon waits before warning. With `watch`, saving a file that adds an icon makes Metro push
 * that file first; the regenerated registry follows in a later HMR update (the watcher debounces 100 ms, then rescans).
 * The edited component renders once against the old registry in between, so the check runs again after this delay.
 */
export const MISSING_ICON_WARN_DELAY_MS = 2000;

/** The registry as it is now. HMR replaces the registry module's exports, while `registry` above keeps the old object. */
function latestRegistry(): Registry {
  try {
    return require('rn-material-symbols/registry') as Registry;
  } catch {
    return registry;
  }
}

function warnIfStillMissing(variant: MaterialSymbolVariant, name: string, key: string): void {
  const reg = latestRegistry();
  if (resolveIcon(reg, variant, name)) {
    // arrived with a registry update; a later genuine miss may warn again
    warned.delete(key);
    return;
  }
  console.warn(`[rn-material-symbols] ${missingIconMessage(reg, variant, name)}`);
}

const hasOwn = Object.prototype.hasOwnProperty;

/**
 * Never throws: a malformed registry, a non-string name or variant, or a key such as `constructor` resolves to
 * `undefined`, which renders an empty icon. Icon lookups are not own-property checks because the Jest registry's
 * variants are lazy Proxies; the result's shape is checked instead.
 */
export function resolveIcon(reg: Registry, variant: MaterialSymbolVariant, name: string): IconData | undefined {
  try {
    if (typeof name !== 'string' || typeof variant !== 'string' || !reg || typeof reg !== 'object') return undefined;
    const { aliases, icons } = reg;
    const alias = aliases && hasOwn.call(aliases, name) ? aliases[name] : undefined;
    const target = typeof alias === 'string' ? alias : name;
    const byVariant = icons && hasOwn.call(icons, variant) ? icons[variant] : undefined;
    const icon = byVariant ? byVariant[target as keyof typeof byVariant] : undefined;
    return icon && typeof icon === 'object' && typeof icon.d === 'string' ? icon : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A missing icon renders empty and is reported once per variant:name; reporting itself never throws.
 * Dev waits for a possible HMR registry update and warns. Release builds have no HMR, so they log console.error at once
 * (crash and RUM tools that collect console errors then see the miss).
 */
function reportMissing(variant: MaterialSymbolVariant, name: string): void {
  try {
    const key = `${String(variant)}:${String(name)}`;
    if (warned.has(key)) return;
    warned.add(key);
    if (__DEV__) {
      setTimeout(() => {
        try {
          warnIfStillMissing(variant, name, key);
        } catch {
          // reporting must never take the app down
        }
      }, MISSING_ICON_WARN_DELAY_MS);
    } else {
      console.error(`[rn-material-symbols] ${missingIconMessage(registry, variant, name)}`);
    }
  } catch {
    // reporting must never take the app down
  }
}

export function MaterialIcon({
  name,
  size = 24,
  color = 'black',
  filled = false,
  rotate = 0,
  variant = 'rounded',
  style,
  ...svgProps
}: MaterialIconProps) {
  const icon = resolveIcon(registry, variant, name);
  const mergedStyle = rotate ? [{ transform: [{ rotate: `${rotate}deg` }] }, style] : style;

  if (!icon) {
    reportMissing(variant, name);
    return <Svg {...svgProps} width={size} height={size} viewBox={VIEW_BOX} style={mergedStyle} />;
  }

  return (
    <Svg {...svgProps} width={size} height={size} viewBox={VIEW_BOX} style={mergedStyle}>
      <Path d={filled && icon.f ? icon.f : icon.d} fill={color} />
    </Svg>
  );
}
