import React, { useState } from 'react';
import { Pressable, SafeAreaView, Text, View } from 'react-native';
import { MaterialIcon, type MaterialSymbolName } from 'rn-material-symbols';
import { MENU } from './src/menu';

export default function App() {
  const [on, setOn] = useState(false);
  const fromServer = 'cloud_download' as MaterialSymbolName; // simulates an API value (safelisted)
  return (
    <SafeAreaView>
      <View style={{ flexDirection: 'row', gap: 12, padding: 16 }}>
        <MaterialIcon name="info" size={32} />
        <MaterialIcon name="info" size={32} filled color="#1C7ED6" />
        <MaterialIcon name="chevron_right" size={32} rotate={90} />
        <MaterialIcon name="access_time" size={32} />
        <MaterialIcon name={fromServer} size={32} />
        <Pressable onPress={() => setOn((v) => !v)} testID="toggle">
          <MaterialIcon name={on ? 'check_box' : 'check_box_outline_blank'} size={32} />
        </Pressable>
      </View>
      {MENU.map((m) => (
        <View key={m.iconName} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16 }}>
          <MaterialIcon name={m.iconName} size={24} />
          <Text>{m.label}</Text>
        </View>
      ))}
    </SafeAreaView>
  );
}
