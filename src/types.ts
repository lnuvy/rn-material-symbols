import type { ColorValue } from 'react-native';
import type { SvgProps } from 'react-native-svg';
import type { MaterialSymbolAlias, MaterialSymbolName } from './generated/names';

export type { MaterialSymbolAlias, MaterialSymbolName };

export type MaterialSymbolVariant = 'rounded' | 'outlined' | 'sharp';

export interface IconData {
  d: string;
  f?: string;
}

export interface Registry {
  mode: 'scanned' | 'stub' | 'all';
  icons: Partial<Record<MaterialSymbolVariant, Record<string, IconData>>>;
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
