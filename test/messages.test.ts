import { missingIconMessage } from '../src/messages';
import type { Registry } from '../src/types';

const scanned: Registry = { mode: 'scanned', icons: { rounded: { info: { d: 'I' } } }, aliases: {} };

test('stub mode tells the user to configure Metro', () => {
  expect(missingIconMessage({ mode: 'stub', icons: {}, aliases: {} }, 'rounded', 'home')).toContain('withMaterialSymbols');
});

test('scanned mode suggests the include safelist', () => {
  expect(missingIconMessage(scanned, 'rounded', 'home')).toBe(
    "'home' (rounded) was not found as a string literal in your sources, or is not a Material Symbols name. " +
      "If it comes from a server, add it to withMaterialSymbols({ include: ['home'] }).",
  );
});

test('scanned mode reports a variant that is not configured', () => {
  expect(missingIconMessage(scanned, 'sharp', 'info')).toBe(
    "variant 'sharp' is not bundled. Add it to withMaterialSymbols({ variants: [...] }).",
  );
});

test('all mode means the name does not exist', () => {
  expect(missingIconMessage({ mode: 'all', icons: {}, aliases: {} }, 'rounded', 'nope')).toBe("'nope' is not a Material Symbols name.");
});
