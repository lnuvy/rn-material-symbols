import { useState } from 'react';
import { View } from 'react-native';
import { MaterialIcon, type MaterialSymbolName } from 'rn-material-symbols';
import { TABS } from './src/tabs';

export default function App() {
  const [checked] = useState(true);
  const [open] = useState(false);
  const toggle = `${open ? 'expand_less' : 'expand_more'}` as MaterialSymbolName;
  return (
    <View>
      <MaterialIcon name="info" />
      <MaterialIcon name="home" filled />
      <MaterialIcon name={checked ? 'check_box' : 'check_box_outline_blank'} />
      <MaterialIcon name={toggle} />
      <MaterialIcon name={TABS[0].icon} />
      <MaterialIcon name="access_time" />
    </View>
  );
}
