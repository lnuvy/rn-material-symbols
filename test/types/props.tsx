import * as React from 'react';
import { MaterialIcon } from '../../src';

export const ok = [
  <MaterialIcon key="1" name="info" />,
  <MaterialIcon key="2" name="info" size={16} color="#fff" filled rotate={90} variant="outlined" testID="x" />,
  <MaterialIcon key="3" name="access_time" />,
];

// @ts-expect-error unknown name
export const badName = <MaterialIcon name="not_an_icon" />;
// @ts-expect-error width is controlled by size
export const badWidth = <MaterialIcon name="info" width={10} />;
// @ts-expect-error fill is controlled by color
export const badFill = <MaterialIcon name="info" fill="red" />;
// @ts-expect-error unknown variant
export const badVariant = <MaterialIcon name="info" variant="two-tone" />;
