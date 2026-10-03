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

export function resolveIcon(reg: Registry, variant: MaterialSymbolVariant, name: string): IconData | undefined {
  const target = reg.aliases[name] ?? name;
  return reg.icons[variant]?.[target];
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
    const key = `${variant}:${name}`;
    if (__DEV__ && !warned.has(key)) {
      warned.add(key);
      setTimeout(() => warnIfStillMissing(variant, name, key), MISSING_ICON_WARN_DELAY_MS);
    }
    return <Svg {...svgProps} width={size} height={size} viewBox={VIEW_BOX} style={mergedStyle} />;
  }

  return (
    <Svg {...svgProps} width={size} height={size} viewBox={VIEW_BOX} style={mergedStyle}>
      <Path d={filled && icon.f ? icon.f : icon.d} fill={color} />
    </Svg>
  );
}
