import * as React from 'react';
import Svg, { Path } from 'react-native-svg';
import registryModule from 'rn-material-symbols/registry';
import { VIEW_BOX } from './constants';
import { missingIconMessage } from './messages';
import type { IconData, MaterialIconProps, MaterialSymbolVariant, Registry } from './types';

const registry = registryModule as Registry;
const warned = new Set<string>();

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
      console.warn(`[rn-material-symbols] ${missingIconMessage(registry, variant, name)}`);
    }
    return <Svg {...svgProps} width={size} height={size} viewBox={VIEW_BOX} style={mergedStyle} />;
  }

  return (
    <Svg {...svgProps} width={size} height={size} viewBox={VIEW_BOX} style={mergedStyle}>
      <Path d={filled && icon.f ? icon.f : icon.d} fill={color} />
    </Svg>
  );
}
