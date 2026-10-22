/** Node-only registry for Jest: every icon in both shapes, read from icons/<variant>.json on first use. Never bundle this with Metro. */
const fs = require('fs');
const path = require('path');
const { MATERIAL_SYMBOL_ALIASES } = require('../generated/names');

const ICONS_DIR = path.resolve(__dirname, '..', '..', 'icons');
const NAME = /^[a-z0-9_]+$/;
const hasOwn = Object.prototype.hasOwnProperty;

function variantProxy(variant) {
  let data = null;
  const cache = Object.create(null);
  return new Proxy(cache, {
    get(target, name) {
      if (typeof name !== 'string' || !NAME.test(name)) return undefined;
      if (!(name in target)) {
        if (data === null) data = JSON.parse(fs.readFileSync(path.join(ICONS_DIR, `${variant}.json`), 'utf8'));
        const icon = hasOwn.call(data, name) ? data[name] : undefined;
        // the data omits f when FILL 1 equals FILL 0; the registry contract carries both shapes explicitly
        target[name] = icon ? { d: icon.d, f: icon.f === undefined ? icon.d : icon.f } : undefined;
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
