jest.mock('react-native-svg', () => {
  const React = require('react');
  const host = (name: string) => (props: Record<string, unknown>) => React.createElement(name, props, props.children);
  return { __esModule: true, default: host('Svg'), Svg: host('Svg'), Path: host('Path') };
});
