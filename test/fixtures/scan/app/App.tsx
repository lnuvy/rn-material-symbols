import { MENU } from './menu';
export const App = () => (
  <>
    <MaterialIcon name="info" />
    {MENU.map((m) => <MaterialIcon key={m.iconName} name={m.iconName} />)}
  </>
);
