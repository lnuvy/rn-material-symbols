import type { ColorValue } from 'react-native';
import type { SvgProps } from 'react-native-svg';
import type { MaterialSymbolAlias, MaterialSymbolName } from './generated/names';

export type { MaterialSymbolAlias, MaterialSymbolName };

export type MaterialSymbolVariant = 'rounded' | 'outlined' | 'sharp';

/** One icon in the package data (icons/<variant>.json): `f` is omitted when FILL 1 is the same path as FILL 0. */
export interface IconData {
  d: string;
  f?: string;
}

/**
 * One icon in a registry. The generated registry carries only the shapes the app renders (`d` FILL 0, `f` FILL 1);
 * the Jest registry carries both.
 */
export interface RegistryIcon {
  d?: string;
  f?: string;
}

export interface Registry {
  mode: 'scanned' | 'stub' | 'all';
  icons: Partial<Record<MaterialSymbolVariant, Record<string, RegistryIcon>>>;
  aliases: Record<string, string>;
}

export interface MaterialIconProps extends Omit<SvgProps, 'width' | 'height' | 'viewBox' | 'fill' | 'color' | 'children'> {
  name: MaterialSymbolName | MaterialSymbolAlias;
  /** px. Default 24 */
  size?: number;
  /** Default 'black' */
  color?: ColorValue;
  /** Material Symbols FILL axis. Default false */
  filled?: boolean;
  /** degrees, same as the web MaterialIcon `rotate`. `style.transform` wins when both are given */
  rotate?: number;
  /** Default 'rounded'. Must be listed in withMaterialSymbols({ variants }) */
  variant?: MaterialSymbolVariant;
}
