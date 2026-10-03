const path = require('path');

/** Spread into your Jest config: moduleNameMapper: { ...require('rn-material-symbols/jest').moduleNameMapper } */
module.exports = {
  moduleNameMapper: {
    '^rn-material-symbols/registry$': path.join(__dirname, 'lib', 'registry', 'all.js'),
  },
};
