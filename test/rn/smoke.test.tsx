import { render, screen } from '@testing-library/react-native';
import { View } from 'react-native';

test('jest rn project runs', () => {
  render(<View testID="smoke" />);
  expect(screen.getByTestId('smoke')).toBeTruthy();
});
