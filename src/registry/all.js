/** Node-only registry for Jest: loads any icon on demand. Never bundle this with Metro. */
const fs = require('fs');
const path = require('path');
const { MATERIAL_SYMBOL_ALIASES } = require('../generated/names');

const ICONS_DIR = path.resolve(__dirname, '..', '..', 'icons');
const NAME = /^[a-z0-9_]+$/;

function variantProxy(variant) {
  const cache = Object.create(null);
  return new Proxy(cache, {
    get(target, name) {
      if (typeof name !== 'string' || !NAME.test(name)) return undefined;
      if (!(name in target)) {
        const file = path.join(ICONS_DIR, variant, `${name}.js`);
        target[name] = fs.existsSync(file) ? require(file) : undefined;
      }
      return target[name];
    },
  });
}

module.exports = {
  mode: 'all',
  icons: { rounded: variantProxy('rounded'), outlined: variantProxy('outlined'), sharp: variantProxy('sharp') },
  aliases: { ...MATERIAL_SYMBOL_ALIASES },
};
