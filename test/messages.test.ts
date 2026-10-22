import { missingIconMessage } from '../src/messages';
import type { Registry } from '../src/types';

const scanned: Registry = { mode: 'scanned', icons: { rounded: { info: { d: 'I' } } }, aliases: {} };

test('stub mode tells the user to configure Metro', () => {
  expect(missingIconMessage({ mode: 'stub', icons: {}, aliases: {} }, 'rounded', 'home')).toContain('withMaterialSymbols');
});

test('scanned mode suggests the include safelist', () => {
  expect(missingIconMessage(scanned, 'rounded', 'home')).toBe(
    "'home' (rounded) was not found in your sources, or is not a Material Symbols name. " +
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

test('scanned mode explains a shape that was not bundled', () => {
  expect(missingIconMessage(scanned, 'rounded', 'info', true)).toBe(
    "'info' (rounded) is bundled without its filled shape: no filled use of it was found in your sources. " +
      "If filled is decided at runtime, add it to withMaterialSymbols({ include: ['info'] }), which bundles both shapes.",
  );
});

test('a malformed registry gets its own message instead of throwing', () => {
  expect(missingIconMessage(undefined as never, 'rounded', 'info')).toContain('malformed');
  expect(missingIconMessage({} as never, 'rounded', 'info')).toContain('malformed');
});
