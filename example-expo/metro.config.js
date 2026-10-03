const { getDefaultConfig } = require('expo/metro-config');
const { withMaterialSymbols } = require('rn-material-symbols/metro');
module.exports = withMaterialSymbols(getDefaultConfig(__dirname), { include: ['cloud_download'] });
